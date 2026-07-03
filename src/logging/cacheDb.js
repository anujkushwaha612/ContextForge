/**
 * cacheDb.js — FIXED VERSION
 *
 * Fixes applied (CD-1 … CD-9), each verified against a live better-sqlite3 DB:
 *
 *   CD-1  DB path: CF_DATA_DIR env respected (set by the CLI daemon to
 *         ~/.contextforge/data/<workspace-hash>/), fallback to legacy
 *         ../data/. Directory is created if missing — previously a fresh
 *         clone threw "unable to open database file" at import.
 *
 *   CD-2  saveToCache: INSERT OR IGNORE + UNIQUE state_hash returned a
 *         phantom id on duplicate (changes === 0) — subsequent
 *         registerDependency(phantomId) threw FK constraint at request time.
 *         Now returns the EXISTING row's id on dedup.
 *
 *   CD-3  saveChunksWithVectors: inserted vault ids into cache_vector_labels
 *         whose FK points at semantic_cache → ALWAYS threw FK constraint,
 *         rolling back the whole transaction (vault + chunks silently lost).
 *         Labels now go to a dedicated vault_vector_labels table.
 *
 *   CD-4  saveChunksWithVectors / saveChunksToVault: plain INSERTs threw
 *         UNIQUE constraint when re-saving a deduped vault. Vault insert is
 *         now OR IGNORE, chunk insert OR REPLACE (idempotent re-vaulting).
 *
 *   CD-5  Index added on cache_dependencies(resource_path) — invalidateByFile
 *         was a full table scan (PK leads with cache_id), and it runs on
 *         every file-watcher event.
 *
 *   CD-6  searchChunksByKeyword: % and _ in the keyword acted as wildcards.
 *         Escaped via ESCAPE '\'.
 *
 *   CD-7  fetchChunksByIds: batched at 500 ids (SQLite bound-variable limit
 *         is 999 in common builds); per-size statement cache instead of
 *         re-preparing on every call.
 *
 *   CD-8  Redundant idx_cache_state_hash removed (UNIQUE already indexes).
 *
 *   CD-9  fullReset also clears vault_vector_labels; fetchNeighborChunks /
 *         getChunkStats statements prepared once at module level.
 */

import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CD-1: CLI-managed data dir wins; legacy repo-local path as fallback.
const DATA_DIR = process.env.CF_DATA_DIR || path.join(__dirname, "../data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "contextforge.db"));

// CRITICAL: Enable foreign keys for CASCADE DELETE and WAL mode for concurrency
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS semantic_cache (
    id TEXT PRIMARY KEY,
    state_hash TEXT UNIQUE, -- UNIQUE implies an index (CD-8: no extra index needed)
    query_text TEXT,
    response_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cache_dependencies (
    cache_id TEXT,
    resource_path TEXT,
    resource_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (cache_id, resource_path),
    FOREIGN KEY (cache_id) REFERENCES semantic_cache(id) ON DELETE CASCADE
  )
`);

// CD-5: invalidateByFile filters on resource_path — PK leads with cache_id,
// so without this index every file-watcher event caused a full scan.
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_cache_deps_resource_path ON cache_dependencies(resource_path)`
);

db.exec(`
  CREATE TABLE IF NOT EXISTS cache_vector_labels (
    cache_id TEXT PRIMARY KEY,
    vector_label INTEGER,
    FOREIGN KEY (cache_id) REFERENCES semantic_cache(id) ON DELETE CASCADE
  )
`);

// CD-3: labels for VAULTS live here (cache_vector_labels FKs to semantic_cache,
// so vault ids can never be stored there — that insert always threw).
db.exec(`
  CREATE TABLE IF NOT EXISTS vault_vector_labels (
    vault_id TEXT NOT NULL,
    vector_label INTEGER NOT NULL,
    PRIMARY KEY (vault_id, vector_label),
    FOREIGN KEY (vault_id) REFERENCES prune_vault(vault_id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS prune_vault (
    vault_id TEXT PRIMARY KEY,
    dropped_text TEXT,
    content_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_prune_vault_content_hash ON prune_vault(content_hash)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS vault_chunks (
    chunk_id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    chunk_text TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    token_estimate INTEGER NOT NULL,
    vector BLOB,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vault_id) REFERENCES prune_vault(vault_id) ON DELETE CASCADE
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_chunks_vault_id ON vault_chunks(vault_id)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS diff_compression_cache (
    hash_key TEXT PRIMARY KEY,
    kept_text TEXT,
    vault_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- Prepared statements ---
const wipeSemanticCache = db.prepare(`DELETE FROM semantic_cache`);

const getCacheByHash = db.prepare(`SELECT response_text FROM semantic_cache WHERE state_hash = ?`);
// CD-2: needed to return the real id on dedup
const getCacheIdByHash = db.prepare(`SELECT id FROM semantic_cache WHERE state_hash = ?`);

const insertCacheWithHash = db.prepare(`
  INSERT OR IGNORE INTO semantic_cache (id, state_hash, query_text, response_text)
  VALUES (?, ?, ?, ?)
`);
const getCache = db.prepare(`SELECT response_text FROM semantic_cache WHERE id = ?`);
// CD-4: OR IGNORE — re-vaulting a deduped id is a no-op, not a throw
const insertVault = db.prepare(
  `INSERT OR IGNORE INTO prune_vault (vault_id, dropped_text, content_hash) VALUES (?, ?, ?)`
);
const getVault = db.prepare(`SELECT dropped_text FROM prune_vault WHERE vault_id = ?`);

const getVaultByHash = db.prepare(
  `SELECT vault_id FROM prune_vault WHERE content_hash = ? LIMIT 1`
);

const insertDependency = db.prepare(
  `INSERT OR IGNORE INTO cache_dependencies (cache_id, resource_path, resource_hash) VALUES (?, ?, ?)`
);
const insertVectorLabel = db.prepare(
  `INSERT OR REPLACE INTO cache_vector_labels (cache_id, vector_label) VALUES (?, ?)`
);
// CD-3
const insertVaultVectorLabel = db.prepare(
  `INSERT OR IGNORE INTO vault_vector_labels (vault_id, vector_label) VALUES (?, ?)`
);
const getVaultVectorLabels = db.prepare(
  `SELECT vector_label FROM vault_vector_labels WHERE vault_id = ?`
);

const findStaleEntries = db.prepare(`
  SELECT DISTINCT d.cache_id, v.vector_label
  FROM cache_dependencies d
  LEFT JOIN cache_vector_labels v ON d.cache_id = v.cache_id
  WHERE d.resource_path = ? AND d.resource_hash != ?
`);

const findAllEntriesForFile = db.prepare(`
  SELECT DISTINCT d.cache_id, v.vector_label
  FROM cache_dependencies d
  LEFT JOIN cache_vector_labels v ON d.cache_id = v.cache_id
  WHERE d.resource_path = ?
`);

const deleteCacheEntry = db.prepare(`DELETE FROM semantic_cache WHERE id = ?`);
const insertDiff = db.prepare(
  `INSERT OR REPLACE INTO diff_compression_cache (hash_key, kept_text, vault_id) VALUES (?, ?, ?)`
);
const getDiff = db.prepare(
  `SELECT kept_text, vault_id FROM diff_compression_cache WHERE hash_key = ?`
);

// CD-4: OR REPLACE — idempotent when chunks for a deduped vault are re-saved
const insertVaultChunk = db.prepare(`
  INSERT OR REPLACE INTO vault_chunks (chunk_id, vault_id, chunk_text, chunk_index, token_estimate, vector)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const getVaultChunks = db.prepare(`
  SELECT chunk_id, chunk_text, chunk_index, token_estimate, vector
  FROM vault_chunks WHERE vault_id = ? ORDER BY chunk_index ASC
`);

const getVaultMetadata = db.prepare(`
  SELECT COUNT(*) as chunk_count, SUM(token_estimate) as total_tokens
  FROM vault_chunks WHERE vault_id = ?
`);

// --- EXPORTED FUNCTIONS ---
export const fetchFromCacheByHash = (stateHash) => {
  const row = getCacheByHash.get(stateHash);
  return row ? row.response_text : null;
};

export const resetEntireCache = (cPP_Cache) => {
  // Wipes semantic cache only (CASCADE cleans dependencies + labels).
  // Vaults/chunks survive — use fullReset() to wipe everything.
  wipeSemanticCache.run();

  if (cPP_Cache) {
    cPP_Cache.clearAll();
  }
  return true;
};

export const saveToCache = (queryText, responseText, stateHash = null) => {
  const id = "RES_" + crypto.randomUUID();
  const info = insertCacheWithHash.run(id, stateHash, queryText, responseText);

  // CD-2: duplicate state_hash → OR IGNORE dropped the insert. Returning the
  // fresh id anyway made registerDependency(phantomId) throw FK constraint.
  // Return the EXISTING entry's id so dependencies attach to a real row.
  if (info.changes === 0 && stateHash !== null) {
    const existing = getCacheIdByHash.get(stateHash);
    if (existing) return existing.id;
  }
  return id;
};

export const fetchFromCache = (id) => {
  const row = getCache.get(id);
  return row ? row.response_text : null;
};

export const registerDependency = (cacheId, resourcePath, resourceHash) => {
  insertDependency.run(cacheId, resourcePath, resourceHash);
};

export const registerVectorLabel = (cacheId, vectorLabel) => {
  insertVectorLabel.run(cacheId, vectorLabel);
};

export const invalidateByFile = (filePath, newHash = null, cPP_Cache = null) => {
  let rows;
  if (newHash) {
    rows = findStaleEntries.all(filePath, newHash);
  } else {
    rows = findAllEntriesForFile.all(filePath);
  }

  if (rows.length === 0) return { deletedIds: [], vectorLabels: [] };

  const deletedIds = [];
  const vectorLabels = [];

  for (const row of rows) {
    deleteCacheEntry.run(row.cache_id);
    deletedIds.push(row.cache_id);
    if (row.vector_label !== null && row.vector_label !== undefined) {
      vectorLabels.push(row.vector_label);
      if (cPP_Cache) {
        cPP_Cache.invalidate(row.vector_label);
      }
    }
  }
  return { deletedIds, vectorLabels };
};

export const saveToVault = (droppedText) => {
  const contentHash = crypto.createHash("sha256").update(droppedText).digest("hex").slice(0, 16);

  const existing = getVaultByHash.get(contentHash);
  if (existing) {
    console.log(
      `[Fat Catch] ♻️  Dedup hit — reusing vault ${existing.vault_id} (hash: ${contentHash})`
    );
    return existing.vault_id;
  }

  const id = "cf_vault_" + crypto.randomBytes(4).toString("hex");
  insertVault.run(id, droppedText, contentHash);
  return id;
};

export const lookupVaultByContent = (text) => {
  if (!text || typeof text !== "string") return null;
  const contentHash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  const existing = getVaultByHash.get(contentHash);
  return existing ? existing.vault_id : null;
};

export const saveChunksToVault = (vaultId, chunks) => {
  const insertMany = db.transaction((chunksArray) => {
    for (const chunk of chunksArray) {
      const chunkId = `${vaultId}_chunk_${chunk.index}`;
      const vectorBlob = chunk.vector ? Buffer.from(new Float32Array(chunk.vector).buffer) : null;
      insertVaultChunk.run(
        chunkId,
        vaultId,
        chunk.text,
        chunk.index,
        chunk.tokenEstimate,
        vectorBlob
      );
    }
  });
  insertMany(chunks);
};

export const fetchVaultChunks = (vaultId) => {
  const rows = getVaultChunks.all(vaultId);
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    text: row.chunk_text,
    index: row.chunk_index,
    tokenEstimate: row.token_estimate,
    vector: row.vector ? new Float32Array(new Uint8Array(row.vector).buffer) : null,
  }));
};

export const getVaultStats = (vaultId) => {
  return getVaultMetadata.get(vaultId);
};

export const fetchFromVault = (id) => {
  const row = getVault.get(id);
  return row ? row.dropped_text : null;
};

export const getCachedCompression = (messageContent, queryText) => {
  const hash = crypto
    .createHash("sha256")
    .update(messageContent + "|||" + queryText)
    .digest("hex");
  const row = getDiff.get(hash);
  return row ? { keptText: row.kept_text, vaultId: row.vault_id, hash } : { hash };
};

export const saveCachedCompression = (hash, keptText, vaultId) => {
  insertDiff.run(hash, keptText, vaultId);
};

// ==========================================
// HYBRID RAG: BM25 + HNSW RETRIEVAL METHODS
// ==========================================

const getChunkById = db.prepare(`
  SELECT chunk_id, chunk_text, vault_id, chunk_index, token_estimate
  FROM vault_chunks WHERE chunk_id = ?
`);

const searchChunksByVault = db.prepare(`
  SELECT chunk_id, chunk_text, vault_id, chunk_index, token_estimate
  FROM vault_chunks
  WHERE vault_id = ?
  ORDER BY chunk_index ASC
`);

// CD-6: ESCAPE clause so % and _ in keywords are literal
const searchChunksByText = db.prepare(`
  SELECT chunk_id, chunk_text, vault_id, chunk_index, token_estimate
  FROM vault_chunks
  WHERE chunk_text LIKE ? ESCAPE '\\'
  ORDER BY vault_id, chunk_index ASC
  LIMIT ?
`);

const getTotalChunkCount = db.prepare(`
  SELECT COUNT(*) as count FROM vault_chunks
`);
const getVaultCount = db.prepare(`SELECT COUNT(*) as count FROM prune_vault`);
const getCacheCount = db.prepare(`SELECT COUNT(*) as count FROM semantic_cache`);

const deleteChunksByVault = db.prepare(`
  DELETE FROM vault_chunks WHERE vault_id = ?
`);

// CD-9: prepared once, not per call
const getNeighborChunksStmt = db.prepare(`
  SELECT chunk_id, chunk_text, vault_id, chunk_index, token_estimate
  FROM vault_chunks
  WHERE vault_id = ?
    AND chunk_index >= ?
    AND chunk_index <= ?
  ORDER BY chunk_index ASC
`);

const mapChunkRow = (row) => ({
  chunkId: row.chunk_id,
  text: row.chunk_text,
  vaultId: row.vault_id,
  index: row.chunk_index,
  tokenEstimate: row.token_estimate,
});

export const fetchChunkById = (chunkId) => {
  const row = getChunkById.get(chunkId);
  return row ? mapChunkRow(row) : null;
};

export const fetchAllChunksByVault = (vaultId) => {
  return searchChunksByVault.all(vaultId).map(mapChunkRow);
};

// CD-7: batched IN clause (SQLite bound-var limit) + per-size statement cache
const _inStmtCache = new Map();
const IN_BATCH_SIZE = 500;

export const fetchChunksByIds = (chunkIds) => {
  if (!chunkIds || chunkIds.length === 0) return [];

  const out = [];
  for (let i = 0; i < chunkIds.length; i += IN_BATCH_SIZE) {
    const batch = chunkIds.slice(i, i + IN_BATCH_SIZE);
    let stmt = _inStmtCache.get(batch.length);
    if (!stmt) {
      const placeholders = batch.map(() => "?").join(",");
      stmt = db.prepare(`
        SELECT chunk_id, chunk_text, vault_id, chunk_index, token_estimate
        FROM vault_chunks
        WHERE chunk_id IN (${placeholders})
      `);
      _inStmtCache.set(batch.length, stmt);
    }
    for (const row of stmt.all(...batch)) out.push(mapChunkRow(row));
  }
  return out;
};

export const searchChunksByKeyword = (keyword, limit = 20) => {
  // CD-6: escape LIKE wildcards so "100%" matches literally
  const escaped = String(keyword).replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;
  return searchChunksByText.all(pattern, limit).map(mapChunkRow);
};

export const fetchVaultTextConcatenated = (vaultId) => {
  const chunks = fetchAllChunksByVault(vaultId);
  return chunks.map((c) => `[Chunk ${c.index}]\n${c.text}`).join("\n\n");
};

export const getChunkStats = () => {
  return {
    totalChunks: getTotalChunkCount.get().count,
    totalVaults: getVaultCount.get().count,
    totalCacheEntries: getCacheCount.get().count,
  };
};

export const deleteVaultChunks = (vaultId) => {
  return deleteChunksByVault.run(vaultId);
};

export const fetchNeighborChunks = (
  vaultId,
  chunkIndex,
  neighborsBefore = 1,
  neighborsAfter = 1
) => {
  const rows = getNeighborChunksStmt.all(
    vaultId,
    Math.max(0, chunkIndex - neighborsBefore),
    chunkIndex + neighborsAfter
  );
  return rows.map(mapChunkRow);
};

/**
 * Atomic batch: save vault + chunks + vector labels.
 * CD-3: labels stored in vault_vector_labels (previously targeted
 * cache_vector_labels whose FK made this ALWAYS throw + roll back).
 * CD-4: idempotent — safe to call again for a deduped vaultId.
 */
export const saveChunksWithVectors = db.transaction((vaultId, chunks, vectorLabels) => {
  const vaultText = chunks.map((c) => c.text).join("\n\n");
  const contentHash = crypto.createHash("sha256").update(vaultText).digest("hex").slice(0, 16);
  insertVault.run(vaultId, vaultText, contentHash); // OR IGNORE (CD-4)

  for (const chunk of chunks) {
    const chunkId = `${vaultId}_chunk_${chunk.index}`;
    const vectorBlob = chunk.vector ? Buffer.from(new Float32Array(chunk.vector).buffer) : null;
    insertVaultChunk.run(
      chunkId,
      vaultId,
      chunk.text,
      chunk.index,
      chunk.tokenEstimate,
      vectorBlob
    ); // OR REPLACE (CD-4)
  }

  if (vectorLabels) {
    for (const label of vectorLabels) {
      insertVaultVectorLabel.run(vaultId, label); // CD-3
    }
  }
});

/** Labels registered for a vault via saveChunksWithVectors (CD-3). */
export const fetchVaultVectorLabels = (vaultId) => {
  return getVaultVectorLabels.all(vaultId).map((r) => r.vector_label);
};

/**
 * Wipe everything but keep schema intact
 */
export const fullReset = (cPP_Cache) => {
  db.exec(`
    DELETE FROM vault_chunks;
    DELETE FROM vault_vector_labels;
    DELETE FROM cache_vector_labels;
    DELETE FROM cache_dependencies;
    DELETE FROM prune_vault;
    DELETE FROM semantic_cache;
    DELETE FROM diff_compression_cache;
  `);

  if (cPP_Cache) {
    cPP_Cache.clearAll();
  }

  return true;
};
