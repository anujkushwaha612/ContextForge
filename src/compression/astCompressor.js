import { createRequire } from "module";
import { saveToVault, lookupVaultByContent, fetchFromVault } from "../logging/cacheDb.js";
import { isRecentToolResult } from "./compressionPolicy.js";

const require = createRequire(import.meta.url);

const EXT_TO_LANG = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
};

// ─────────────────────────────────────────────
// Load native ASTCompressor
// ─────────────────────────────────────────────

let NativeASTCompressor = null;
let nativeAvailable = false;

try {
  const native = require("../../native/build/Release/contextforge_native.node");
  NativeASTCompressor = native.ASTCompressor;
  nativeAvailable = true;
  console.log("[AST Compressor] ✅ Native tree-sitter engine loaded");
} catch (err) {
  console.warn(
    `[AST Compressor] ⚠️  Native engine unavailable (${err.message}). ` +
      `Run: bash scripts/vendor-grammars.sh && cd native && node-gyp rebuild`
  );
}

// ─────────────────────────────────────────────
// Compressor instance cache
// ─────────────────────────────────────────────

const _compressorCache = new Map();

function getPolicyFingerprint(policy) {
  if (!policy) return "default";
  return `${policy.maxBodyLines ?? 4}|${policy.preserveErrorHandlers ?? true}|${policy.mode ?? "balanced"}`;
}

function getCompressor(policy = null) {
  if (!nativeAvailable) return null;

  const key = getPolicyFingerprint(policy);

  if (!_compressorCache.has(key)) {
    const opts = {
      preserveImports: true,
      preserveSignatures: true,
      preserveTypeAnnotations: true,
      preserveDecorators: true,
      vaultOnCompress: true,
      docstringMode: 1,
      preserveErrorHandlers: policy?.preserveErrorHandlers ?? true,
      maxBodyLines: policy?.maxBodyLines ?? 4,
      minTokensToCompress: policy?.minTokensToCompress ?? 80,
    };

    _compressorCache.set(key, new NativeASTCompressor(opts));
    console.log(`[AST Compressor] Created compressor instance [${key}]`);
  }

  return _compressorCache.get(key);
}

// ─────────────────────────────────────────────
// Session compression cache
//
// BUG-7 FIX: Cache compression results by content hash within the session.
// Without this, the same file gets passed through tree-sitter on every turn
// it appears — even if the content hasn't changed. In a 15-turn agentic
// session where the LLM reads the same controller file 8 times, tree-sitter
// ran 8 times. Now it runs once.
//
// Cache is keyed by FNV-1a hash of the content (same implementation as
// fixed fnv1a64 in semanticDedup.js — two independent lanes, all chars).
// Cleared if content changes (different hash = different cache entry).
// ─────────────────────────────────────────────

const SESSION_COMPRESS_CACHE = new Map();
const SESSION_COMPRESS_MAX = 50;

function quickHash(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x4b9ace2f;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}_${h2.toString(16).padStart(8, "0")}`;
}

// ─────────────────────────────────────────────
// compressCodeOutput
// ─────────────────────────────────────────────

export function compressCodeOutput(text, languageHint = "", policy = null, filePath = null) {
  if (policy?.intent === "PATCH") {
    return { kept: text, vaulted: false };
  }

  if (typeof text !== "string" || text.length < 800) {
    return { kept: text, vaulted: false };
  }

  const lineCount = text.split("\n").length;
  console.log(
    `[AST Compressor] 🔍 Analyzing ${lineCount} line file` +
      (languageHint ? ` (${languageHint})` : " (auto-detect)") +
      (policy ? ` [mode=${policy.mode}]` : "")
  );

  const compressor = getCompressor(policy);
  if (compressor) {
    try {
      const result = compressor.compress(text, languageHint);

      if (languageHint && result.languageDetected !== languageHint) {
        console.warn(
          `[AST Compressor] ⚠️  Language mismatch: extension says ${languageHint}, ` +
            `auto-detected ${result.languageDetected} — trusting extension hint`
        );
        // BUG-9 FIX: Retry with languageHint, not "" (empty = re-run same
        // failing auto-detect). The intent is to FORCE the extension-based
        // language when auto-detect produced zero nodes.
        if (result.nodesCompressed === 0 && languageHint) {
          const retryResult = compressor.compress(text, languageHint);
          if (retryResult.nodesCompressed > result.nodesCompressed) {
            Object.assign(result, retryResult);
          }
        }
      }

      console.log(
        `[AST Compressor] Lang: ${result.languageDetected} | ` +
          `Nodes: ${result.nodesFound} found, ${result.nodesCompressed} compressed | ` +
          `Lines: ${result.originalLines} → ${result.compressedLines} ` +
          `(${(result.compressionRatio * 100).toFixed(1)}%)`
      );

      if (result.highComplexityNodes && result.highComplexityNodes.length > 0) {
        console.log(
          `[AST Compressor] ⚠️  High-complexity functions detected:`,
          result.highComplexityNodes.map((n) => `${n.name}(cc=${n.complexity})`).join(", ")
        );
      }

      const reductionRatio = result.compressionRatio;
      if (reductionRatio < 0.2 || result.nodesCompressed === 0) {
        console.log(
          `[AST Compressor] ⏭️  Insufficient reduction ` +
            `(${(reductionRatio * 100).toFixed(1)}% < 20% or no bodies compressed)`
        );
        return { kept: text, vaulted: false };
      }

      const vaultId = saveToVault(text);

      const keptWithVaultId = result.compressedSource.replace(
        /· vault_retrieve to expand/g,
        `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`
      );

      const fileRef = filePath ? filePath.replace(/\\/g, "/") : "this file";

      const compressionHeader = [
        `[CF_COMPRESSED_FILE vault_id:"${vaultId}"]`,
        `⚠️  This is an AST skeleton — ${result.originalLines} lines compressed to ${result.compressedLines}.`,
        `To read the full source: use tool call contextforge_retrieve with vault_id="${vaultId}".`,
        `To explore without reading the full file:`,
        `  - what_does_this_export("${fileRef}") — list all exports`,
        `  - find_symbol("functionName") — get a specific function body directly`,
        `  Search for function names, NOT class names.`,
        ``,
      ].join("\n");

      const finalKept = compressionHeader + keptWithVaultId;

      console.log(
        `[AST Compressor] ✅ Compressed: ${result.originalLines} → ` +
          `${result.compressedLines} lines ` +
          `(${(reductionRatio * 100).toFixed(0)}% reduction) → Vault ${vaultId}`
      );

      return {
        kept: finalKept,
        vaulted: true,
        vaultId,
        originalText: text,
        removedChars: text.length - finalKept.length,
        originalLines: result.originalLines,
        compressedLines: result.compressedLines,
        language: result.languageDetected,
        nodesFound: result.nodesFound,
        nodesCompressed: result.nodesCompressed,
        syntaxValid: result.syntaxValid,
        highComplexityNodes: result.highComplexityNodes || [],
      };
    } catch (err) {
      console.error(`[AST Compressor] ❌ Native error: ${err.message}`);
    }
  }

  console.warn("[AST Compressor] Using regex fallback — build native for best results");
  return regexFallbackCompress(text);
}

// BUG-8 FIX: Two setImmediate yields for large files to give the event loop
// a chance to process pending I/O between chunks of CPU work.
// The native tree-sitter call inside compressCodeOutput is synchronous C++.
// A single setImmediate yields once but the blocking call still runs
// uninterrupted after that yield. Two yields provide two scheduling
// opportunities — before and during processing of large files.
//
// PROPER FIX NOTE: Move native calls to the embeddingWorker thread.
// The infrastructure already exists in server.js. This two-yield approach
// is a band-aid for single-threaded operation.
async function compressCodeOutputAsync(text, languageHint = "", policy = null, filePath = null) {
  // First yield — let pending I/O flush before starting
  await new Promise((r) => setImmediate(r));

  // Second yield for large files — additional scheduling opportunity
  if (text.length > 50_000) {
    await new Promise((r) => setImmediate(r));
  }

  return compressCodeOutput(text, languageHint, policy, filePath);
}

// ─────────────────────────────────────────────
// Regex fallback
// ─────────────────────────────────────────────

const IMPORT_PATTERN =
  /^(import\s+[\s\S]*?from\s+['"][^'"]+['"]|const\s+\w+\s*=\s*require\s*\(.*\)|require\s*\(.*\))/gm;
const EXPORT_PATTERN =
  /^export\s+(default\s+)?(class|function|const|let|var|async\s+function|interface|type|enum)\s+\w+/gm;
const FUNCTION_SIGNATURE =
  /^(?:\/\*\*[\s\S]*?\*\/\s*)*\s*(?:(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*(?::\s*\w+)?(?:\s*\{)?)/gm;
const CLASS_PATTERN = /^(?:\/\*\*[\s\S]*?\*\/\s*)*\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/gm;

function regexFallbackCompress(text) {
  const lines = text.split(/\r?\n/);
  const linesToKeep = new Set();

  const patterns = [IMPORT_PATTERN, EXPORT_PATTERN, FUNCTION_SIGNATURE, CLASS_PATTERN];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const startIdx = match.index;
      let c = 0;
      for (let i = 0; i < lines.length; i++) {
        if (c + lines[i].length + 1 > startIdx && c <= startIdx) {
          linesToKeep.add(i);
        }
        c += lines[i].length + 1;
      }
    }
  }

  const keepRatio = linesToKeep.size / lines.length;
  if (keepRatio > 0.6 || linesToKeep.size < 3) {
    return { kept: text, vaulted: false };
  }

  const resultLines = [];
  let braceDepth = 0;
  let inVaultedBody = false;
  let vaultedBodyStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (linesToKeep.has(i)) {
      if (inVaultedBody) {
        resultLines.push(`  // ... ${i - vaultedBodyStart} lines compressed`);
        inVaultedBody = false;
      }
      resultLines.push(line);
    } else {
      if (!inVaultedBody && braceDepth > 0) {
        inVaultedBody = true;
        vaultedBodyStart = i;
      } else if (!inVaultedBody) {
        if (resultLines.length > 0 && resultLines[resultLines.length - 1].trim() !== "") {
          resultLines.push("");
        }
      }
    }

    braceDepth = Math.max(0, braceDepth + opens - closes);
  }

  const keptText = resultLines.join("\n").replace(/\n{3,}/g, "\n\n");
  const removedChars = text.length - keptText.length;

  if (removedChars < text.length * 0.2) {
    return { kept: text, vaulted: false };
  }

  const vaultId = saveToVault(text);

  const fallbackStub =
    `[CF_VAULT:${vaultId}] ${Math.round(text.length / 4)} tokens compressed. ` +
    `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`;

  return {
    kept: fallbackStub + "\n\n" + keptText,
    vaulted: true,
    vaultId,
    originalText: text,
    removedChars,
    originalLines: lines.length,
  };
}

// ─────────────────────────────────────────────
// compressCodeToolResults — policy-aware
// ─────────────────────────────────────────────

export async function compressCodeToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  const policy = payload.__policy ?? null;

  // F1a: policy master switch — under LOW pressure with a local upstream,
  // compressing tool results costs retrieve round-trips and saves nothing.
  if (policy && policy.compressToolResults === false) {
    return payload;
  }

  const codeMessages = payload.messages.filter(
    (m) => m.role === "tool" && m._cf_type === "code"
  ).length;

  if (codeMessages > 0) {
    console.log(
      `[AST Compressor] Processing ${codeMessages} code-tagged tool result(s)` +
        (policy ? ` [mode=${policy.mode}]` : "")
    );
  }

  const stats = {
    compressed: 0,
    charsSaved: 0,
    vaults: 0,
    totalNodes: 0,
    highComplexityFunctions: [],
  };

  const newMessages = [];

  for (let msgIndex = 0; msgIndex < payload.messages.length; msgIndex++) {
    const msg = payload.messages[msgIndex];
    if (msg.role === "tool" && typeof msg.content === "string" && msg._cf_type === "code") {
      // ── Skip guards (ordered by cheapness) ───────────────────────────────
      // F1b: AGE GATE — never compress a tool result the model hasn't had
      // time to act on (fewer than policy.recentTurnExemption assistant
      // turns after it). Compressing fresh reads forces an immediate
      // contextforge_retrieve round-trip: the self-defeating loop observed
      // in the S3-refactor session (read → stub → retrieve → dedup → re-read).
      if (isRecentToolResult(payload.messages, msgIndex, policy)) {
        newMessages.push(msg);
        continue;
      }
      if (msg._cf_editable === true) {
        newMessages.push(msg);
        continue;
      }
      if (msg._compressedVaultId) {
        newMessages.push(msg);
        continue;
      }
      if (msg._dedupVaultId || msg.content.includes("[CF_VAULT:")) {
        newMessages.push(msg);
        continue;
      }
      if (msg._cf_deduped || msg.__cf_raw) {
        newMessages.push(msg);
        continue;
      }

      // BUG-10 FIX: Vault pre-check BEFORE line count guard.
      // Short files that were previously compressed (e.g. a 25-line utility
      // read multiple times) benefit from the O(1) vault lookup.
      // Previously the line count guard fired first and skipped the lookup.
      // In compressCodeToolResults, replace the lookupVaultByContent block:
      const existingVaultId = lookupVaultByContent(msg.content);
      if (existingVaultId) {
        // ✅ Issue 1 FIX: Verify vault still exists before embedding its ID
        // in a stub. The prune_vault row persists across server restarts but
        // the session registry resets — a stub could reference a vault whose
        // row was wiped by fullReset() or a DB migration.
        const vaultStillExists = fetchFromVault(existingVaultId) !== null;
        if (vaultStillExists) {
          const fileRef = (msg._filename ?? "this file").replace(/\\/g, "/");
          const stub =
            `[CF_COMPRESSED_FILE vault_id:"${existingVaultId}"]\n` +
            `⚠️  Previously compressed — content unchanged from prior turn.\n` +
            `To read the full source: use tool call contextforge_retrieve with vault_id="${existingVaultId}".\n` +
            `To explore without reading the full file:\n` +
            `  - what_does_this_export("${fileRef}") — list all exports\n` +
            `  - find_symbol("functionName") — get a specific function body directly\n`;

          newMessages.push({
            ...msg,
            content: stub,
            _compressedVaultId: existingVaultId,
          });
          stats.compressed++;
          stats.vaults++;
          stats.charsSaved += msg.content.length - stub.length;
          continue;
        }
        // Vault gone — fall through to re-compress fresh
        console.log(`[AST Compressor] ⚠️ Vault ${existingVaultId} missing — re-compressing`);
      }

      // BUG-7 FIX: Session compression cache — skip tree-sitter if we've
      // already compressed this exact content this session.
      const contentHash = quickHash(msg.content);
      const cachedCompression = SESSION_COMPRESS_CACHE.get(contentHash);
      if (cachedCompression) {
        newMessages.push({ ...msg, ...cachedCompression });
        stats.compressed++;
        stats.vaults++;
        stats.charsSaved += msg.content.length - cachedCompression.content.length;
        continue;
      }

      // Line count guard — after vault checks, before tree-sitter.
      // Threshold now policy-driven (LOW pressure → 120 lines, HIGH → 30):
      // compressing a 35-line file saves ~20 lines but costs a retrieve
      // round-trip if the model needs the bodies back.
      const minLines = policy?.minLinesToCompress ?? 30;
      if (msg.content.split("\n").length < minLines) {
        newMessages.push(msg);
        continue;
      }

      const beforeLen = msg.content.length;
      const langHint = msg._filename
        ? (EXT_TO_LANG[msg._filename.split(".").pop()?.toLowerCase()] ?? "")
        : "";

      const result = await compressCodeOutputAsync(
        msg.content,
        langHint,
        policy,
        msg._filename || null
      );

      if (result.vaulted) {
        stats.compressed++;
        stats.charsSaved += beforeLen - result.kept.length;
        stats.vaults++;
        if (result.nodesCompressed) stats.totalNodes += result.nodesCompressed;
        if (result.highComplexityNodes) {
          stats.highComplexityFunctions.push(...result.highComplexityNodes);
        }

        const compressedMsg = {
          ...msg,
          content: result.kept,
          _compressedVaultId: result.vaultId,
          _astLanguage: result.language,
          _syntaxValid: result.syntaxValid,
        };

        // BUG-7 FIX: Store in session cache for subsequent turns
        if (SESSION_COMPRESS_CACHE.size >= SESSION_COMPRESS_MAX) {
          SESSION_COMPRESS_CACHE.delete(SESSION_COMPRESS_CACHE.keys().next().value);
        }
        SESSION_COMPRESS_CACHE.set(contentHash, {
          content: result.kept,
          _compressedVaultId: result.vaultId,
          _astLanguage: result.language,
          _syntaxValid: result.syntaxValid,
        });

        newMessages.push(compressedMsg);
        continue;
      }

      newMessages.push(msg);
      continue;
    }

    newMessages.push(msg);
  }

  payload.messages = newMessages;

  if (stats.compressed > 0) {
    console.log(
      `[AST Compressor Summary] Compressed ${stats.compressed} files | ` +
        `Chars saved: ${stats.charsSaved} (~${Math.floor(stats.charsSaved / 4)} tokens) | ` +
        `Vaults: ${stats.vaults}`
    );

    if (stats.highComplexityFunctions.length > 0) {
      console.log(
        `[AST Compressor] 🧠 High-complexity functions in session: ` +
          stats.highComplexityFunctions
            .sort((a, b) => b.complexity - a.complexity)
            .slice(0, 5)
            .map((n) => `${n.name}(cc=${n.complexity})`)
            .join(", ")
      );
    }
  }

  return payload;
}
