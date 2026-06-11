/**
 * graphDb.js
 *
 * SQLite schema and query layer for the ContextForge code knowledge graph.
 *
 * Separate from contextforge.db because:
 *   - Graph is workspace-scoped, not session-scoped
 *   - Graph must survive cache resets (contextforge.db gets wiped)
 *   - Write pattern differs: one large batch at startup, then reads only
 *
 * Schema:
 *   nodes  — every exported symbol (function, class, const) in the workspace
 *   edges  — directional relationships between symbols and files
 *   files  — indexed files with their last-modified timestamp
 */

import Database from "better-sqlite3";
import path from "node:path";
import crypto from "node:crypto";

// ─────────────────────────────────────────────
// Database initialization
// ─────────────────────────────────────────────

let _db = null;

export function getGraphDb(dbPath = null) {
  if (_db) return _db;

  const resolvedPath = dbPath || path.join(process.cwd(), "graph.db");

  _db = new Database(resolvedPath);

  // WAL mode — allows reads during batch writes at startup
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous  = NORMAL");
  _db.exec("PRAGMA foreign_keys = ON");

  _db.exec(`
    -- Files table: tracks which files have been indexed and when
    CREATE TABLE IF NOT EXISTS files (
      file_id       TEXT PRIMARY KEY,   -- SHA256 of absolute path (first 16 chars)
      file_path     TEXT UNIQUE NOT NULL,
      language      TEXT NOT NULL,
      last_modified INTEGER NOT NULL,   -- mtime in ms
      indexed_at    INTEGER NOT NULL,   -- when we indexed it
      node_count    INTEGER DEFAULT 0
    );

    -- Nodes table: every exported/declared symbol
    CREATE TABLE IF NOT EXISTS nodes (
      node_id     TEXT PRIMARY KEY,     -- file_id + ":" + name
      file_id     TEXT NOT NULL,
      file_path   TEXT NOT NULL,        -- denormalized for fast lookup
      name        TEXT NOT NULL,        -- symbol name: "sliceJsonOutput"
      kind        TEXT NOT NULL,        -- "function" | "class" | "const" | "import"
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      is_exported INTEGER DEFAULT 0,    -- 1 if exported
      is_async    INTEGER DEFAULT 0,
      complexity  INTEGER DEFAULT 0,
      body_text   TEXT,
      FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE
    );

    -- Edges table: directional relationships
    CREATE TABLE IF NOT EXISTS edges (
      edge_id       TEXT PRIMARY KEY,
      source_file   TEXT NOT NULL,      -- file that contains the import/reference
      target_file   TEXT,               -- file being imported (null if external)
      source_symbol TEXT,               -- symbol doing the importing (null = file-level)
      target_symbol TEXT NOT NULL,      -- symbol being imported/referenced
      relation      TEXT NOT NULL,      -- "imports" | "exports" | "calls" | "extends"
      FOREIGN KEY (source_file) REFERENCES files(file_path) ON DELETE CASCADE
    );

    -- Indexes for fast graph traversal
    CREATE INDEX IF NOT EXISTS idx_nodes_name      ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_nodes_file      ON nodes(file_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_exported  ON nodes(is_exported) WHERE is_exported = 1;
    CREATE INDEX IF NOT EXISTS idx_edges_target    ON edges(target_symbol);
    CREATE INDEX IF NOT EXISTS idx_edges_source    ON edges(source_file);
    CREATE INDEX IF NOT EXISTS idx_edges_relation  ON edges(relation);
    CREATE INDEX IF NOT EXISTS idx_files_path      ON files(file_path);
  `);

  return _db;
}

// ─────────────────────────────────────────────
// Prepared statements (lazy — built on first use)
// ─────────────────────────────────────────────

let _stmts = null;

function stmts() {
  if (_stmts) return _stmts;
  const db = getGraphDb();

  _stmts = {
    // File operations
    upsertFile: db.prepare(`
      INSERT OR REPLACE INTO files
        (file_id, file_path, language, last_modified, indexed_at, node_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `),

    getFile: db.prepare(`
      SELECT * FROM files WHERE file_path = ?
    `),

    deleteFileNodes: db.prepare(`
      DELETE FROM nodes WHERE file_id = ?
    `),

    deleteFileEdges: db.prepare(`
      DELETE FROM edges WHERE source_file = ?
    `),

    // Node operations
    insertNode: db.prepare(`
  INSERT OR IGNORE INTO nodes
    (node_id, file_id, file_path, name, kind, start_line, end_line,
     is_exported, is_async, complexity, body_text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`),

    // Edge operations
    insertEdge: db.prepare(`
      INSERT OR IGNORE INTO edges
        (edge_id, source_file, target_file, source_symbol, target_symbol, relation)
      VALUES (?, ?, ?, ?, ?, ?)
    `),

    // ── Graph query statements ──

    // Who imports symbol X?
    whoImportsThis: db.prepare(`
      SELECT DISTINCT source_file, source_symbol
      FROM   edges
      WHERE  target_symbol = ?
        AND  relation      = 'imports'
      ORDER BY source_file
    `),

    // What does file X export?
    whatDoesThisExport: db.prepare(`
      SELECT name, kind, start_line, complexity, is_async
      FROM   nodes
      WHERE  file_path   = ?
        AND  is_exported = 1
      ORDER BY start_line
    `),

    // Find symbol definition
    findSymbol: db.prepare(`
  SELECT file_path, name, kind, start_line, end_line, complexity, body_text
  FROM   nodes
  WHERE  name = ?
  ORDER BY is_exported DESC, complexity DESC
`),

    // What does file X import?
    whatDoesThisImport: db.prepare(`
      SELECT target_symbol, target_file
      FROM   edges
      WHERE  source_file = ?
        AND  relation    = 'imports'
      ORDER BY target_symbol
    `),

    // Files that depend on file X
    whoDependsOnFile: db.prepare(`
      SELECT DISTINCT source_file
      FROM   edges
      WHERE  target_file = ?
        AND  relation    = 'imports'
    `),

    // Graph stats
    stats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files)  AS file_count,
        (SELECT COUNT(*) FROM nodes)  AS node_count,
        (SELECT COUNT(*) FROM edges)  AS edge_count
    `),

    // All files (for incremental update check)
    allFiles: db.prepare(`
      SELECT file_path, last_modified FROM files
    `),
  };

  return _stmts;
}

// ─────────────────────────────────────────────
// Write operations — called by workspaceMapper
// ─────────────────────────────────────────────

/**
 * Batch-write a single file's nodes and edges to the graph.
 * Wrapped in a transaction — either all succeeds or nothing.
 */
export function writeFileGraph(fileData) {
  const db = getGraphDb();
  const s = stmts();

  const fileId = crypto
    .createHash("sha256")
    .update(fileData.filePath)
    .digest("hex")
    .slice(0, 16);

  const writeTransaction = db.transaction(() => {
    // Upsert file record
    s.upsertFile.run(
      fileId,
      fileData.filePath,
      fileData.language,
      fileData.lastModified,
      Date.now(),
      fileData.nodes.length,
    );

    // Clear old data for this file (re-index)
    s.deleteFileNodes.run(fileId);
    s.deleteFileEdges.run(fileData.filePath);

    // Insert nodes
    for (const node of fileData.nodes) {
      const nodeId = fileId + ":" + node.name + ":" + node.startLine;
      s.insertNode.run(
        nodeId,
        fileId,
        fileData.filePath,
        node.name,
        node.kind,
        node.startLine,
        node.endLine,
        node.isExported ? 1 : 0,
        node.isAsync ? 1 : 0,
        node.complexity || 0,
        node.bodyText || null, // ← pass body if symbolExtractor provides it
      );
    }

    // Insert edges
    for (const edge of fileData.edges) {
      const edgeId = crypto
        .createHash("sha256")
        .update(
          fileData.filePath + "|" + edge.targetSymbol + "|" + edge.relation,
        )
        .digest("hex")
        .slice(0, 16);

      s.insertEdge.run(
        edgeId,
        fileData.filePath,
        edge.targetFile || null,
        edge.sourceSymbol || null,
        edge.targetSymbol,
        edge.relation,
      );
    }
  });

  writeTransaction();
  return fileId;
}

// ─────────────────────────────────────────────
// Read operations — called by ghost interceptor
// ─────────────────────────────────────────────

/**
 * Who imports symbol X?
 * Returns list of files that import the given symbol name.
 */
export function queryWhoImportsThis(symbolName) {
  return stmts().whoImportsThis.all(symbolName);
}

/**
 * What does file X export?
 * Returns all exported symbols from the given file path.
 */
export function queryWhatDoesThisExport(filePath) {
  // Normalize: accept both absolute and relative paths
  const normalized = normalizeFilePath(filePath);
  return stmts().whatDoesThisExport.all(normalized);
}

/**
 * Where is symbol X defined?
 */
export function queryFindSymbol(symbolName) {
  return stmts().findSymbol.all(symbolName);
}

/**
 * What does file X import?
 */
export function queryWhatDoesThisImport(filePath) {
  const normalized = normalizeFilePath(filePath);
  return stmts().whatDoesThisImport.all(normalized);
}

/**
 * Which files depend on file X?
 */
export function queryWhoDependsOnFile(filePath) {
  const normalized = normalizeFilePath(filePath);
  return stmts().whoDependsOnFile.all(normalized);
}

/**
 * Get graph statistics.
 */
export function getGraphStats() {
  return stmts().stats.get();
}

/**
 * Get all indexed files with their mtimes (for incremental update).
 */
export function getAllIndexedFiles() {
  return stmts().allFiles.all();
}

/**
 * Get file record by path.
 */
export function getFileRecord(filePath) {
  return stmts().getFile.get(normalizeFilePath(filePath));
}

// ─────────────────────────────────────────────
// Path normalization
// ─────────────────────────────────────────────

/**
 * Normalize a file path for consistent lookups.
 * Handles: relative paths, Windows backslashes, trailing slashes.
 */
function normalizeFilePath(filePath) {
  if (!filePath) return filePath;
  // Normalize Windows backslashes
  return filePath.replace(/\\/g, "/");
}

export function closeGraphDb() {
  if (_db) {
    _db.close();
    _db = null;
    _stmts = null;
  }
}
