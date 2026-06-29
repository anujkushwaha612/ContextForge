/**
 * graphDb.js
 *
 * source_line migration: edges table gets a source_line column so
 * find_route can return exact line numbers for inline handlers.
 * This lets the LLM call contextforge_retrieve with a line hint
 * instead of reading the entire file.
 */

import Database from "better-sqlite3";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

let _db = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getGraphDb(dbPath = null) {
  if (_db) return _db;

  const resolvedPath = dbPath || path.join(__dirname, "../data/graph.db");
  _db = new Database(resolvedPath);

  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous  = NORMAL");
  _db.exec("PRAGMA foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      file_id       TEXT PRIMARY KEY,
      file_path     TEXT UNIQUE NOT NULL,
      language      TEXT NOT NULL,
      last_modified INTEGER NOT NULL,
      indexed_at    INTEGER NOT NULL,
      node_count    INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS nodes (
      node_id     TEXT PRIMARY KEY,
      file_id     TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      is_exported INTEGER DEFAULT 0,
      is_async    INTEGER DEFAULT 0,
      complexity  INTEGER DEFAULT 0,
      body_text   TEXT,
      FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS edges (
      edge_id       TEXT PRIMARY KEY,
      source_file   TEXT NOT NULL,
      target_file   TEXT,
      source_symbol TEXT,
      target_symbol TEXT NOT NULL,
      relation      TEXT NOT NULL,
      source_line   INTEGER,
      FOREIGN KEY (source_file) REFERENCES files(file_path) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_name      ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_nodes_file      ON nodes(file_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_exported  ON nodes(is_exported) WHERE is_exported = 1;
    CREATE INDEX IF NOT EXISTS idx_edges_target    ON edges(target_symbol);
    CREATE INDEX IF NOT EXISTS idx_edges_source    ON edges(source_file);
    CREATE INDEX IF NOT EXISTS idx_edges_relation  ON edges(relation);
    CREATE INDEX IF NOT EXISTS idx_edges_caller    ON edges(source_symbol);
    CREATE INDEX IF NOT EXISTS idx_files_path      ON files(file_path);
  `);

  // ── Migration: add source_line to existing graph.db instances ──
  // CREATE TABLE IF NOT EXISTS won't add new columns to an existing table.
  // This try/catch is the standard SQLite migration pattern — it's a no-op
  // if the column already exists.
  try {
    _db.exec(`ALTER TABLE edges ADD COLUMN source_line INTEGER`);
    console.log("[GraphDb] ✅ Migrated edges table: added source_line column");
  } catch {
    // Column already exists — normal on every run after first migration
  }

  return _db;
}

// ─────────────────────────────────────────────
// Prepared statements
// ─────────────────────────────────────────────

let _stmts = null;

function stmts() {
  if (_stmts) return _stmts;
  const db = getGraphDb();

  _stmts = {
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

    insertNode: db.prepare(`
      INSERT OR IGNORE INTO nodes
        (node_id, file_id, file_path, name, kind, start_line, end_line,
         is_exported, is_async, complexity, body_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    // source_line added — nullable for non-route edges
    insertEdge: db.prepare(`
      INSERT OR IGNORE INTO edges
        (edge_id, source_file, target_file, source_symbol, target_symbol,
         relation, source_line)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),

    whoImportsThis: db.prepare(`
      SELECT DISTINCT source_file, source_symbol
      FROM   edges
      WHERE  target_symbol = ?
        AND  relation      = 'imports'
      ORDER BY source_file
    `),

    whatDoesThisExport: db.prepare(`
      SELECT name, kind, start_line, complexity, is_async
      FROM   nodes
      WHERE  file_path   = ?
        AND  is_exported = 1
      ORDER BY start_line
    `),

    findSymbol: db.prepare(`
      SELECT file_path, name, kind, start_line, end_line, complexity, body_text
      FROM   nodes
      WHERE  name = ?
      ORDER BY is_exported DESC, complexity DESC
    `),

    findSymbolFuzzy: db.prepare(`
      SELECT file_path, name, kind, start_line, end_line, complexity, body_text
      FROM   nodes
      WHERE  name LIKE '%' || ? || '%'
        AND  name != ?
      ORDER BY is_exported DESC, complexity DESC
      LIMIT 10
    `),

    whatDoesThisImport: db.prepare(`
      SELECT target_symbol, target_file
      FROM   edges
      WHERE  source_file = ?
        AND  relation    = 'imports'
      ORDER BY target_symbol
    `),

    whoDependsOnFile: db.prepare(`
      SELECT DISTINCT source_file
      FROM   edges
      WHERE  target_file = ?
        AND  relation    = 'imports'
    `),

    whoCallsThis: db.prepare(`
      SELECT DISTINCT source_file, source_symbol, source_line
      FROM   edges
      WHERE  target_symbol = ?
        AND  relation      = 'calls'
      ORDER BY source_file, source_symbol
    `),

    whatDoesThisCall: db.prepare(`
      SELECT DISTINCT target_symbol, target_file
      FROM   edges
      WHERE  source_symbol = ?
        AND  relation      = 'calls'
      ORDER BY target_symbol
    `),

    symbolImpact: db.prepare(`
      WITH RECURSIVE impact(source_file, source_symbol, depth) AS (
        SELECT source_file, source_symbol, 1
        FROM   edges
        WHERE  target_symbol = ?
          AND  relation      = 'calls'
        UNION
        SELECT e.source_file, e.source_symbol, i.depth + 1
        FROM   edges e
        JOIN   impact i ON e.target_symbol = i.source_symbol
        WHERE  e.relation = 'calls'
          AND  i.depth < 2
      )
      SELECT DISTINCT source_file, source_symbol, MIN(depth) AS depth
      FROM   impact
      GROUP BY source_file, source_symbol
      ORDER BY depth, source_file
    `),

    symbolDependencies: db.prepare(`
      SELECT DISTINCT e.target_symbol, e.target_file,
             n.kind, n.start_line
      FROM   edges e
      LEFT JOIN nodes n ON n.name = e.target_symbol
                        AND n.file_path = e.target_file
      WHERE  e.source_symbol = ?
        AND  e.relation      = 'calls'
      ORDER BY e.target_symbol
    `),

    // source_line returned so graphTools can include line number in response
    findRoutes: db.prepare(`
      SELECT source_file, target_symbol AS route_path,
             source_symbol AS handler, source_line
      FROM   edges
      WHERE  relation = 'defines_route'
        AND  (? IS NULL OR target_symbol LIKE '%' || ? || '%')
      ORDER BY source_file, target_symbol
    `),

    allNodeNames: db.prepare(`
      SELECT DISTINCT name FROM nodes
    `),

    stats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files) AS file_count,
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM edges WHERE relation = 'calls')         AS calls_count,
        (SELECT COUNT(*) FROM edges WHERE relation = 'imports')       AS imports_count,
        (SELECT COUNT(*) FROM edges WHERE relation = 'defines_route') AS routes_count
    `),

    allFiles: db.prepare(`
      SELECT file_path, last_modified FROM files
    `),
  };

  return _stmts;
}

// ─────────────────────────────────────────────
// Write operations
// ─────────────────────────────────────────────

export function writeFileGraph(fileData) {
  const db = getGraphDb();
  const s = stmts();

  const fileId = crypto.createHash("sha256").update(fileData.filePath).digest("hex").slice(0, 16);

  const writeTransaction = db.transaction(() => {
    s.upsertFile.run(
      fileId,
      fileData.filePath,
      fileData.language,
      fileData.lastModified,
      Date.now(),
      fileData.nodes.length
    );

    s.deleteFileNodes.run(fileId);
    s.deleteFileEdges.run(fileData.filePath);

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
        node.bodyText || null
      );
    }

    for (const edge of fileData.edges) {
      const edgeId = crypto
        .createHash("sha256")
        .update(
          fileData.filePath +
            "|" +
            (edge.sourceSymbol || "") +
            "|" +
            edge.targetSymbol +
            "|" +
            edge.relation
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
        edge.sourceLine ?? null // ← new: null for non-route edges
      );
    }
  });

  writeTransaction();
  return fileId;
}

// ─────────────────────────────────────────────
// Read operations
// ─────────────────────────────────────────────

export function queryWhoImportsThis(symbolName) {
  return stmts().whoImportsThis.all(symbolName);
}

export function queryWhatDoesThisExport(filePath) {
  return stmts().whatDoesThisExport.all(normalizeFilePath(filePath));
}

export function queryFindSymbol(symbolName) {
  return stmts().findSymbol.all(symbolName);
}

export function queryFindSymbolFuzzy(symbolName) {
  return stmts().findSymbolFuzzy.all(symbolName, symbolName);
}

export function queryWhatDoesThisImport(filePath) {
  return stmts().whatDoesThisImport.all(normalizeFilePath(filePath));
}

export function queryWhoDependsOnFile(filePath) {
  return stmts().whoDependsOnFile.all(normalizeFilePath(filePath));
}

export function queryWhoCallsThis(symbolName) {
  return stmts().whoCallsThis.all(symbolName);
}

export function queryWhatDoesThisCall(symbolName) {
  return stmts().whatDoesThisCall.all(symbolName);
}

export function querySymbolImpact(symbolName) {
  return stmts().symbolImpact.all(symbolName);
}

export function querySymbolDependencies(symbolName) {
  return stmts().symbolDependencies.all(symbolName);
}

export function queryFindRoutes(routeFilter = null) {
  return stmts().findRoutes.all(routeFilter, routeFilter);
}

export function getGraphStats() {
  return stmts().stats.get();
}

export function getAllIndexedFiles() {
  return stmts().allFiles.all();
}

export function getAllNodeNames() {
  return stmts()
    .allNodeNames.all()
    .map((r) => r.name);
}

export function getFileRecord(filePath) {
  return stmts().getFile.get(normalizeFilePath(filePath));
}

function normalizeFilePath(filePath) {
  if (!filePath) return filePath;
  return filePath.replace(/\\/g, "/");
}

export function closeGraphDb() {
  if (_db) {
    _db.close();
    _db = null;
    _stmts = null;
  }
}

/**
 * Wipe all graph data from the database without closing the connection.
 * Used by benchmarks to ensure each repo is measured in isolation.
 *
 * Does NOT drop tables — preserves schema and prepared statements.
 * Faster than closeGraphDb + delete file + reopen.
 */
export function clearGraph() {
  const db = getGraphDb();
  db.exec(`
    DELETE FROM edges;
    DELETE FROM nodes;
    DELETE FROM files;
  `);
  // Reset prepared statement cache — stmts hold references to the same DB
  // so they remain valid, but sqlite3 internal page cache is cleared
}
