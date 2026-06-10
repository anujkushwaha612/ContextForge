/**
 * Semantic deduplication for tool results.
 *
 * Problem: Claude Code reads the same file on turn 3, 8, 15, 22.
 * Each read is a unique FNV hash but 95%+ identical content.
 * Current behavior: send full content every time = 4 × 2400 tokens.
 * With semantic dedup: send full content once, then deltas = ~400 tokens total.
 *
 * Algorithm:
 *   1. SimHash fingerprint each tool result (C++ via native.simhash → BigInt)
 *   2. Compare against session registry of seen content
 *   3. If Hamming distance ≤ SIMILARITY_THRESHOLD → near-duplicate detected
 *   4. Retrieve original from vault (fetchFromVault — raw SQLite read)
 *   5. Compute Myers diff against retrieved original
 *   6. Send delta + vault reference instead of full content
 *
 * Session registry is keyed by: normalized filename → SeenEntry
 * Process-local singleton — survives the session, cleared on server restart.
 */

import crypto from "node:crypto";
import { createRequire } from "module";
import { saveToVault, fetchFromVault } from "../logging/cacheDb.js";

const require = createRequire(import.meta.url);
const native = require("../../native/build/Release/contextforge_native.node");

// ─────────────────────────────────────────────
// Session registry
// ─────────────────────────────────────────────

/**
 * @typedef {Object} SeenEntry
 * @property {BigInt}  fingerprint    - SimHash fingerprint (64-bit, BigInt)
 * @property {string}  vaultId        - ID in prune_vault table
 * @property {number}  turnIndex      - Turn when first seen
 * @property {number}  contentLength  - Original content byte length
 */

class SessionFileRegistry {
  constructor() {
    /** @type {Map<string, SeenEntry>} */
    this._seen = new Map();
    this._turnIndex = 0;
  }

  incrementTurn() {
    this._turnIndex++;
  }

  /** @returns {SeenEntry|null} */
  get(key) {
    return this._seen.get(key) ?? null;
  }

  /** @param {string} key @param {Omit<SeenEntry,'turnIndex'>} entry */
  set(key, entry) {
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
// Tries every possible source before giving up
// ─────────────────────────────────────────────

/**
 * File path patterns to extract from content.
 * Ordered from most specific to least specific.
 */
const FILENAME_PATTERNS = [
  // Explicit file headers (used by many editors and tools)
  /^(?:File|Path|Filename|Reading):\s*(.+\.\w+)/im,

  // Content block with language and path: ```js src/foo.js
  /^```[\w]*\s+([\w/\\.\-]+\.\w+)/m,

  // Single line that IS just a path (e.g. cat output header)
  /^((?:[\w.\-]+\/)+[\w.\-]+\.\w+)\s*$/m,

  // "Reading file: src/foo.js" style
  /\b(?:reading|opened?|loaded?|viewing?|cat)\s+['""]?([\w/\\.\-]+\.\w+)['""]?/im,

  // Absolute paths: /home/user/project/src/foo.js
  /\b(\/(?:[\w.\-]+\/)+[\w.\-]+\.\w+)\b/,

  // Windows absolute paths: C:\Users\...\foo.js
  /\b([A-Za-z]:\\(?:[\w.\- ]+\\)+[\w.\-]+\.\w+)\b/,

  // Relative paths with at least one directory component
  /\b((?:\.{1,2}\/|[\w.\-]+\/)[\w/\\.\-]+\.\w+)\b/,
];

/**
 * Known source file extensions — prevents matching version numbers
 * like "v1.2.3" or log timestamps as file paths.
 */
const SOURCE_EXTENSIONS = new Set([
  "js",
  "ts",
  "jsx",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "md",
  "mdx",
  "txt",
  "rst",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "vue",
  "svelte",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "graphql",
  "proto",
  "env",
  "gitignore",
  "dockerignore",
]);

/**
 * Extract a stable filename key from a tool result message.
 *
 * Sources tried in priority order:
 *   1. msg._filename       — set by tagToolResults (most reliable)
 *   2. msg.name            — tool name sometimes encodes file path
 *   3. msg._args           — parsed tool call arguments (file_path, path, etc.)
 *   4. Content patterns    — regex extraction from content body
 *
 * @param {object} msg
 * @returns {string|null} normalized path or null if not extractable
 */
function extractFilename(msg) {
  // ── Source 1: pre-tagged _filename ──
  if (msg._filename && typeof msg._filename === "string") {
    return normalizeFilePath(msg._filename);
  }

  // ── Source 2: tool name contains path ──
  // Some MCP tools encode the file path in the tool name
  // e.g. "read_file__src_server_js" → unlikely but guarded
  if (msg.name && msg.name.includes("/")) {
    const candidate = normalizeFilePath(msg.name);
    if (candidate) return candidate;
  }

  // ── Source 3: tool call arguments ──
  // tagToolResults stores parsed args in _args
  if (msg._args && typeof msg._args === "object") {
    const pathFields = [
      "file_path",
      "path",
      "filepath",
      "filename",
      "file",
      "source",
      "target",
      "uri",
    ];
    for (const field of pathFields) {
      const val = msg._args[field];
      if (typeof val === "string" && val.length > 0) {
        const candidate = normalizeFilePath(val);
        if (candidate) return candidate;
      }
    }
  }

  // ── Source 4: content body regex extraction ──
  const content = msg.content;
  if (typeof content !== "string" || content.length === 0) return null;

  // Only scan the first 500 chars — filename headers always appear early
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

/**
 * Normalize a file path into a stable, comparable key.
 * Returns null if the path doesn't look like a real source file.
 *
 * @param {string} rawPath
 * @returns {string|null}
 */
function normalizeFilePath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;

  const p = rawPath.trim();
  if (p.length === 0 || p.length > 300) return null;

  // Must have a valid source extension
  const extMatch = p.match(/\.(\w+)$/);
  if (!extMatch) return null;
  const ext = extMatch[1].toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) return null;

  // Normalize separators and strip leading ./ and /
  return p
    .replace(/\\/g, "/") // Windows → Unix
    .replace(/^\.\/+/, "") // strip ./
    .replace(/^\/+/, "") // strip leading /
    .replace(/\/+/g, "/") // collapse double slashes
    .toLowerCase(); // case-insensitive comparison
}

/**
 * Build a stable registry key from a message.
 * Returns null only if no filename can be extracted from any source.
 *
 * @param {object} msg
 * @returns {string|null}
 */
function buildMessageKey(msg) {
  const filename = extractFilename(msg);
  if (!filename) return null;
  return "file:" + filename;
}

// ─────────────────────────────────────────────
// SimHash wrappers
// ─────────────────────────────────────────────

/**
 * @param {string} text
 * @returns {BigInt|null}
 */
function computeFingerprint(text) {
  try {
    return native.simhash(text);
  } catch (err) {
    console.warn("[SemanticDedup] SimHash failed:", err.message);
    return null;
  }
}

/**
 * @param {BigInt} a
 * @param {BigInt} b
 * @returns {number} 0–64
 */
function fingerprintDistance(a, b) {
  try {
    return native.hammingDistance(a, b);
  } catch (err) {
    console.warn("[SemanticDedup] hammingDistance failed:", err.message);
    return 64;
  }
}

// ─────────────────────────────────────────────
// Myers diff
// ─────────────────────────────────────────────

/**
 * @typedef {Object} DiffOp
 * @property {'equal'|'insert'|'delete'} type
 * @property {string} line
 */

function computeLineDiff(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length + newLines.length > 4000) {
    return fastLineDiff(oldLines, newLines);
  }
  return myersDiff(oldLines, newLines);
}

function myersDiff(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;
  const max = m + n;
  if (max === 0) return [];

  const V = new Int32Array(2 * max + 1);
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
    const V = trace[d];
    const k = x - y;
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

  const ops = [];
  let oldPtr = 0;

  for (const newLine of newLines) {
    const key = _lineHash(newLine);
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
  return crypto.createHash("md5").update(line).digest("hex").slice(0, 8);
}

// ─────────────────────────────────────────────
// Delta formatter
// ─────────────────────────────────────────────

const CONTEXT_LINES = 3;

function formatDeltaForLLM(ops, ref) {
  const insertions = ops.filter((o) => o.type === "insert").length;
  const deletions = ops.filter((o) => o.type === "delete").length;
  const unchanged = ops.filter((o) => o.type === "equal").length;

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
      `Call contextforge_retrieve(vault_id:"${ref.vaultId}") if you need the full content.`,
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

  const body = [`--- Changes from turn ${ref.seenTurn} ---`];
  let inGap = false;
  let gapCount = 0;

  for (let i = 0; i < ops.length; i++) {
    if (!keepIndices.has(i)) {
      inGap = true;
      gapCount++;
      continue;
    }
    if (inGap) {
      body.push(`  [... ${gapCount} unchanged lines ...]`);
      inGap = false;
      gapCount = 0;
    }
    const { type, line } = ops[i];
    if (type === "equal") body.push(`  ${line}`);
    if (type === "delete") body.push(`- ${line}`);
    if (type === "insert") body.push(`+ ${line}`);
  }

  if (inGap) body.push(`  [... ${gapCount} unchanged lines ...]`);

  body.push(`--- End of changes ---`);
  body.push(
    `Call contextforge_retrieve(vault_id:"${ref.vaultId}") for full content.`,
  );

  return [...header, ...body].join("\n");
}

// ─────────────────────────────────────────────
// Core deduplication
// ─────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 8; // Hamming ≤ 8 of 64 bits = ≥87.5% similar
const MIN_DEDUP_CHARS = 500;
const MIN_SAVINGS_RATIO = 0.3;

function deduplicateMessage(msg, key) {
  const content = msg.content;
  if (!content || content.length < MIN_DEDUP_CHARS) {
    return { deduplicated: false, msg };
  }

  const fingerprint = computeFingerprint(content);
  if (fingerprint === null) return { deduplicated: false, msg };

  const existing = sessionRegistry.get(key);

  // First time seeing this key
  if (!existing) {
    const vaultId = saveToVault(content);
    sessionRegistry.set(key, {
      fingerprint,
      vaultId,
      contentLength: content.length,
    });
    console.log(
      `[SemanticDedup] 📝 Registered: ${key} ` +
        `(${Math.round(content.length / 4)} tokens → vault ${vaultId})`,
    );
    return { deduplicated: false, msg };
  }

  const distance = fingerprintDistance(fingerprint, existing.fingerprint);
  const similarityPct = Math.round(((64 - distance) / 64) * 100);

  // Sufficiently different — update registry
  if (distance > SIMILARITY_THRESHOLD) {
    const vaultId = saveToVault(content);
    sessionRegistry.set(key, {
      fingerprint,
      vaultId,
      contentLength: content.length,
    });
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

  // Exact duplicate
  if (distance === 0) {
    const tokensSaved = Math.round(content.length / 4);
    // Keep turnIndex current — re-set with same data
    sessionRegistry.set(key, { ...existing });

    console.log(
      `[SemanticDedup] ✅ Exact duplicate: ${key} ` +
        `(${tokensSaved} tokens saved, ref vault=${existing.vaultId})`,
    );

    return {
      deduplicated: true,
      msg: {
        ...msg,
        content:
          `[CF_DELTA: ${msg._filename || key} — IDENTICAL to turn ${existing.turnIndex}]\n` +
          `Reference vault: ${existing.vaultId}\n` +
          `Content is byte-for-byte identical to the version read on turn ${existing.turnIndex}.\n` +
          `Tokens saved: ~${tokensSaved}\n` +
          `Call contextforge_retrieve(vault_id:"${existing.vaultId}") if you need the full content.`,
        _dedupVaultId: existing.vaultId,
        _dedupSimilarity: 100,
      },
    };
  }

  // Near-duplicate — retrieve and diff
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
      vaultId,
      contentLength: content.length,
    });
    return { deduplicated: false, msg };
  }

  let ops;
  try {
    ops = computeLineDiff(originalContent, content);
  } catch (err) {
    console.warn(`[SemanticDedup] ⚠️ Diff failed: ${err.message}`);
    const vaultId = saveToVault(content);
    sessionRegistry.set(key, {
      fingerprint,
      vaultId,
      contentLength: content.length,
    });
    return { deduplicated: false, msg };
  }

  const deltaText = formatDeltaForLLM(ops, {
    filename: msg._filename || key,
    seenTurn: existing.turnIndex,
    vaultId: existing.vaultId,
    similarity: similarityPct,
  });

  const savingsRatio = 1 - deltaText.length / content.length;

  if (savingsRatio < MIN_SAVINGS_RATIO) {
    console.log(
      `[SemanticDedup] ⏭️  Delta savings ${(savingsRatio * 100).toFixed(0)}% < 30% — full content`,
    );
    const vaultId = saveToVault(content);
    sessionRegistry.set(key, {
      fingerprint,
      vaultId,
      contentLength: content.length,
    });
    return { deduplicated: false, msg };
  }

  const newVaultId = saveToVault(content);
  sessionRegistry.set(key, {
    fingerprint,
    vaultId: newVaultId,
    contentLength: content.length,
  });

  console.log(
    `[SemanticDedup] ✅ Delta sent: ${key} | ` +
      `${content.length} → ${deltaText.length} chars ` +
      `(${(savingsRatio * 100).toFixed(0)}% saved, vault=${newVaultId})`,
  );

  return {
    deduplicated: true,
    msg: {
      ...msg,
      content: deltaText,
      _dedupVaultId: newVaultId,
      _dedupSimilarity: similarityPct,
    },
  };
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

/**
 * Apply semantic deduplication to all tool results in the payload.
 *
 * Pipeline position:
 *   AFTER  tagToolResults
 *   BEFORE interceptAndVaultMassiveToolResults
 *   BEFORE pruneToolResults
 */
export function applySemanticDedup(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  sessionRegistry.incrementTurn();

  const stats = {
    checked: 0,
    skippedType: 0,
    skippedNoKey: 0,
    deduplicated: 0,
    exactDups: 0,
    nearDups: 0,
    charsSaved: 0,
  };

  payload.messages = payload.messages.map((msg) => {
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg;

    // Skip types that change on every call
    if (!["code", "text", "markdown"].includes(msg._cf_type)) {
      stats.skippedType++;
      return msg;
    }

    const key = buildMessageKey(msg);
    if (!key) {
      stats.skippedNoKey++;
      return msg;
    }

    stats.checked++;

    const { deduplicated, msg: updatedMsg } = deduplicateMessage(msg, key);

    if (deduplicated) {
      stats.deduplicated++;
      stats.charsSaved += msg.content.length - updatedMsg.content.length;
      if (updatedMsg._dedupSimilarity === 100) {
        stats.exactDups++;
      } else {
        stats.nearDups++;
      }
    }

    return updatedMsg;
  });

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

export { sessionRegistry as dedupRegistry };
