import { createRequire } from "module";
import { saveToVault } from "../logging/cacheDb.js";

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
// Load native ASTCompressor — fallback to
// regex stub if native isn't built yet
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
      `Run: bash scripts/vendor-grammars.sh && cd native && node-gyp rebuild`,
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
      docstringMode: 1, // FIRST_LINE

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
// compressCodeOutput
// ─────────────────────────────────────────────

/**
 * @param {string}      text          — source text to compress
 * @param {string}      languageHint  — file extension language hint
 * @param {object|null} policy        — compression policy from compressionPolicy.js
 * @param {string|null} filePath      — original file path, used in compression header
 *                                      to guide the LLM toward graph queries
 */
export function compressCodeOutput(
  text,
  languageHint = "",
  policy = null,
  filePath = null,
) {
  // NEW: If the current request intent is PATCH, never compress
  if (policy?.intent === "PATCH") {
    return { kept: text, vaulted: false };
  }

  // FIX F3: Raise threshold to ~200 tokens to avoid inflating tiny files
  if (typeof text !== "string" || text.length < 800) {
    return { kept: text, vaulted: false };
  }

  const lineCount = text.split("\n").length;
  console.log(
    `[AST Compressor] 🔍 Analyzing ${lineCount} line file` +
      (languageHint ? ` (${languageHint})` : " (auto-detect)") +
      (policy ? ` [mode=${policy.mode}]` : ""),
  );

  // ── Path A: Native tree-sitter ──
  const compressor = getCompressor(policy);
  if (compressor) {
    try {
      const result = compressor.compress(text, languageHint);

      // Sanity check: if auto-detect contradicts extension hint, log it
      if (languageHint && result.languageDetected !== languageHint) {
        console.warn(
          `[AST Compressor] ⚠️  Language mismatch: extension says ${languageHint}, ` +
            `auto-detected ${result.languageDetected} — trusting extension hint`,
        );
        // Re-compress with forced language if auto-detect produced 0 nodes
        // but we know the language from the file extension
        if (result.nodesCompressed === 0 && languageHint) {
          const retryResult = compressor.compress(text, "");
          if (retryResult.nodesCompressed > result.nodesCompressed) {
            Object.assign(result, retryResult);
          }
        }
      }

      console.log(
        `[AST Compressor] Lang: ${result.languageDetected} | ` +
          `Nodes: ${result.nodesFound} found, ${result.nodesCompressed} compressed | ` +
          `Lines: ${result.originalLines} → ${result.compressedLines} ` +
          `(${(result.compressionRatio * 100).toFixed(1)}%)`,
      );

      if (result.highComplexityNodes && result.highComplexityNodes.length > 0) {
        console.log(
          `[AST Compressor] ⚠️  High-complexity functions detected:`,
          result.highComplexityNodes
            .map((n) => `${n.name}(cc=${n.complexity})`)
            .join(", "),
        );
      }

      const reductionRatio = result.compressionRatio;
      if (reductionRatio < 0.2 || result.nodesCompressed === 0) {
        console.log(
          `[AST Compressor] ⏭️  Insufficient reduction ` +
            `(${(reductionRatio * 100).toFixed(1)}% < 20% or no bodies compressed)`,
        );
        return { kept: text, vaulted: false };
      }

      const vaultId = saveToVault(text);

      // ── Inject vault ID into every compressed marker ──
      const keptWithVaultId = result.compressedSource.replace(
        /· vault_retrieve to expand/g,
        `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`,
      );

      // ── File-level header ──
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
          `(${(reductionRatio * 100).toFixed(0)}% reduction) → Vault ${vaultId}`,
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
      // Fall through to regex fallback
    }
  }

  // ── Path B: Regex fallback ──
  console.warn(
    "[AST Compressor] Using regex fallback — build native for best results",
  );
  return regexFallbackCompress(text);
}

/**
 * Async wrapper — yields to event loop via setImmediate so compression
 * does not block the server during large file processing.
 */
async function compressCodeOutputAsync(
  text,
  languageHint = "",
  policy = null,
  filePath = null,
) {
  return new Promise((resolve) => {
    setImmediate(() => {
      resolve(compressCodeOutput(text, languageHint, policy, filePath));
    });
  });
}

// ─────────────────────────────────────────────
// Regex fallback (original AST-Lite logic)
// Only used when native isn't built
// ─────────────────────────────────────────────
const IMPORT_PATTERN =
  /^(import\s+[\s\S]*?from\s+['"][^'"]+['"]|const\s+\w+\s*=\s*require\s*\(.*\)|require\s*\(.*\))/gm;
const EXPORT_PATTERN =
  /^export\s+(default\s+)?(class|function|const|let|var|async\s+function|interface|type|enum)\s+\w+/gm;
const FUNCTION_SIGNATURE =
  /^(?:\/\*\*[\s\S]*?\*\/\s*)*\s*(?:(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*(?::\s*\w+)?(?:\s*\{)?)/gm;
const CLASS_PATTERN =
  /^(?:\/\*\*[\s\S]*?\*\/\s*)*\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/gm;

function regexFallbackCompress(text) {
  const lines = text.split(/\r?\n/);
  const linesToKeep = new Set();

  const patterns = [
    IMPORT_PATTERN,
    EXPORT_PATTERN,
    FUNCTION_SIGNATURE,
    CLASS_PATTERN,
  ];

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
        if (
          resultLines.length > 0 &&
          resultLines[resultLines.length - 1].trim() !== ""
        ) {
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

  const codeMessages = payload.messages.filter(
    (m) => m.role === "tool" && m._cf_type === "code",
  ).length;

  if (codeMessages > 0) {
    console.log(
      `[AST Compressor] Processing ${codeMessages} code-tagged tool result(s)` +
        (policy ? ` [mode=${policy.mode}]` : ""),
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

  for (const msg of payload.messages) {
    // ── Tool messages (post-translation format) ──
    if (
      msg.role === "tool" &&
      typeof msg.content === "string" &&
      msg._cf_type === "code"
    ) {
      if (msg._cf_editable === true) {
        // Skip editable tool outputs to preserve exact literal bytes
        newMessages.push(msg);
        continue;
      }

      // ── Skip already-AST-compressed messages ──
      if (msg._compressedVaultId) {
        newMessages.push(msg);
        continue;
      }

      // ── Skip if SemanticDedup or FatCatch already vaulted ──
      if (
        msg._dedupVaultId ||
        (typeof msg.content === "string" && msg.content.includes("[CF_VAULT:"))
      ) {
        newMessages.push(msg);
        continue;
      }

      // ── ADD THIS BLOCK: Skip if SemanticDedup deduped (exact or near-dup) ──
      // Messages with _cf_deduped=true have already been processed by
      // SemanticDedup — their content is either a CF_DELTA stub or a
      // vault reference. Running tree-sitter on these wastes 10-30ms
      // and produces garbage output.
      if (msg._cf_deduped || msg.__cf_raw) {
        newMessages.push(msg);
        continue;
      }

      // ── Skip tiny files — not worth AST overhead ──
      if (msg.content.split("\n").length < 30) {
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
        msg._filename || null,
      );

      if (result.vaulted) {
        stats.compressed++;
        stats.charsSaved += beforeLen - result.kept.length;
        stats.vaults++;
        if (result.nodesCompressed) stats.totalNodes += result.nodesCompressed;
        if (result.highComplexityNodes) {
          stats.highComplexityFunctions.push(...result.highComplexityNodes);
        }
        newMessages.push({
          ...msg,
          content: result.kept,
          _compressedVaultId: result.vaultId,
          _astLanguage: result.language,
          _syntaxValid: result.syntaxValid,
        });
        continue;
      }

      newMessages.push(msg);
      continue;
    }

    // ── Anthropic content blocks (pre-translation format) ──
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const newBlocks = [];
      for (const block of msg.content) {
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block._cf_type === "code"
        ) {
          // ── Guard: Skip already-vaulted blocks ──
          if (
            block._dedupVaultId || block.__cf_raw ||
            (typeof block.content === "string" &&
              block.content.includes("[CF_VAULT:"))
          ) {
            newBlocks.push(block);
            continue;
          }

          const beforeLen = block.content.length;

          const blockLangHint = block._filename
            ? (EXT_TO_LANG[block._filename.split(".").pop()?.toLowerCase()] ??
              "")
            : "";

          const result = await compressCodeOutputAsync(
            block.content,
            blockLangHint,
            policy,
            block._filename || null,
          );

          if (result.vaulted) {
            stats.compressed++;
            stats.charsSaved += beforeLen - result.kept.length;
            stats.vaults++;
            newBlocks.push({
              ...block,
              content: result.kept,
              _compressedVaultId: result.vaultId,
            });
            continue;
          }
        }
        newBlocks.push(block);
      }
      newMessages.push({ ...msg, content: newBlocks });
      continue;
    }

    newMessages.push(msg);
  }

  payload.messages = newMessages;

  if (stats.compressed > 0) {
    console.log(
      `[AST Compressor Summary] Compressed ${stats.compressed} files | ` +
        `Chars saved: ${stats.charsSaved} (~${Math.floor(stats.charsSaved / 4)} tokens) | ` +
        `Vaults: ${stats.vaults}`,
    );

    if (stats.highComplexityFunctions.length > 0) {
      console.log(
        `[AST Compressor] 🧠 High-complexity functions in session: ` +
          stats.highComplexityFunctions
            .sort((a, b) => b.complexity - a.complexity)
            .slice(0, 5)
            .map((n) => `${n.name}(cc=${n.complexity})`)
            .join(", "),
      );
    }
  }

  return payload;
}
