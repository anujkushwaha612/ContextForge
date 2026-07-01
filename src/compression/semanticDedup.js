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
 * What was removed:
 *   - Myers diff / fastLineDiff / formatDeltaForLLM — the delta representation
 *     was consistently larger than the original content (-173% savings in logs).
 *     Near-duplicates now always send a vault stub, which is smaller and gives
 *     the LLM a clear retrieve path. The delta format added complexity with
 *     negative compression benefit.
 *
 * Fixes:
 *   FIX-A: getDynamicThreshold called with bare number → now called with object.
 *   FIX-B: normalizeFilePath src/ prefix stripping (unchanged, was correct).
 *   FIX-C: Near-dup vault stub path (simplified — always stub, never delta).
 *   FIX-D: buildMessageKey null for code messages without filename →
 *           now falls back to content-prefix hash for ALL tagged types.
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
// FIX-D: Was returning null for "code" messages without an extractable
// filename. This caused the no-key count to grow every turn as graph
// query results, read_file_chunk responses, and vault retrieve results
// (all tagged "code") accumulated in history without dedup keys.
//
// Fix: fall back to a content-prefix hash for ALL tagged message types,
// not just "text". The hash is stable across turns for identical content
// and is prefixed with the _cf_type so different types don't collide.
// ─────────────────────────────────────────────

function buildMessageKey(msg) {
  // Priority 1: filename-based key (most stable across turns)
  const filename = extractFilename(msg);
  if (filename) return `file:${filename}`;

  // Priority 2: content-prefix hash for any tagged type
  // FIX-D: Was restricted to _cf_type === "text" only.
  // Now covers "code" and "markdown" too — the types that were producing no-key.
  const cfType = msg._cf_type;
  if (
    cfType &&
    ["code", "text", "markdown"].includes(cfType) &&
    typeof msg.content === "string" &&
    msg.content.length >= 100
  ) {
    // Use first 200 chars as the key basis.
    // This is stable for identical content but will differ if the
    // content changed — which is exactly when we want a different key.
    const prefix = msg.content.slice(0, 200);
    return `${cfType}:` + fnv1a64(prefix);
  }

  return null;
}

// ─────────────────────────────────────────────
// SimHash wrappers
// ─────────────────────────────────────────────

function normalizeForFingerprint(content) {
  return content
    .replace(/cf_vault_[a-f0-9]+/g, "VAULT_ID")
    .replace(/\[CF_COMPRESSED_FILE vault_id:"[^"]+"\]/g, "[CF_COMPRESSED]")
    .replace(/vault_id="[^"]+"/g, 'vault_id="STABLE"');
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
// Dynamic threshold
// ─────────────────────────────────────────────

// FIX-A: Receives { contentLength, fileType } object — not a bare number.
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
// Removed: Myers diff, fastLineDiff, formatDeltaForLLM
//
// These produced delta representations that were consistently LARGER
// than the original content (-173% savings observed in logs). The delta
// format adds headers, context lines, change markers, and vault references
// that inflate the output for small changes.
//
// Replacement: near-duplicates now always send a vault stub.
// The stub is 1 line, the LLM knows how to retrieve it, and the vault
// already holds the original content from the first time we saw this key.
// ─────────────────────────────────────────────

const MIN_DEDUP_CHARS = 500;

async function deduplicateMessage(msg, key) {
  const content = msg.content;
  if (!content || content.length < MIN_DEDUP_CHARS) {
    return { deduplicated: false, msg };
  }

  const existing = sessionRegistry.get(key);

  // ── Fast-path: FNV-1a exact match ────────────────────────────────────
  if (existing?.contentHash) {
    const contentHash = fnv1a64(content);
    if (contentHash === existing.contentHash) {
      if (existing.turnIndex !== sessionRegistry._turnIndex) {
        sessionRegistry.set(key, { ...existing, contentHash });
      }
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

  const distance = fingerprintDistance(fingerprint, existing.fingerprint);
  const similarityPct = Math.round(((64 - distance) / 64) * 100);
  const dynamicThreshold = getDynamicThreshold({ contentLength: content.length });

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

  // ── Near-duplicate (distance === 0 with FNV mismatch, or distance ≤ threshold) ──
  // FIX-C: Always send vault stub. Never send diff.
  // The diff representation was producing negative savings (-173% in logs).
  // The vault already holds the original content — stub is always smaller.
  console.log(
    `[SemanticDedup] 🎯 Near-duplicate: ${key} ` +
      `(distance=${distance}, ${similarityPct}% similar to turn ${existing.turnIndex})`
  );

  // Handle distance === 0 SimHash collision (FNV already confirmed mismatch above)
  if (distance === 0) {
    console.log(
      `[SemanticDedup] 🔀 SimHash collision on ${key}: ` +
        `distance=0 but FNV-1a differs — treating as near-duplicate`
    );
  }

  // Update vault with new content so future retrievals get latest version
  const newVaultId = saveToVault(content);
  sessionRegistry.set(key, {
    fingerprint,
    contentHash: fnv1a64(content),
    vaultId: newVaultId,
    contentLength: content.length,
  });

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

export async function applySemanticDedup(payload) {
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

  const newMessages = [];

  for (const msg of payload.messages) {
    // ── OpenAI format: role:"tool" ────────────────────────────────────────
    if (msg.role === "tool" && typeof msg.content === "string") {
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
      const { deduplicated, msg: updatedMsg } = await deduplicateMessage(msg, key);
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
      for (const block of msg.content) {
        if (block.type === "tool_result" && typeof block.content === "string") {
          if (block._cf_vaulted) {
            newBlocks.push(block);
            continue;
          }
          if (!["code", "text", "markdown"].includes(block._cf_type)) {
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
          const { deduplicated, msg: updatedBlock } = await deduplicateMessage(block, key);
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

  if (stats.checked > 0 || stats.skippedNoKey > 0 || stats.skippedType > 0) {
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
  const normalized = normalizeFilePath(filePath);

  if (!normalized) {
    console.warn(
      `[SemanticDedup] ⚠️ invalidateRegistryEntry: could not normalize "${filePath}" — skipped`
    );
    return false;
  }

  const prefix = `file:${normalized}`;
  let invalidated = 0;

  for (const key of sessionRegistry._seen.keys()) {
    if (key === prefix || key.startsWith(prefix + "|tool:")) {
      sessionRegistry._seen.delete(key);
      console.log(`[SemanticDedup] 🗑️ Registry invalidated: ${key}`);
      invalidated++;
    }
  }

  if (invalidated === 0) {
    console.log(`[SemanticDedup] ℹ️ invalidateRegistryEntry: no entry found for "${normalized}"`);
  }

  return invalidated > 0;
}

export { sessionRegistry as dedupRegistry };
