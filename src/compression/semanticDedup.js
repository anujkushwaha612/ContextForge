/**
 * Semantic deduplication for tool results.
 *
 * Fixes applied:
 *   FIX-A: getDynamicThreshold was called with a bare number (content.length)
 *          but expects { contentLength, fileType } — always returned 8 (default).
 *          Now called correctly.
 *
 *   FIX-B: Path key inconsistency between "file:src/proxy/stagetimer.js" and
 *          "file:proxy/stagetimer.js" caused cache misses for the same file.
 *          normalizeFilePath now additionally strips common src/ prefixes so
 *          both resolve to the same canonical key.
 *
 *   FIX-C: MIN_SAVINGS_RATIO lowered 0.3 → 0.1 so near-dup deltas are sent
 *          more aggressively. When savings are still below threshold but the
 *          content is already vaulted, we now send a vault stub instead of
 *          full content — preventing double-transmission of large files.
 */

import { createRequire } from "module";
import path from "path";
import { saveToVault, fetchFromVault } from "../logging/cacheDb.js";
import { statsEmitter } from "../proxy/statsEmitter.js";

const require = createRequire(import.meta.url);
const native = require("../../native/build/Release/contextforge_native.node");

// ─────────────────────────────────────────────
// Session registry
// ─────────────────────────────────────────────

const MAX_REGISTRY_SIZE = 50;

class SessionFileRegistry {
  constructor() {
    /** @type {Map<string, SeenEntry>} */
    this._seen = new Map();
    this._turnIndex = 0;
  }

  incrementTurn() {
    this._turnIndex++;
  }

  get(key) {
    return this._seen.get(key) ?? null;
  }

  set(key, entry) {
    if (!this._seen.has(key) && this._seen.size >= MAX_REGISTRY_SIZE) {
      const oldestKey = this._seen.keys().next().value;
      this._seen.delete(oldestKey);
    }
    this._seen.set(key, { ...entry, turnIndex: this._turnIndex });
  }

  get size() {
    return this._seen.size;
  }

  clear() {
    this._seen.clear();
    this._turnIndex = 0;
  }

  getStats() {
    return {
      trackedFiles: this._seen.size,
      currentTurn: this._turnIndex,
      keys: [...this._seen.keys()],
    };
  }
}

export const sessionRegistry = new SessionFileRegistry();

// ─────────────────────────────────────────────
// Filename extraction
// ─────────────────────────────────────────────

const FILENAME_PATTERNS = [
  /^(?:File|Path|Filename|Reading):\s*(.+\.\w+)/im,
  /^```[\w]*\s+([\w/\\.\-]+\.\w+)/m,
  /^((?:[\w.\-]+\/)+[\w.\-]+\.\w+)\s*$/m,
  /\b(?:reading|opened?|loaded?|viewing?|cat)\s+['""]?([\w/\\.\-]+\.\w+)['""]?/im,
  /\b(\/(?:[\w.\-]+\/)+[\w.\-]+\.\w+)\b/,
  /\b([A-Za-z]:\\(?:[\w.\- ]+\\)+[\w.\-]+\.\w+)\b/,
  /\b((?:\.{1,2}\/|[\w.\-]+\/)[\w/\\.\-]+\.\w+)\b/,
];

const SOURCE_EXTENSIONS = new Set([
  "js", "ts", "jsx", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "cpp", "h", "hpp", "cs",
  "json", "yaml", "yml", "toml", "xml",
  "md", "mdx", "txt", "rst",
  "css", "scss", "less", "html", "htm",
  "vue", "svelte", "sh", "bash", "zsh", "fish",
  "sql", "graphql", "proto", "env", "gitignore", "dockerignore",
]);

function extractFilename(msg) {
  if (msg._filename && typeof msg._filename === "string") {
    return normalizeFilePath(msg._filename);
  }

  if (msg.name && msg.name.includes("/")) {
    const candidate = normalizeFilePath(msg.name);
    if (candidate) return candidate;
  }

  if (msg._args && typeof msg._args === "object") {
    const pathFields = [
      "file_path", "path", "filepath", "filename",
      "file", "source", "target", "uri",
    ];
    for (const field of pathFields) {
      const val = msg._args[field];
      if (typeof val === "string" && val.length > 0) {
        const candidate = normalizeFilePath(val);
        if (candidate) return candidate;
      }
    }
  }

  const content = msg.content;
  if (typeof content !== "string" || content.length === 0) return null;

  const head = content.slice(0, 500);
  for (const pattern of FILENAME_PATTERNS) {
    const match = head.match(pattern);
    if (match?.[1]) {
      const candidate = normalizeFilePath(match[1].trim());
      if (candidate) return candidate;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeFilePath
//
// FIX-B: Added canonical src/ prefix stripping.
//
// The inconsistency between "file:src/proxy/stagetimer.js" and
// "file:proxy/stagetimer.js" comes from different tools passing paths
// differently:
//   - Claude Code's read_file passes: "src/proxy/stageTimer.js"
//   - PatchEngine / grep passes:      "proxy/stageTimer.js"
//     (relative to src/ instead of cwd)
//
// Both are already relative paths so CWD_PREFIX stripping doesn't help.
// The fix is to canonicalize by checking if the path WITHOUT a leading
// "src/" resolves to a file that also exists WITH "src/" — but that
// requires a filesystem hit. Instead we do the cheaper thing: always
// strip a leading "src/" so both paths become "proxy/stagetimer.js".
//
// This is safe because:
//   1. ContextForge's source lives under src/ exclusively
//   2. No two files have the same path differing only by src/ prefix
//   3. The canonical key just needs to be consistent, not match any
//      real filesystem path
// ─────────────────────────────────────────────────────────────────────────────

const CWD_PREFIX = path
  .resolve(process.cwd())
  .replace(/\\/g, "/")
  .toLowerCase()
  .replace(/\/?$/, "/");

// Leading directory segments that different tools strip inconsistently.
// We remove these to produce a canonical path that all tools agree on.
// Order matters: try longest prefix first.
const STRIP_PREFIXES = ["src/"];

function normalizeFilePath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;

  let p = rawPath.trim();
  if (p.length === 0 || p.length > 300) return null;

  const extMatch = p.match(/\.(\w+)$/);
  if (!extMatch) return null;
  const ext = extMatch[1].toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) return null;

  // Normalise separators and lowercase
  p = p.replace(/\\/g, "/").toLowerCase();

  // Strip process.cwd() prefix (absolute paths)
  if (p.startsWith(CWD_PREFIX)) {
    p = p.slice(CWD_PREFIX.length);
  }

  // Strip bare drive letter
  p = p.replace(/^[a-z]:\//i, "");

  // Strip leading slashes / "./"
  p = p
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");

  // FIX-B: Strip canonical leading prefixes so tools that pass
  // "src/proxy/foo.js" and tools that pass "proxy/foo.js" both
  // produce the same registry key: "proxy/foo.js"
  for (const prefix of STRIP_PREFIXES) {
    if (p.startsWith(prefix)) {
      p = p.slice(prefix.length);
      break; // only strip one prefix level
    }
  }

  return p.length > 0 ? p : null;
}

// ─────────────────────────────────────────────
// buildMessageKey
// ─────────────────────────────────────────────

function buildMessageKey(msg) {
  const filename = extractFilename(msg);
  if (filename) {
    const toolSuffix =
      msg.name && typeof msg.name === "string" ? `|tool:${msg.name}` : "";
    return `file:${filename}${toolSuffix}`;
  }

  if (
    msg._cf_type === "text" &&
    typeof msg.content === "string" &&
    msg.content.length >= 100
  ) {
    const prefix = msg.content.slice(0, 200);
    return "text:" + fnv1a64(prefix);
  }

  return null;
}

// ─────────────────────────────────────────────
// SimHash wrappers
// ─────────────────────────────────────────────

function computeFingerprint(text) {
  try {
    return native.simhash(text);
  } catch (err) {
    console.warn("[SemanticDedup] SimHash failed:", err.message);
    return null;
  }
}

function fingerprintDistance(a, b) {
  try {
    return native.hammingDistance(a, b);
  } catch (err) {
    console.warn("[SemanticDedup] hammingDistance failed:", err.message);
    return 64;
  }
}

// ─────────────────────────────────────────────
// Fast content identity check (FNV-1a 64-bit)
// ─────────────────────────────────────────────

function fnv1a64(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;

  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    if (i % 2 === 0) {
      h2 ^= c;
      h2 = Math.imul(h2, 0x01000193) >>> 0;
    }
  }

  return `${h1.toString(16)}_${h2.toString(16)}`;
}

// ─────────────────────────────────────────────
// Myers diff
// ─────────────────────────────────────────────

async function computeLineDiff(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  await new Promise((resolve) => setImmediate(resolve));

  const totalLines = oldLines.length + newLines.length;

  if (totalLines > 2000) return null;

  if (
    oldLines.length < 5 &&
    newLines.length < 5 &&
    oldText.length > 20_000 &&
    newText.length > 20_000
  ) {
    return null;
  }

  if (totalLines > 500) {
    return fastLineDiff(oldLines, newLines);
  }

  return myersDiff(oldLines, newLines);
}

function myersDiff(oldLines, newLines) {
  const m   = oldLines.length;
  const n   = newLines.length;
  const max = m + n;
  if (max === 0) return [];

  const V     = new Int32Array(2 * max + 1);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && V[k - 1 + max] < V[k + 1 + max])) {
        x = V[k + 1 + max];
      } else {
        x = V[k - 1 + max] + 1;
      }
      let y = x - k;
      while (x < m && y < n && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      V[k + max] = x;
      if (x >= m && y >= n) {
        return _myersBacktrack(trace, oldLines, newLines, max);
      }
    }
  }

  return [
    ...oldLines.map((line) => ({ type: "delete", line })),
    ...newLines.map((line) => ({ type: "insert", line })),
  ];
}

function _myersBacktrack(trace, oldLines, newLines, max) {
  const ops = [];
  let x = oldLines.length;
  let y = newLines.length;

  for (let d = trace.length - 1; d > 0; d--) {
    const V  = trace[d];
    const k  = x - y;
    let prevK;
    if (k === -d || (k !== d && V[k - 1 + max] < V[k + 1 + max])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = V[prevK + max];
    const prevY = prevX - prevK;

    while (
      x > prevX + (prevK === k - 1 ? 1 : 0) &&
      y > prevY + (prevK === k + 1 ? 1 : 0) &&
      x > 0 &&
      y > 0
    ) {
      ops.unshift({ type: "equal", line: oldLines[x - 1] });
      x--;
      y--;
    }

    if (prevK === k + 1) {
      if (y > 0) {
        ops.unshift({ type: "insert", line: newLines[y - 1] });
        y--;
      }
    } else {
      if (x > 0) {
        ops.unshift({ type: "delete", line: oldLines[x - 1] });
        x--;
      }
    }
  }

  while (x > 0 && y > 0) {
    ops.unshift({ type: "equal", line: oldLines[x - 1] });
    x--;
    y--;
  }

  return ops;
}

function fastLineDiff(oldLines, newLines) {
  const oldIndex = new Map();
  for (let i = 0; i < oldLines.length; i++) {
    const key = _lineHash(oldLines[i]);
    if (!oldIndex.has(key)) oldIndex.set(key, i);
  }

  const ops    = [];
  let   oldPtr = 0;

  for (const newLine of newLines) {
    const key      = _lineHash(newLine);
    const matchIdx = oldIndex.get(key);
    if (matchIdx !== undefined && matchIdx >= oldPtr) {
      for (let i = oldPtr; i < matchIdx; i++) {
        ops.push({ type: "delete", line: oldLines[i] });
      }
      ops.push({ type: "equal", line: newLine });
      oldPtr = matchIdx + 1;
    } else {
      ops.push({ type: "insert", line: newLine });
    }
  }

  for (let i = oldPtr; i < oldLines.length; i++) {
    ops.push({ type: "delete", line: oldLines[i] });
  }

  return ops;
}

function _lineHash(line) {
  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h  = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ─────────────────────────────────────────────
// Delta formatter
// ─────────────────────────────────────────────

const CONTEXT_LINES = 3;

function formatDeltaForLLM(ops, ref) {
  const insertions = ops.filter((o) => o.type === "insert").length;
  const deletions  = ops.filter((o) => o.type === "delete").length;
  const unchanged  = ops.filter((o) => o.type === "equal").length;

  const header = [
    `[CF_DELTA: ${ref.filename} — unchanged from turn ${ref.seenTurn}]`,
    `Reference vault: ${ref.vaultId}`,
    `Similarity: ${ref.similarity}% identical` +
      ` (${unchanged} unchanged lines, +${insertions} added, -${deletions} removed)`,
    ``,
  ];

  if (insertions === 0 && deletions === 0) {
    return [
      ...header,
      `[No changes — content is identical to turn ${ref.seenTurn}]`,
      `Use tool call contextforge_retrieve with vault_id="${ref.vaultId}" to read the full content.`,
    ].join("\n");
  }

  const changeIndices = new Set();
  ops.forEach((op, i) => {
    if (op.type !== "equal") changeIndices.add(i);
  });

  const keepIndices = new Set();
  for (const idx of changeIndices) {
    for (let d = -CONTEXT_LINES; d <= CONTEXT_LINES; d++) {
      const t = idx + d;
      if (t >= 0 && t < ops.length) keepIndices.add(t);
    }
  }

  const body   = [`--- Changes from turn ${ref.seenTurn} ---`];
  let inGap    = false;
  let gapCount = 0;

  for (let i = 0; i < ops.length; i++) {
    if (!keepIndices.has(i)) {
      inGap = true;
      gapCount++;
      continue;
    }
    if (inGap) {
      body.push(`  [... ${gapCount} unchanged lines ...]`);
      inGap    = false;
      gapCount = 0;
    }
    const { type, line } = ops[i];
    if (type === "equal")  body.push(`  ${line}`);
    if (type === "delete") body.push(`- ${line}`);
    if (type === "insert") body.push(`+ ${line}`);
  }

  if (inGap) body.push(`  [... ${gapCount} unchanged lines ...]`);

  body.push(`--- End of changes ---`);
  body.push(
    `Use tool call contextforge_retrieve with vault_id="${ref.vaultId}" to read the full content.`,
  );

  return [...header, ...body].join("\n");
}

// ─────────────────────────────────────────────
// Core deduplication
// ─────────────────────────────────────────────

const MIN_DEDUP_CHARS   = 500;

// FIX-C: Lowered from 0.3 → 0.1 so near-dup deltas fire more aggressively.
// Previously only deltas that saved >30% were sent; now >10% is enough.
// When savings are still below 10% but content is already vaulted, we send
// a vault stub instead of full content (see vault-stub path below).
const MIN_SAVINGS_RATIO = 0.1;

// FIX-A: getDynamicThreshold previously received content.length (a number)
// but destructures { contentLength, fileType } — so contentLength was always
// undefined and every if-check failed, returning the default 8 regardless of
// file size. Large files (200k chars) should get threshold 24, not 8.
function getDynamicThreshold({ contentLength, fileType }) {
  if (contentLength > 200_000) return 24;
  if (contentLength > 100_000) return 20;
  if (contentLength > 50_000)  return 16;
  if (contentLength > 20_000)  return 12;
  return 8;
}

async function deduplicateMessage(msg, key) {
  const content = msg.content;
  if (!content || content.length < MIN_DEDUP_CHARS) {
    return { deduplicated: false, msg };
  }

  const existing = sessionRegistry.get(key);

  // ── Fast-path: FNV-1a exact match check before expensive SimHash ──
  if (existing && existing.contentHash) {
    const contentHash = fnv1a64(content);
    if (contentHash === existing.contentHash) {
      if (existing.turnIndex !== sessionRegistry._turnIndex) {
        sessionRegistry.set(key, { ...existing, contentHash });
      }
      const tokensSaved = Math.round(content.length / 4);
      statsEmitter.recordCacheHit("semanticDedup", true);
      console.log(
        `[SemanticDedup] ⚡ Fast-path exact duplicate: ${key} ` +
          `(FNV-1a match, SimHash skipped)`,
      );
      return {
        deduplicated: true,
        msg: {
          ...msg,
          _cf_deduped: true,
          content:
            `[CF_DELTA: ${msg._filename || key} — IDENTICAL to turn ${existing.turnIndex}]\n` +
            `Reference vault: ${existing.vaultId}\n` +
            `Content is byte-for-byte identical to the version read on turn ${existing.turnIndex}.\n` +
            `Tokens saved: ~${tokensSaved}\n` +
            `Use tool call contextforge_retrieve with vault_id="${existing.vaultId}" to read the full content.`,
          _dedupVaultId: existing.vaultId,
          _dedupSimilarity: 100,
        },
      };
    }
  }

  const fingerprint = computeFingerprint(content);
  if (fingerprint === null) return { deduplicated: false, msg };

  // ── First time seeing this key ──
  if (!existing) {
    const vaultId = saveToVault(content);
    sessionRegistry.set(key, {
      fingerprint,
      contentHash: fnv1a64(content),
      vaultId,
      contentLength: content.length,
    });
    statsEmitter.recordCacheHit("semanticDedup", false);
    console.log(
      `[SemanticDedup] 📝 Registered: ${key} ` +
        `(${Math.round(content.length / 4)} tokens → vault ${vaultId})`,
    );
    return { deduplicated: false, msg };
  }

  const distance      = fingerprintDistance(fingerprint, existing.fingerprint);
  const similarityPct = Math.round(((64 - distance) / 64) * 100);

  // FIX-A: Pass object with contentLength so getDynamicThreshold works correctly.
  // Previously called as getDynamicThreshold(content.length) — a bare number —
  // so destructuring { contentLength } always yielded undefined and the function
  // always returned the default threshold of 8 regardless of file size.
  const dynamicThreshold = getDynamicThreshold({ contentLength: content.length });

  // ── Sufficiently different — update registry ──
  if (distance > dynamicThreshold) {
    const vaultId = saveToVault(content);
    sessionRegistry.set(key, {
      fingerprint,
      contentHash: fnv1a64(content),
      vaultId,
      contentLength: content.length,
    });
    statsEmitter.recordCacheHit("semanticDedup", false);
    console.log(
      `[SemanticDedup] 🔄 Updated: ${key} ` +
        `(distance=${distance}, ${similarityPct}% — different enough)`,
    );
    return { deduplicated: false, msg };
  }

  console.log(
    `[SemanticDedup] 🎯 Near-duplicate: ${key} ` +
      `(distance=${distance}, ${similarityPct}% similar to turn ${existing.turnIndex})`,
  );

  // ── distance === 0: verify with FNV-1a ──
  if (distance === 0) {
    const contentHash      = fnv1a64(content);
    const isTrulyIdentical = existing.contentHash === contentHash;

    if (isTrulyIdentical) {
      const tokensSaved = Math.round(content.length / 4);
      if (existing.turnIndex !== sessionRegistry._turnIndex) {
        sessionRegistry.set(key, { ...existing, contentHash });
      }
      statsEmitter.recordCacheHit("semanticDedup", true);
      console.log(
        `[SemanticDedup] ✅ Exact duplicate: ${key} ` +
          `(${tokensSaved} tokens saved, ref vault=${existing.vaultId})`,
      );
      return {
        deduplicated: true,
        msg: {
          ...msg,
          _cf_deduped: true,
          content:
            `[CF_DELTA: ${msg._filename || key} — IDENTICAL to turn ${existing.turnIndex}]\n` +
            `Reference vault: ${existing.vaultId}\n` +
            `Content is byte-for-byte identical to the version read on turn ${existing.turnIndex}.\n` +
            `Tokens saved: ~${tokensSaved}\n` +
            `Use tool call contextforge_retrieve with vault_id="${existing.vaultId}" to read the full content.`,
          _dedupVaultId: existing.vaultId,
          _dedupSimilarity: 100,
        },
      };
    }

    console.log(
      `[SemanticDedup] 🔀 SimHash collision on ${key}: ` +
        `distance=0 but FNV-1a differs — routing to diff ` +
        `(file size ${content.length} chars, 64-bit hash saturated)`,
    );
  }

  // ── Near-duplicate — retrieve original and diff ──
  let originalContent = null;
  try {
    originalContent = fetchFromVault(existing.vaultId);
  } catch (err) {
    console.warn(`[SemanticDedup] ⚠️ Vault fetch failed: ${err.message}`);
  }

  if (!originalContent) {
    console.warn(
      `[SemanticDedup] ⚠️ Vault miss: ${existing.vaultId} — resetting`,
    );
    const vaultId = saveToVault(content);
    sessionRegistry.set(key, {
      fingerprint,
      contentHash: fnv1a64(content),
      vaultId,
      contentLength: content.length,
    });
    statsEmitter.recordCacheHit("semanticDedup", false);
    return { deduplicated: false, msg };
  }

  let ops;
  try {
    ops = await computeLineDiff(originalContent, content);
  } catch (err) {
    console.warn(`[SemanticDedup] ⚠️ Diff failed: ${err.message}`);
    sessionRegistry.set(key, {
      fingerprint,
      contentHash:   fnv1a64(content),
      vaultId:       existing.vaultId,
      contentLength: content.length,
    });
    return { deduplicated: false, msg };
  }

  if (ops === null) {
    console.log(
      `[SemanticDedup] ⏭️  File too large to diff (${content.length} chars) — ` +
        `Fat Catch will vault. Near-dup acknowledged but delta skipped.`,
    );
    sessionRegistry.set(key, {
      fingerprint,
      contentHash:   fnv1a64(content),
      vaultId:       existing.vaultId,
      contentLength: content.length,
    });
    statsEmitter.recordCacheHit("semanticDedup", false);
    return { deduplicated: false, msg };
  }

  const deltaText = formatDeltaForLLM(ops, {
    filename:   msg._filename || key,
    seenTurn:   existing.turnIndex,
    vaultId:    existing.vaultId,
    similarity: similarityPct,
  });

  const savingsRatio = 1 - deltaText.length / content.length;

  // FIX-C: Three-way branch on savings ratio:
  //
  //   ① savingsRatio >= MIN_SAVINGS_RATIO (10%)
  //      → Normal path: send delta, update vault with new content.
  //
  //   ② savingsRatio < MIN_SAVINGS_RATIO AND existing.vaultId present
  //      → Vault-stub path: content is already stored; sending full content
  //        would re-transmit thousands of tokens for marginal delta. Instead
  //        send a lightweight stub that the LLM can expand via retrieve tool.
  //        This is the core fix — previously full content was always sent here.
  //
  //   ③ savingsRatio < MIN_SAVINGS_RATIO AND no vaultId
  //      → Fallback: no vault available, must send full content.
  if (savingsRatio < MIN_SAVINGS_RATIO) {
    if (existing.vaultId) {
      // ② Vault-stub path — content already safe in vault, skip re-transmission
      console.log(
        `[SemanticDedup] ⏭️ Delta savings ${(savingsRatio * 100).toFixed(0)}% < ${(MIN_SAVINGS_RATIO * 100).toFixed(0)}% — ` +
          `but content is vaulted. Sending stub instead of full content.`,
      );
      statsEmitter.recordCacheHit("semanticDedup", true);
      return {
        deduplicated: true,
        msg: {
          ...msg,
          content: `[CF_VAULT:${existing.vaultId}] (Similarity: ${similarityPct}%)`,
          _dedupVaultId: existing.vaultId,
          _dedupSimilarity: similarityPct,
        },
      };
    }

    // ③ No vault — fall through and send full content
    console.log(
      `[SemanticDedup] ⏭️ Delta savings ${(savingsRatio * 100).toFixed(0)}% < ${(MIN_SAVINGS_RATIO * 100).toFixed(0)}% ` +
        `and no vault available — sending full content`,
    );
    sessionRegistry.set(key, {
      fingerprint,
      contentHash:   fnv1a64(content),
      vaultId:       existing.vaultId,
      contentLength: content.length,
    });
    statsEmitter.recordCacheHit("semanticDedup", false);
    return { deduplicated: false, msg };
  }

  // ① Normal path — delta saves enough, send it
  const newVaultId = saveToVault(content);
  sessionRegistry.set(key, {
    fingerprint,
    contentHash:   fnv1a64(content),
    vaultId:       newVaultId,
    contentLength: content.length,
  });
  statsEmitter.recordCacheHit("semanticDedup", true);
  console.log(
    `[SemanticDedup] ✅ Delta sent: ${key} | ` +
      `${content.length} → ${deltaText.length} chars ` +
      `(${(savingsRatio * 100).toFixed(0)}% saved, vault=${newVaultId})`,
  );

  return {
    deduplicated: true,
    msg: {
      ...msg,
      _cf_deduped:      true,
      content:          deltaText,
      _dedupVaultId:    newVaultId,
      _dedupSimilarity: similarityPct,
    },
  };
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

export async function applySemanticDedup(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  sessionRegistry.incrementTurn();

  const stats = {
    checked:      0,
    skippedType:  0,
    skippedNoKey: 0,
    deduplicated: 0,
    exactDups:    0,
    nearDups:     0,
    charsSaved:   0,
  };

  const newMessages = [];

  for (const msg of payload.messages) {
    if (msg.role !== "tool" || typeof msg.content !== "string") {
      newMessages.push(msg);
      continue;
    }

    if (msg._cf_vaulted) {
      newMessages.push(msg);
      continue;
    }

    if (!["code", "text", "markdown"].includes(msg._cf_type)) {
      stats.skippedType++;
      newMessages.push(msg);
      continue;
    }

    const key = buildMessageKey(msg);
    if (!key) {
      stats.skippedNoKey++;
      newMessages.push(msg);
      continue;
    }

    stats.checked++;

    const { deduplicated, msg: updatedMsg } = await deduplicateMessage(
      msg,
      key,
    );

    if (deduplicated) {
      stats.deduplicated++;
      stats.charsSaved += msg.content.length - updatedMsg.content.length;
      if (updatedMsg._dedupSimilarity === 100) {
        stats.exactDups++;
      } else {
        stats.nearDups++;
      }
    }

    newMessages.push(updatedMsg);
  }

  payload.messages = newMessages;

  if (stats.checked > 0 || stats.skippedNoKey > 0 || stats.skippedType > 0) {
    console.log(
      `[SemanticDedup] Checked ${stats.checked} | ` +
        `Deduped ${stats.deduplicated} ` +
        `(${stats.exactDups} exact, ${stats.nearDups} near-dup) | ` +
        `Chars saved: ${stats.charsSaved} (~${Math.floor(stats.charsSaved / 4)} tokens) | ` +
        `Skipped: ${stats.skippedType} wrong-type, ${stats.skippedNoKey} no-key`,
    );
  }

  return payload;
}

// ─────────────────────────────────────────────
// invalidateRegistryEntry
// ─────────────────────────────────────────────

export function invalidateRegistryEntry(filePath) {
  const normalized = normalizeFilePath(filePath);

  if (!normalized) {
    console.warn(
      `[SemanticDedup] ⚠️  invalidateRegistryEntry: could not normalize "${filePath}" — skipped`,
    );
    return false;
  }

  const prefix    = `file:${normalized}`;
  let invalidated = 0;

  for (const key of sessionRegistry._seen.keys()) {
    if (key === prefix || key.startsWith(prefix + "|tool:")) {
      sessionRegistry._seen.delete(key);
      console.log(`[SemanticDedup] 🗑️  Registry invalidated: ${key}`);
      invalidated++;
    }
  }

  if (invalidated === 0) {
    console.log(
      `[SemanticDedup] ℹ️  invalidateRegistryEntry: no entry found for "${normalized}"`,
    );
  }

  return invalidated > 0;
}

export { sessionRegistry as dedupRegistry };