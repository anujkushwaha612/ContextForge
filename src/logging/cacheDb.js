import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";

const db = new Database(path.join(process.cwd(), "contextforge.db"));

// CRITICAL: Enable foreign keys for CASCADE DELETE
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`
  CREATE TABLE IF NOT EXISTS semantic_cache (
    id TEXT PRIMARY KEY,
    state_hash TEXT UNIQUE, -- 🚀 NEW: Unique exact fingerprint
    query_text TEXT,
    response_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Create an index to guarantee sub-millisecond lookups
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_cache_state_hash ON semantic_cache(state_hash)`,
);

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

db.exec(`
  CREATE TABLE IF NOT EXISTS cache_vector_labels (
    cache_id TEXT PRIMARY KEY,
    vector_label INTEGER,
    FOREIGN KEY (cache_id) REFERENCES semantic_cache(id) ON DELETE CASCADE
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

// Add index for sub-millisecond hash lookups
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_prune_vault_content_hash ON prune_vault(content_hash)`,
);

// 🚀 NEW: The Vault Chunks Table
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

db.exec(
  `CREATE INDEX IF NOT EXISTS idx_vault_chunks_vault_id ON vault_chunks(vault_id)`,
);

db.exec(`
  CREATE TABLE IF NOT EXISTS diff_compression_cache (
    hash_key TEXT PRIMARY KEY,
    kept_text TEXT,
    vault_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
// Add this near your other prepared statements:
const wipeSemanticCache = db.prepare(`DELETE FROM semantic_cache`);

// 2. Add New Prepared Statements
const getCacheByHash = db.prepare(
  `SELECT response_text FROM semantic_cache WHERE state_hash = ?`,
);

const insertCacheWithHash = db.prepare(`
  INSERT OR IGNORE INTO semantic_cache (id, state_hash, query_text, response_text) 
  VALUES (?, ?, ?, ?)
`);
const getCache = db.prepare(
  `SELECT response_text FROM semantic_cache WHERE id = ?`,
);
const insertVault = db.prepare(
  `INSERT INTO prune_vault (vault_id, dropped_text, content_hash) VALUES (?, ?, ?)`, // ← add content_hash
);
const getVault = db.prepare(
  `SELECT dropped_text FROM prune_vault WHERE vault_id = ?`,
);

// NEW — lookup by content hash to deduplicate
const getVaultByHash = db.prepare(
  `SELECT vault_id FROM prune_vault WHERE content_hash = ? LIMIT 1`,
);

const insertDependency = db.prepare(
  `INSERT OR IGNORE INTO cache_dependencies (cache_id, resource_path, resource_hash) VALUES (?, ?, ?)`,
);
const insertVectorLabel = db.prepare(
  `INSERT OR REPLACE INTO cache_vector_labels (cache_id, vector_label) VALUES (?, ?)`,
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
  `INSERT OR REPLACE INTO diff_compression_cache (hash_key, kept_text, vault_id) VALUES (?, ?, ?)`,
);
const getDiff = db.prepare(
  `SELECT kept_text, vault_id FROM diff_compression_cache WHERE hash_key = ?`,
);

// 🚀 NEW: Vault Chunk Statements
const insertVaultChunk = db.prepare(`
  INSERT INTO vault_chunks (chunk_id, vault_id, chunk_text, chunk_index, token_estimate, vector)
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

// Add this to your exported functions at the bottom:
export const resetEntireCache = (cPP_Cache) => {
  // 1. Wipe SQLite (CASCADE will automatically clean up cache_dependencies and cache_vector_labels)
  wipeSemanticCache.run();

  // 2. Wipe the C++ Graph
  if (cPP_Cache) {
    cPP_Cache.clearAll();
  }
  return true;
};

export const saveToCache = (queryText, responseText, stateHash = null) => {
  const id = "RES_" + crypto.randomUUID();
  insertCacheWithHash.run(id, stateHash, queryText, responseText);
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

export const invalidateByFile = (
  filePath,
  newHash = null,
  cPP_Cache = null,
) => {
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
  // Compute a short hash of the content
  const contentHash = crypto
    .createHash("sha256")
    .update(droppedText)
    .digest("hex")
    .slice(0, 16);

  // Check if this exact content is already vaulted
  const existing = getVaultByHash.get(contentHash);
  if (existing) {
    console.log(
      `[Fat Catch] ♻️  Dedup hit — reusing vault ${existing.vault_id} (hash: ${contentHash})`,
    );
    return existing.vault_id;
  }

  // New content — save it
  const id = "cf_vault_" + crypto.randomBytes(4).toString("hex");
  insertVault.run(id, droppedText, contentHash);
  return id;
};

export const saveChunksToVault = (vaultId, chunks) => {
  const insertMany = db.transaction((chunksArray) => {
    for (const chunk of chunksArray) {
      const chunkId = `${vaultId}_chunk_${chunk.index}`;
      const vectorBlob = chunk.vector
        ? Buffer.from(new Float32Array(chunk.vector).buffer)
        : null;
      insertVaultChunk.run(
        chunkId,
        vaultId,
        chunk.text,
        chunk.index,
        chunk.tokenEstimate,
        vectorBlob,
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
    // 🚀 FIX: Use Uint8Array to safely extract the exact bytes from the Buffer pool
    vector: row.vector
      ? new Float32Array(new Uint8Array(row.vector).buffer)
      : null,
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
  return row
    ? { keptText: row.kept_text, vaultId: row.vault_id, hash }
    : { hash };
};

export const saveCachedCompression = (hash, keptText, vaultId) => {
  insertDiff.run(hash, keptText, vaultId);
};

// ==========================================
// HYBRID RAG: BM25 + HNSW RETRIEVAL METHODS
// ==========================================

// Prepared statements for chunk retrieval
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

const searchAllChunks = db.prepare(`
  SELECT chunk_id, chunk_text, vault_id, chunk_index, token_estimate
  FROM vault_chunks 
  ORDER BY vault_id, chunk_index ASC
  LIMIT ?
`);

const searchChunksByText = db.prepare(`
  SELECT chunk_id, chunk_text, vault_id, chunk_index, token_estimate
  FROM vault_chunks 
  WHERE chunk_text LIKE ?
  ORDER BY vault_id, chunk_index ASC
  LIMIT ?
`);

const getTotalChunkCount = db.prepare(`
  SELECT COUNT(*) as count FROM vault_chunks
`);

const deleteChunksByVault = db.prepare(`
  DELETE FROM vault_chunks WHERE vault_id = ?
`);

/**
 * Fetch a single chunk by its ID
 * Used by hybrid retriever to get text for scoring
 */
export const fetchChunkById = (chunkId) => {
  const row = getChunkById.get(chunkId);
  return row
    ? {
        chunkId: row.chunk_id,
        text: row.chunk_text,
        vaultId: row.vault_id,
        index: row.chunk_index,
        tokenEstimate: row.token_estimate,
      }
    : null;
};

/**
 * Get all chunks for a vault (ordered)
 */
export const fetchAllChunksByVault = (vaultId) => {
  const rows = searchChunksByVault.all(vaultId);
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    text: row.chunk_text,
    vaultId: row.vault_id,
    index: row.chunk_index,
    tokenEstimate: row.token_estimate,
  }));
};

/**
 * Bulk fetch: Get text for multiple chunk IDs at once
 * Used by hybrid retriever after HNSW+BM25 scoring
 */
export const fetchChunksByIds = (chunkIds) => {
  if (!chunkIds || chunkIds.length === 0) return [];

  // Build dynamic query with parameterized IN clause
  const placeholders = chunkIds.map(() => "?").join(",");
  const query = db.prepare(`
    SELECT chunk_id, chunk_text, vault_id, chunk_index, token_estimate
    FROM vault_chunks 
    WHERE chunk_id IN (${placeholders})
  `);

  const rows = query.all(...chunkIds);
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    text: row.chunk_text,
    vaultId: row.vault_id,
    index: row.chunk_index,
    tokenEstimate: row.token_estimate,
  }));
};

/**
 * Full-text search over chunks (SQLite LIKE - fallback for when HNSW misses)
 */
export const searchChunksByKeyword = (keyword, limit = 20) => {
  const pattern = `%${keyword}%`;
  const rows = searchChunksByText.all(pattern, limit);
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    text: row.chunk_text,
    vaultId: row.vault_id,
    index: row.chunk_index,
    tokenEstimate: row.token_estimate,
  }));
};

/**
 * Get all chunk texts for a vault as a single concatenated string
 * Used when contextforge_retrieve needs the full vault content
 */
export const fetchVaultTextConcatenated = (vaultId) => {
  const chunks = fetchAllChunksByVault(vaultId);
  return chunks.map((c) => `[Chunk ${c.index}]\n${c.text}`).join("\n\n");
};

/**
 * Get total number of chunks in the database
 * Used for statistics/debugging
 */
export const getChunkStats = () => {
  const count = getTotalChunkCount.get();
  const vaultCount = db
    .prepare("SELECT COUNT(*) as count FROM prune_vault")
    .get();
  const cacheCount = db
    .prepare("SELECT COUNT(*) as count FROM semantic_cache")
    .get();

  return {
    totalChunks: count.count,
    totalVaults: vaultCount.count,
    totalCacheEntries: cacheCount.count,
  };
};

/**
 * Delete all chunks for a vault (used when vault is invalidated)
 */
export const deleteVaultChunks = (vaultId) => {
  return deleteChunksByVault.run(vaultId);
};

/**
 * Get chunks that are semantically related (same vault, nearby indices)
 * Used for context expansion around a matched chunk
 */
export const fetchNeighborChunks = (
  vaultId,
  chunkIndex,
  neighborsBefore = 1,
  neighborsAfter = 1,
) => {
  const query = db.prepare(`
    SELECT chunk_id, chunk_text, vault_id, chunk_index, token_estimate
    FROM vault_chunks 
    WHERE vault_id = ? 
      AND chunk_index >= ? 
      AND chunk_index <= ?
    ORDER BY chunk_index ASC
  `);

  const rows = query.all(
    vaultId,
    Math.max(0, chunkIndex - neighborsBefore),
    chunkIndex + neighborsAfter,
  );

  return rows.map((row) => ({
    chunkId: row.chunk_id,
    text: row.chunk_text,
    vaultId: row.vault_id,
    index: row.chunk_index,
    tokenEstimate: row.token_estimate,
  }));
};

/**
 * Atomic batch operation: Save chunks AND their vector labels
 * Used by compression engine when vaulting with embeddings
 */
export const saveChunksWithVectors = db.transaction(
  (vaultId, chunks, vectorLabels) => {
    // Save vault metadata
    const vaultText = chunks.map((c) => c.text).join("\n\n");
    const contentHash = crypto
      .createHash("sha256")
      .update(vaultText)
      .digest("hex")
      .slice(0, 16);
    insertVault.run(vaultId, vaultText, contentHash);

    // Save individual chunks
    for (const chunk of chunks) {
      const chunkId = `${vaultId}_chunk_${chunk.index}`;
      const vectorBlob = chunk.vector
        ? Buffer.from(new Float32Array(chunk.vector).buffer)
        : null;
      insertVaultChunk.run(
        chunkId,
        vaultId,
        chunk.text,
        chunk.index,
        chunk.tokenEstimate,
        vectorBlob,
      );
    }

    // Register vector labels if provided
    if (vectorLabels) {
      for (const label of vectorLabels) {
        // Labels map to chunks via vault_id
        insertVectorLabel.run(vaultId, label);
      }
    }
  },
);

/**
 * Wipe everything but keep schema intact
 */
export const fullReset = (cPP_Cache) => {
  db.exec(`
    DELETE FROM vault_chunks;
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
