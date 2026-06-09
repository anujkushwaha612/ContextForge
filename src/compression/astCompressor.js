import { createRequire } from "module";
import { saveToVault } from "../logging/cacheDb.js";

const require = createRequire(import.meta.url);

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
    `Run: bash scripts/vendor-grammars.sh && cd native && node-gyp rebuild`
  );
}

// ─────────────────────────────────────────────
// Compressor instance cache
// Key: serialized policy fingerprint → instance
// Avoids recreating for same policy, avoids
// single stale instance when policy changes
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
      preserveImports:          true,
      preserveSignatures:       true,
      preserveTypeAnnotations:  true,
      preserveDecorators:       true,
      vaultOnCompress:          true,
      docstringMode:            1,       // FIRST_LINE

      // Policy-driven values — fall back to safe defaults
      preserveErrorHandlers:    policy?.preserveErrorHandlers ?? true,
      maxBodyLines:             policy?.maxBodyLines          ?? 4,
      minTokensToCompress:      policy?.minTokensToCompress   ?? 80,
    };

    _compressorCache.set(key, new NativeASTCompressor(opts));

    console.log(
      `[AST Compressor] Created compressor instance [${key}]`
    );
  }

  return _compressorCache.get(key);
}

// ─────────────────────────────────────────────
// compressCodeOutput
// ─────────────────────────────────────────────
export function compressCodeOutput(text, languageHint = "", policy = null) {
  if (typeof text !== "string" || text.length < 200) {
    return { kept: text, vaulted: false };
  }

  const lineCount = text.split("\n").length;
  console.log(
    `[AST Compressor] 🔍 Analyzing ${lineCount} line file` +
    (languageHint ? ` (${languageHint})` : " (auto-detect)") +
    (policy ? ` [mode=${policy.mode}]` : "")
  );

  // ── Path A: Native tree-sitter ──────────────
  const compressor = getCompressor(policy);
  if (compressor) {
    try {
      const result = compressor.compress(text, languageHint);

      console.log(
        `[AST Compressor] Lang: ${result.languageDetected} | ` +
        `Nodes: ${result.nodesFound} found, ${result.nodesCompressed} compressed | ` +
        `Lines: ${result.originalLines} → ${result.compressedLines} ` +
        `(${(result.compressionRatio * 100).toFixed(1)}%)`
      );

      if (result.highComplexityNodes && result.highComplexityNodes.length > 0) {
        console.log(
          `[AST Compressor] ⚠️  High-complexity functions detected:`,
          result.highComplexityNodes
            .map(n => `${n.name}(cc=${n.complexity})`)
            .join(", ")
        );
      }

      // Only vault if meaningful reduction achieved
      const reductionRatio = result.compressionRatio;
      if (reductionRatio < 0.2 || result.nodesCompressed === 0) {
        console.log(
          `[AST Compressor] ⏭️  Insufficient reduction ` +
          `(${(reductionRatio * 100).toFixed(1)}% < 20% or no bodies compressed)`
        );
        return { kept: text, vaulted: false };
      }

      const vaultId = saveToVault(text);

      console.log(
        `[AST Compressor] ✅ Compressed: ${result.originalLines} → ` +
        `${result.compressedLines} lines ` +
        `(${(reductionRatio * 100).toFixed(0)}% reduction) → Vault ${vaultId}`
      );

      return {
        kept:             result.compressedSource,
        vaulted:          true,
        vaultId,
        originalText:     text,
        removedChars:     text.length - result.compressedSource.length,
        originalLines:    result.originalLines,
        compressedLines:  result.compressedLines,
        language:         result.languageDetected,
        nodesFound:       result.nodesFound,
        nodesCompressed:  result.nodesCompressed,
        syntaxValid:      result.syntaxValid,
        highComplexityNodes: result.highComplexityNodes || [],
      };

    } catch (err) {
      console.error(`[AST Compressor] ❌ Native error: ${err.message}`);
      // Fall through to regex fallback
    }
  }

  // ── Path B: Regex fallback ──────────────────
  console.warn(
    "[AST Compressor] Using regex fallback — build native for best results"
  );
  return regexFallbackCompress(text);
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
    IMPORT_PATTERN, EXPORT_PATTERN, FUNCTION_SIGNATURE, CLASS_PATTERN,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    let charCount = 0;
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
    const opens  = (line.match(/\{/g) || []).length;
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
  return {
    kept:          keptText,
    vaulted:       true,
    vaultId,
    originalText:  text,
    removedChars,
    originalLines: lines.length,
  };
}

// ─────────────────────────────────────────────
// compressCodeToolResults — policy-aware
// ─────────────────────────────────────────────
export function compressCodeToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  // Read policy attached by server.js (non-enumerable — won't hit the wire)
  const policy = payload.__policy ?? null;

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

  payload.messages = payload.messages.map((msg) => {
    // ── Tool messages (post-translation format) ──
    if (
      msg.role === "tool" &&
      typeof msg.content === "string" &&
      msg._cf_type === "code"
    ) {
      const beforeLen = msg.content.length;

      const langHint = msg._filename
        ? msg._filename.split(".").pop()
        : "";

      // policy flows through to getCompressor() → correct instance
      const result = compressCodeOutput(msg.content, langHint, policy);

      if (result.vaulted) {
        stats.compressed++;
        stats.charsSaved += beforeLen - result.kept.length;
        stats.vaults++;
        if (result.nodesCompressed) stats.totalNodes += result.nodesCompressed;
        if (result.highComplexityNodes) {
          stats.highComplexityFunctions.push(...result.highComplexityNodes);
        }

        return {
          ...msg,
          content:              result.kept,
          _compressedVaultId:   result.vaultId,
          _astLanguage:         result.language,
          _syntaxValid:         result.syntaxValid,
        };
      }
      return msg;
    }

    // ── Anthropic content blocks (pre-translation format) ──
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((block) => {
          if (
            block.type === "tool_result" &&
            typeof block.content === "string" &&
            block._cf_type === "code"
          ) {
            const beforeLen = block.content.length;

            const result = compressCodeOutput(
              block.content,
              "",
              policy   // ← policy flows here too
            );

            if (result.vaulted) {
              stats.compressed++;
              stats.charsSaved += beforeLen - result.kept.length;
              stats.vaults++;
              return {
                ...block,
                content:            result.kept,
                _compressedVaultId: result.vaultId,
              };
            }
            return block;
          }
          return block;
        }),
      };
    }

    return msg;
  });

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
          .map(n => `${n.name}(cc=${n.complexity})`)
          .join(", ")
      );
    }
  }

  return payload;
}