/**
 * Semantic deduplication for tool results.
 *
 * Design:
 *   For each tool result message, compute a SimHash fingerprint.
 *   If we have seen this key before:
 *     - Exact match (FNV-1a)  → replace with vault stub
 *     - Near-duplicate (SimHash distance ≤ threshold) → replace with vault stub
 *     - Too different (distance > threshold) → update registry, pass through
 *   First time seeing this key → register in session, pass through
 *
 * Fixes applied:
 *   BUG-1: SimHash false negative (distance=0, FNV differs) now correctly
 *           treated as real content change — passes through and updates registry.
 *           Previously logged as "collision" and sent stale vault stub to LLM.
 *
 *   BUG-2: Registry no longer overwritten on near-duplicate. Original anchor
 *           is preserved so future turns compare against the first version,
 *           not a drifting chain of near-dups.
 *
 *   BUG-3: FNV-1a reimplemented as two independent 32-bit lanes (different
 *           seeds, all characters processed in both lanes). Previously h2
 *           skipped odd-indexed characters and shared h1's seed, making it
 *           a subset of h1 rather than an independent hash.
 *
 *   BUG-4: normalizeForFingerprint now strips ISO timestamps, call IDs,
 *           index UUIDs, and size fields that change every turn and caused
 *           false SimHash mismatches on otherwise identical content.
 *
 *   BUG-5: MAX_REGISTRY_SIZE raised from 50 → 200. Eviction strategy
 *           changed from insertion-order (oldest inserted) to LRU
 *           (least recently accessed by turnIndex).
 *
 *   BUG-6: Content-prefix fallback key documented as intentionally unstable
 *           for mutating content. "json" type explicitly excluded from fallback
 *           because graph results are volatile and should not be deduped by prefix.
 *
 *   BUG-7: Dedup threshold split into MIN_EXACT_DEDUP_CHARS (100) for FNV
 *           exact-match path and MIN_NEARDUP_DEDUP_CHARS (500) for SimHash
 *           near-dup path. Short repeated messages (patch confirmations,
 *           error strings) now caught by exact-match dedup.
 *
 *   FIX-A: getDynamicThreshold called with object (unchanged, was correct).
 *   FIX-B: normalizeFilePath src/ prefix stripping (unchanged, was correct).
 *   FIX-C: Near-dup vault stub path (simplified — always stub, never delta).
 *   FIX-D: buildMessageKey falls back to content-prefix hash for code/text/
 *           markdown types. "json" excluded — graph results are volatile.
 */

import { createRequire } from "module";
import path from "path";
import { saveToVault, fetchFromVault } from "../logging/cacheDb.js";
import { statsEmitter } from "../proxy/statsEmitter.js";
import { isRecentToolResult, looksLikeStub } from "./compressionPolicy.js";

const require = createRequire(import.meta.url);
let native;
try {
  native = require(`../../prebuilds/${process.platform}-${process.arch}/contextforge_native.node`);
} catch (e) {
  native = require("../../native/build/Release/contextforge_native.node");
}

// ─────────────────────────────────────────────
// Session registry
// ─────────────────────────────────────────────

// BUG-5 FIX: Raised from 50 → 200. A 30-file workspace with multiple reads
// per file easily exceeds 50 entries mid-session, causing files to be
// evicted and re-registered as "new" — losing all dedup history.
const MAX_REGISTRY_SIZE = 200;

class SessionFileRegistry {
  constructor() {
    this._seen = new Map();
    this._turnIndex = 0;
  }

  incrementTurn() {
    this._turnIndex++;
  }

  get(key) {
    return this._seen.get(key) ?? null;
  }

  // BUG-5 FIX: Eviction changed from insertion-order (oldest inserted key)
  // to LRU (entry with lowest turnIndex = least recently accessed).
  // The oldest-inserted entry is often the most stable anchor (e.g. the
  // first read of package.json or app.js). Evicting it destroys dedup
  // history for the most frequently referenced files.
  set(key, entry) {
    if (!this._seen.has(key) && this._seen.size >= MAX_REGISTRY_SIZE) {
      let oldestKey = null;
      let oldestTurn = Infinity;
      for (const [k, v] of this._seen) {
        if (v.turnIndex < oldestTurn) {
          oldestTurn = v.turnIndex;
          oldestKey = k;
        }
      }
      if (oldestKey) this._seen.delete(oldestKey);
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

// ─────────────────────────────────────────────
// normalizeFilePath
// ─────────────────────────────────────────────

const CWD_PREFIX = path
  .resolve(process.cwd())
  .replace(/\\/g, "/")
  .toLowerCase()
  .replace(/\/?$/, "/");

const STRIP_PREFIXES = ["src/"];

function normalizeFilePath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;

  let p = rawPath.trim();
  if (p.length === 0 || p.length > 300) return null;

  const extMatch = p.match(/\.(\w+)$/);
  if (!extMatch) return null;
  const ext = extMatch[1].toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) return null;

  p = p.replace(/\\/g, "/").toLowerCase();

  if (p.startsWith(CWD_PREFIX)) {
    p = p.slice(CWD_PREFIX.length);
  }

  p = p.replace(/^[a-z]:\//i, "");
  p = p
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");

  for (const prefix of STRIP_PREFIXES) {
    if (p.startsWith(prefix)) {
      p = p.slice(prefix.length);
      break;
    }
  }

  return p.length > 0 ? p : null;
}

// ─────────────────────────────────────────────
// buildMessageKey
//
// FIX-D: Falls back to content-prefix hash for code/text/markdown types.
//
// BUG-6 NOTE: The content-prefix fallback key is intentionally unstable
// for content whose header changes every turn (generated output, error
// messages with timestamps). This is acceptable — such content will be
// re-registered each turn as a new entry rather than incorrectly deduped.
//
// "json" type is explicitly excluded from the fallback. Graph query results
// are tagged "json" and are highly volatile (different symbols, different
// turn context). Deduping them by prefix would cause false hits where two
// different graph queries that happen to start with the same JSON prefix
// are treated as duplicates.
// ─────────────────────────────────────────────

function buildMessageKey(msg) {
  // Priority 1: filename-based key (most stable across turns)
  const filename = extractFilename(msg);
  if (filename) return `file:${filename}`;

  // Priority 2: content-prefix hash for stable tagged types only.
  // Explicitly excludes "json" — graph results are volatile.
  const cfType = msg._cf_type;
  if (
    cfType &&
    ["code", "text", "markdown"].includes(cfType) &&
    typeof msg.content === "string" &&
    msg.content.length >= 100
  ) {
    const prefix = msg.content.slice(0, 200);
    return `${cfType}:` + fnv1a64(prefix);
  }

  return null;
}

// ─────────────────────────────────────────────
// SimHash wrappers
// ─────────────────────────────────────────────

// BUG-4 FIX: Added normalization for ISO timestamps, call IDs, index UUIDs,
// and size fields. These change every turn on otherwise identical content,
// causing SimHash to report false mismatches (fingerprint distance > 0 on
// content that is semantically identical).
function normalizeForFingerprint(content) {
  return (
    content
      // Existing normalizations
      .replace(/cf_vault_[a-f0-9]+/g, "VAULT_ID")
      .replace(/\[CF_COMPRESSED_FILE vault_id:"[^"]+"\]/g, "[CF_COMPRESSED]")
      .replace(/vault_id="[^"]+"/g, 'vault_id="STABLE"')
      // New normalizations (BUG-4)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "TIMESTAMP")
      .replace(/call_cf_\d+_\d+/g, "CALL_ID")
      .replace(/IDX_[0-9a-f-]{36}/g, "IDX_ID")
      .replace(/"size":\s*\d+/g, '"size": SIZE')
      .replace(/"lastPatchedAt":\s*"[^"]+"/g, '"lastPatchedAt": TIMESTAMP')
      .replace(/\bat\s+\d{2}:\d{2}:\d{2}\b/g, "at TIMESTAMP")
  );
}

function computeFingerprint(text) {
  try {
    const normalized = normalizeForFingerprint(text);
    return native.simhash(normalized);
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
// FNV-1a 64-bit (two independent 32-bit lanes)
//
// BUG-3 FIX: Previous implementation had two critical flaws:
//   1. h2 used the same seed (0x811c9dc5) as h1 — not independent
//   2. h2 only processed even-indexed characters (i % 2 === 0) —
//      two strings differing only at odd positions had identical h2,
//      dramatically increasing the effective collision rate.
//
// Fix: Two independent seeds, both lanes process every character.
// h1 seed: standard FNV-1a 32-bit offset basis (0x811c9dc5)
// h2 seed: different value (0x4b9ace2f) for independence
// Both use the standard FNV-1a 32-bit prime (0x01000193)
// Output: zero-padded hex strings concatenated to form a 64-bit key
// ─────────────────────────────────────────────

function fnv1a64(str) {
  let h1 = 0x811c9dc5; // FNV-1a 32-bit offset basis
  let h2 = 0x4b9ace2f; // Independent seed for second lane

  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);

    // Both lanes process every character — no skipping
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;

    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }

  // Zero-pad to 8 hex chars each so hash length is stable
  return `${h1.toString(16).padStart(8, "0")}_${h2.toString(16).padStart(8, "0")}`;
}

// ─────────────────────────────────────────────
// Dynamic threshold
// ─────────────────────────────────────────────

function getDynamicThreshold({ contentLength }) {
  if (contentLength > 200_000) return 24;
  if (contentLength > 100_000) return 20;
  if (contentLength > 50_000) return 16;
  if (contentLength > 20_000) return 12;
  return 14;
}

// ─────────────────────────────────────────────
// Core deduplication
//
// BUG-7 FIX: Threshold split into two values:
//   MIN_EXACT_DEDUP_CHARS = 100  → FNV-1a exact-match path
//   MIN_NEARDUP_DEDUP_CHARS = 500 → SimHash near-dup path
//
// Rationale: SimHash is unreliable on short strings (< 500 chars) because
// the bit distribution is sparse and small edits can flip many bits,
// producing false distances. But exact-match dedup via FNV-1a is reliable
// at any length. Lowering the exact-match threshold catches repeated short
// messages (patch confirmations, error strings) that were previously skipped.
//
// BUG-1 FIX: SimHash distance=0 with FNV mismatch is now correctly handled
// as a SimHash false negative (content changed but fingerprint didn't).
// Previously this path logged "collision" and sent a stale vault stub,
// causing the LLM to work on an outdated version of an actively edited file.
//
// BUG-2 FIX: Registry is NOT overwritten on genuine near-duplicates.
// The original anchor is preserved so future turns compare against the
// first version of the content, not a drifting chain of near-dups.
// ─────────────────────────────────────────────

const MIN_EXACT_DEDUP_CHARS = 100;
const MIN_NEARDUP_DEDUP_CHARS = 500;

// F2 NOTE: legacy cross-request dedup path. Superseded by dedupKeepNewest()
// inside applySemanticDedup (keep-newest invariant). Retained (unused) for
// reference during the transition; safe to delete after v1 ships.
// eslint-disable-next-line no-unused-vars
async function deduplicateMessage(msg, key) {
  const content = msg.content;

  // Below minimum for any dedup — skip entirely
  if (!content || content.length < MIN_EXACT_DEDUP_CHARS) {
    return { deduplicated: false, msg };
  }

  const existing = sessionRegistry.get(key);

  // ── Fast-path: FNV-1a exact match ────────────────────────────────────
  // Runs on any content >= MIN_EXACT_DEDUP_CHARS (includes short messages)
  if (existing?.contentHash) {
    const contentHash = fnv1a64(content);
    if (contentHash === existing.contentHash) {
      // Update turnIndex so LRU eviction knows this entry was recently used
      sessionRegistry.set(key, { ...existing, contentHash });
      const tokensSaved = Math.round(content.length / 4);
      statsEmitter.recordCacheHit("semanticDedup", true);
      return {
        deduplicated: true,
        msg: {
          ...msg,
          _cf_deduped: true,
          content: `[CF_VAULT:${existing.vaultId}] (identical to turn ${existing.turnIndex}, ~${tokensSaved} tokens)`,
          _dedupVaultId: existing.vaultId,
          _dedupSimilarity: 100,
        },
      };
    }
  }

  // ── Below near-dup threshold — register for exact matching only ───────
  // SimHash is unreliable on short content. Register the entry so future
  // exact matches are caught, but do not attempt near-dup classification.
  if (content.length < MIN_NEARDUP_DEDUP_CHARS) {
    if (!existing) {
      const vaultId = saveToVault(content);
      sessionRegistry.set(key, {
        fingerprint: null, // no fingerprint — too short for SimHash
        contentHash: fnv1a64(content),
        vaultId,
        contentLength: content.length,
      });
      statsEmitter.recordCacheHit("semanticDedup", false);
    } else {
      // Content changed (FNV mismatch above) — update registry
      const vaultId = saveToVault(content);
      sessionRegistry.set(key, {
        fingerprint: null,
        contentHash: fnv1a64(content),
        vaultId,
        contentLength: content.length,
      });
    }
    return { deduplicated: false, msg };
  }

  // ── SimHash near-dup path (content >= MIN_NEARDUP_DEDUP_CHARS) ────────
  const fingerprint = computeFingerprint(content);
  if (fingerprint === null) return { deduplicated: false, msg };

  // ── First time seeing this key ────────────────────────────────────────
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
        `(${Math.round(content.length / 4)} tokens → vault ${vaultId})`
    );
    return { deduplicated: false, msg };
  }

  // ── Existing entry has no fingerprint (was registered below threshold) ─
  // Content grew above threshold — re-register with fingerprint
  if (!existing.fingerprint) {
    const vaultId = saveToVault(content);
    sessionRegistry.set(key, {
      fingerprint,
      contentHash: fnv1a64(content),
      vaultId,
      contentLength: content.length,
    });
    return { deduplicated: false, msg };
  }

  const distance = fingerprintDistance(fingerprint, existing.fingerprint);
  const similarityPct = Math.round(((64 - distance) / 64) * 100);
  const dynamicThreshold = getDynamicThreshold({ contentLength: content.length });

  // ── BUG-1 FIX: SimHash false negative ────────────────────────────────
  // distance=0 means SimHash says "identical" but FNV already confirmed
  // the content IS different (we only reach here after FNV mismatch above).
  //
  // This is a SimHash false negative — the 64-bit fingerprint lacks the
  // resolution to detect this particular change. FNV-1a is exact and
  // must be trusted. Treat as a real content change: update registry and
  // pass through so the LLM receives the current version of the content.
  //
  // Do NOT send a vault stub here. The vault holds the old version.
  // Sending that stub would cause the LLM to retrieve stale content for
  // a file it is actively modifying — the root cause of the repeated
  // "SimHash collision" log entries seen every turn in long agentic sessions.
  if (distance === 0) {
    const vaultId = saveToVault(content);
    sessionRegistry.set(key, {
      fingerprint,
      contentHash: fnv1a64(content),
      vaultId,
      contentLength: content.length,
    });
    // Log at debug level only — this is expected behavior, not an error
    if (process.env.CF_DEBUG_DEDUP === "1") {
      console.log(
        `[SemanticDedup] 🔄 Content changed (SimHash blind spot): ${key} — updating registry`
      );
    }
    return { deduplicated: false, msg };
  }

  // ── Sufficiently different — update registry, pass through ────────────
  if (distance > dynamicThreshold) {
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

  // ── Genuine near-duplicate (distance > 0 and distance ≤ threshold) ───
  // FIX-C: Always send vault stub. Never send diff.
  //
  // BUG-2 FIX: Do NOT overwrite the registry entry. Preserve the original
  // anchor so future turns compare against the first version of the content,
  // not a drifting chain where each near-dup becomes the new reference.
  //
  // We save the new content to a NEW vault ID so the LLM can retrieve
  // the current version if needed. But the registry keeps the original
  // fingerprint and hash as the stable comparison anchor.
  console.log(
    `[SemanticDedup] 🎯 Near-duplicate: ${key} ` +
      `(distance=${distance}, ${similarityPct}% similar to turn ${existing.turnIndex})`
  );

  const newVaultId = saveToVault(content);

  // BUG-2 FIX: sessionRegistry.set() intentionally NOT called here.
  // The existing entry remains as the stable anchor for future comparisons.

  statsEmitter.recordCacheHit("semanticDedup", true);

  return {
    deduplicated: true,
    msg: {
      ...msg,
      _cf_deduped: true,
      content: `[CF_VAULT:${newVaultId}] (${similarityPct}% similar to turn ${existing.turnIndex})`,
      _dedupVaultId: newVaultId,
      _dedupSimilarity: similarityPct,
    },
  };
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

/**
 * F2 REWRITE — "keep newest, stub oldest".
 *
 * The client (Claude Code) resends the FULL conversation every request;
 * our transformations are per-request and never persist into the client's
 * history. Under the old design ("register first occurrence, stub later
 * ones"), on any request after the first, EVERY occurrence of a file
 * matched the registry and got stubbed — leaving the model with zero full
 * copies in context. Combined with AST compression, this produced the
 * observed pointer-chains: "[CF_VAULT:...] identical to turn 3" where turn
 * 3 itself was "[CF_COMPRESSED_FILE ...]".
 *
 * New invariant: for each dedup key, the NEWEST occurrence in the current
 * payload always passes through full; OLDER occurrences that are exact or
 * near duplicates of it are stubbed. Exactly one full copy per file per
 * request, and it's always the most current one.
 *
 * The session registry is kept for vault reuse + stats, but correctness no
 * longer depends on cross-request state.
 */
export async function applySemanticDedup(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  const policy = payload.__policy ?? null;
  if (policy && policy.dedupEnabled === false) return payload;

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

  // ── F2 pre-pass: locate the NEWEST occurrence of each dedup key ────────
  // (iterating forward and overwriting leaves the last occurrence in the map)
  const DEDUPABLE = ["code", "text", "markdown"];

  /**
   * SD-FIX: Fallback type detection for messages whose _cf_type was stripped
   * by the client adapter during the round-trip. If the message has a
   * recognizable file path with a source extension, treat it as dedupable
   * regardless of the _cf_type field. This fixes the persistent "Skipped: N
   * wrong-type" log lines where read_file_chunk results (which ARE file content)
   * were being incorrectly excluded from dedup because _cf_type was undefined.
   */
  function isDedupableType(msg) {
    if (DEDUPABLE.includes(msg._cf_type)) return true;
    const filename = extractFilename(msg);
    if (filename) {
      const ext = filename.split(".").pop()?.toLowerCase();
      if (ext && SOURCE_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }

  const newestByKey = new Map();
  for (let mi = 0; mi < payload.messages.length; mi++) {
    const m = payload.messages[mi];
    if (m.role === "tool" && typeof m.content === "string" && isDedupableType(m)) {
      const k = buildMessageKey(m);
      if (k) newestByKey.set(k, { mi, bi: -1, content: m.content });
    } else if (m.role === "user" && Array.isArray(m.content)) {
      for (let bi = 0; bi < m.content.length; bi++) {
        const b = m.content[bi];
        if (b?.type === "tool_result" && typeof b.content === "string" && isDedupableType(b)) {
          const k = buildMessageKey(b);
          if (k) newestByKey.set(k, { mi, bi, content: b.content });
        }
      }
    }
  }

  /**
   * F2 core: dedup an occurrence AGAINST THE NEWEST occurrence in this
   * payload (not against cross-request registry state).
   *   - the newest occurrence itself always passes through full
   *   - recent messages (age gate) always pass through
   *   - F3: if the newest copy is itself a stub, nothing dedups against it
   *   - older occurrences stub only on exact/near match with the newest
   */
  async function dedupKeepNewest(msg, key, msgIndex, blockIndex = -1) {
    const newest = newestByKey.get(key);
    const isNewest = newest && newest.mi === msgIndex && newest.bi === blockIndex;

    // Register the newest copy in the session registry (vault reuse + stats).
    if (isNewest) {
      const existing = sessionRegistry.get(key);
      const contentHash = fnv1a64(msg.content);
      if (!existing || existing.contentHash !== contentHash) {
        const vaultId = saveToVault(msg.content); // content-hash dedup inside
        sessionRegistry.set(key, {
          fingerprint:
            msg.content.length >= MIN_NEARDUP_DEDUP_CHARS ? computeFingerprint(msg.content) : null,
          contentHash,
          vaultId,
          contentLength: msg.content.length,
        });
        console.log(
          `[SemanticDedup] 📝 Registered: ${key} ` +
            `(${Math.round(msg.content.length / 4)} tokens → vault ${sessionRegistry.get(key).vaultId})`
        );
      }
      return { deduplicated: false, msg };
    }

    // F1: age gate — content the model hasn't acted on yet stays readable.
    if (isRecentToolResult(payload.messages, msgIndex, policy)) {
      return { deduplicated: false, msg };
    }

    // F3: never dedup toward a stub — the pointer would dangle.
    if (!newest || looksLikeStub(newest.content)) {
      return { deduplicated: false, msg };
    }

    const content = msg.content;
    if (!content || content.length < MIN_EXACT_DEDUP_CHARS) {
      return { deduplicated: false, msg };
    }

    // Exact match with the newest copy → stub this older one.
    if (fnv1a64(content) === fnv1a64(newest.content)) {
      const vaultId = saveToVault(content);
      statsEmitter.recordCacheHit("semanticDedup", true);
      return {
        deduplicated: true,
        msg: {
          ...msg,
          _cf_deduped: true,
          content:
            `[CF_VAULT:${vaultId}] (identical to the current copy of this file ` +
            `shown later in this conversation, ~${Math.round(content.length / 4)} tokens)`,
          _dedupVaultId: vaultId,
          _dedupSimilarity: 100,
        },
      };
    }

    // Near-dup with the newest copy → stub; the newest (still full) is the
    // authoritative version, so pointing at it is always safe.
    if (
      content.length >= MIN_NEARDUP_DEDUP_CHARS &&
      newest.content.length >= MIN_NEARDUP_DEDUP_CHARS
    ) {
      const fp = computeFingerprint(content);
      const newestFp = computeFingerprint(newest.content);
      if (fp !== null && newestFp !== null) {
        const distance = fingerprintDistance(fp, newestFp);
        const threshold = getDynamicThreshold({ contentLength: content.length });
        // NOTE: distance === 0 with differing FNV is a SimHash blind spot
        // (legacy BUG-1). Under keep-newest it is SAFE to stub the older
        // copy anyway: the authoritative full version is present later in
        // this same payload, so no stale-retrieval risk exists.
        if (distance <= threshold) {
          const similarityPct = Math.round(((64 - distance) / 64) * 100);
          const vaultId = saveToVault(content);
          console.log(
            `[SemanticDedup] 🎯 Superseded: ${key} ` +
              `(older copy, ${similarityPct}% similar to the current version below)`
          );
          statsEmitter.recordCacheHit("semanticDedup", true);
          return {
            deduplicated: true,
            msg: {
              ...msg,
              _cf_deduped: true,
              content:
                `[CF_VAULT:${vaultId}] (outdated copy — ${similarityPct}% similar to the ` +
                `current version of this file shown later in this conversation)`,
              _dedupVaultId: vaultId,
              _dedupSimilarity: similarityPct,
            },
          };
        }
      }
    }

    return { deduplicated: false, msg };
  }

  const newMessages = [];

  for (let msgIndex = 0; msgIndex < payload.messages.length; msgIndex++) {
    const msg = payload.messages[msgIndex];
    // ── OpenAI format: role:"tool" ────────────────────────────────────────
    if (msg.role === "tool" && typeof msg.content === "string") {
      if (msg._cf_vaulted) {
        newMessages.push(msg);
        continue;
      }
      if (msg._cf_pruned) {
        newMessages.push(msg);
        continue;
      }
      // ✅ Issue 3 FIX: Guard _cf_editable on OpenAI path.
      // This flag is set by tagToolResults for targeted read_file_chunk
      // results (≤800 lines). These are verification reads immediately
      // after a patch — deduping them returns stale pre-patch content
      // to the LLM, making patch verification impossible.
      // The Anthropic format path already had this guard — this was
      // the missing symmetric check on the OpenAI path.
      if (msg._cf_editable) {
        newMessages.push(msg);
        continue;
      }

      if (!isDedupableType(msg)) {
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
      const { deduplicated, msg: updatedMsg } = await dedupKeepNewest(msg, key, msgIndex);
      if (deduplicated) {
        stats.deduplicated++;
        stats.charsSaved += msg.content.length - updatedMsg.content.length;
        if (updatedMsg._dedupSimilarity === 100) stats.exactDups++;
        else stats.nearDups++;
      }
      newMessages.push(updatedMsg);
      continue;
    }

    // ── Anthropic format: role:"user" with tool_result blocks ────────────
    if (msg.role === "user" && Array.isArray(msg.content)) {
      let modified = false;
      const newBlocks = [];
      for (let m_bi = 0; m_bi < msg.content.length; m_bi++) {
        const block = msg.content[m_bi];
        if (block.type === "tool_result" && typeof block.content === "string") {
          if (block._cf_vaulted) {
            newBlocks.push(block);
            continue;
          }
          if (block._cf_editable) {
            newBlocks.push(block);
            continue;
          } // ← NEW
          if (!isDedupableType(block)) {
            stats.skippedType++;
            newBlocks.push(block);
            continue;
          }
          const key = buildMessageKey(block);
          if (!key) {
            stats.skippedNoKey++;
            newBlocks.push(block);
            continue;
          }
          stats.checked++;
          const { deduplicated, msg: updatedBlock } = await dedupKeepNewest(
            block,
            key,
            msgIndex,
            m_bi
          );
          if (deduplicated) {
            stats.deduplicated++;
            stats.charsSaved += block.content.length - updatedBlock.content.length;
            if (updatedBlock._dedupSimilarity === 100) stats.exactDups++;
            else stats.nearDups++;
            modified = true;
          }
          newBlocks.push(updatedBlock);
        } else {
          newBlocks.push(block);
        }
      }
      newMessages.push(modified ? { ...msg, content: newBlocks } : msg);
      continue;
    }

    newMessages.push(msg);
  }

  payload.messages = newMessages;

  if (stats.checked > 0 || stats.deduplicated > 0 || process.env.CF_DEBUG_DEDUP === "1") {
    console.log(
      `[SemanticDedup] Checked ${stats.checked} | ` +
        `Deduped ${stats.deduplicated} ` +
        `(${stats.exactDups} exact, ${stats.nearDups} near-dup) | ` +
        `Chars saved: ${stats.charsSaved} (~${Math.floor(stats.charsSaved / 4)} tokens) | ` +
        `Skipped: ${stats.skippedType} wrong-type, ${stats.skippedNoKey} no-key`
    );
  }

  return payload;
}

// ─────────────────────────────────────────────
// invalidateRegistryEntry
// ─────────────────────────────────────────────

export function invalidateRegistryEntry(filePath) {
  if (!filePath || typeof filePath !== "string") return false;

  // Try exact normalized match first
  const normalized = normalizeFilePath(filePath);

  // Extract basename as fallback — handles cases where the LLM passes
  // an absolute path but the registry was built from a relative path,
  // or vice versa. Also catches typos in directory segments since the
  // filename itself is rarely misspelled.
  const basename = filePath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";

  if (!normalized && !basename) {
    console.warn(
      `[SemanticDedup] ⚠️ invalidateRegistryEntry: could not normalize "${filePath}" — skipped`
    );
    return false;
  }

  let invalidated = 0;

  for (const key of sessionRegistry._seen.keys()) {
    if (!key.startsWith("file:")) continue;

    const keyPath = key.slice(5); // strip "file:" prefix
    const keyBasename = keyPath.split("/").pop() ?? "";

    const exactMatch = normalized && keyPath === normalized;
    const basenameMatch = basename && keyBasename === basename;

    if (exactMatch || basenameMatch) {
      sessionRegistry._seen.delete(key);
      console.log(`[SemanticDedup] 🗑️ Registry invalidated: ${key}`);
      invalidated++;
    }
  }

  if (invalidated === 0 && process.env.CF_DEBUG_DEDUP === "1") {
    console.log(
      `[SemanticDedup] ℹ️ invalidateRegistryEntry: no entry found for "${normalized ?? basename}"`
    );
  }

  return invalidated > 0;
}

export { sessionRegistry as dedupRegistry };
