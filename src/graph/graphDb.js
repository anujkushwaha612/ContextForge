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

let _workspaceRoot = null;
export function setWorkspaceRoot(root) { _workspaceRoot = root; }
export function getWorkspaceRoot() { return _workspaceRoot || process.env.CF_WORKSPACE_PATH || process.cwd(); }

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

  CREATE TABLE IF NOT EXISTS literals (
    literal_id    TEXT PRIMARY KEY,
    file_path     TEXT NOT NULL,
    value         TEXT NOT NULL,        -- "content-length", "multipart/form-data"
    kind          TEXT NOT NULL,        -- 'string', 'regex', 'env_var', 'magic_number'
    containing_fn TEXT,                 -- getS3SignedUrl (nullable)
    start_line    INTEGER NOT NULL,
    FOREIGN KEY (file_path) REFERENCES files(file_path) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS config_refs (
    config_id     TEXT PRIMARY KEY,
    file_path     TEXT NOT NULL,
    key           TEXT NOT NULL,        -- STORAGE_QUOTA, AWS_BUCKET_NAME
    raw_text      TEXT NOT NULL,        -- process.env.STORAGE_QUOTA
    containing_fn TEXT,
    start_line    INTEGER NOT NULL,
    FOREIGN KEY (file_path) REFERENCES files(file_path) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS summaries (
    node_id       TEXT PRIMARY KEY,     -- same as nodes.node_id
    file_path     TEXT NOT NULL,
    name          TEXT NOT NULL,
    signature     TEXT,                 -- "async (req, res, next) =>"
    dependencies  TEXT,                 -- JSON: ["STORAGE_QUOTA","content-length","S3Client"]
    env_refs      TEXT,                 -- JSON: ["AWS_BUCKET_NAME"]
    literal_refs  TEXT,                 -- JSON: ["content-length","multipart/form-data"]
    call_summary  TEXT,                 -- JSON: ["createPresignedPost","Directory.findById"]
    FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_literals_value    ON literals(value);
  CREATE INDEX IF NOT EXISTS idx_literals_file     ON literals(file_path);
  CREATE INDEX IF NOT EXISTS idx_literals_fn       ON literals(containing_fn);
  CREATE INDEX IF NOT EXISTS idx_config_key        ON config_refs(key);
  CREATE INDEX IF NOT EXISTS idx_config_fn         ON config_refs(containing_fn);
  CREATE INDEX IF NOT EXISTS idx_summaries_name    ON summaries(name);
`);

  // ADD THIS BLOCK:
  // ── Migrations for existing graph.db instances ──
  // CREATE TABLE IF NOT EXISTS won't add new tables to an existing DB.
  // These try/catch blocks are the standard SQLite migration pattern.
  const migrations = [
    `CREATE TABLE IF NOT EXISTS literals (
    literal_id TEXT PRIMARY KEY,
    file_path  TEXT NOT NULL,
    value      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    containing_fn TEXT,
    start_line INTEGER NOT NULL,
    FOREIGN KEY (file_path) REFERENCES files(file_path) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS config_refs (
    config_id  TEXT PRIMARY KEY,
    file_path  TEXT NOT NULL,
    key        TEXT NOT NULL,
    raw_text   TEXT NOT NULL,
    containing_fn TEXT,
    start_line INTEGER NOT NULL,
    FOREIGN KEY (file_path) REFERENCES files(file_path) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS summaries (
    node_id      TEXT PRIMARY KEY,
    file_path    TEXT NOT NULL,
    name         TEXT NOT NULL,
    signature    TEXT,
    dependencies TEXT,
    env_refs     TEXT,
    literal_refs TEXT,
    call_summary TEXT,
    FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS idx_literals_value ON literals(value)`,
    `CREATE INDEX IF NOT EXISTS idx_literals_file  ON literals(file_path)`,
    `CREATE INDEX IF NOT EXISTS idx_literals_fn    ON literals(containing_fn)`,
    `CREATE INDEX IF NOT EXISTS idx_config_key     ON config_refs(key)`,
    `CREATE INDEX IF NOT EXISTS idx_config_fn      ON config_refs(containing_fn)`,
    `CREATE INDEX IF NOT EXISTS idx_summaries_name ON summaries(name)`,
    `ALTER TABLE edges ADD COLUMN source_line INTEGER`,
  ];

  for (const sql of migrations) {
    try {
      _db.exec(sql);
    } catch {
      /* already exists — normal after first run */
    }
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

    getNodeByFileAndLine: db.prepare(`
  SELECT n.file_path, n.name, n.kind, n.start_line, n.end_line,
         n.complexity, n.body_text, n.is_exported,
         s.literal_refs, s.env_refs, s.call_summary
  FROM   nodes n
  LEFT JOIN summaries s ON n.node_id = s.node_id
  WHERE  n.file_path = ?
    AND  n.start_line = ?
  LIMIT 1
`),

    getRetrievalDocument: db.prepare(`
  SELECT n.name, n.kind, n.file_path, n.start_line, n.end_line,
         n.is_async, n.complexity, n.body_text,
         s.signature, s.env_refs, s.literal_refs, s.call_summary
  FROM   nodes n
  LEFT JOIN summaries s ON n.node_id = s.node_id
  WHERE  n.node_id = ?
`),

    deleteFileNodes: db.prepare(`
      DELETE FROM nodes WHERE file_id = ?
    `),

    deleteFileEdges: db.prepare(`
      DELETE FROM edges WHERE source_file = ?
    `),

    deleteSummariesByFile: db.prepare(`
  DELETE FROM summaries WHERE file_path = ?
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
      SELECT n.file_path, n.name, n.kind, n.start_line, n.end_line, n.complexity, n.body_text,
             s.literal_refs, s.env_refs, s.call_summary
      FROM   nodes n
      LEFT JOIN summaries s ON n.node_id = s.node_id
      WHERE  n.name = ?
      ORDER BY n.is_exported DESC, n.complexity DESC
    `),

    findSymbolFuzzy: db.prepare(`
      SELECT n.file_path, n.name, n.kind, n.start_line, n.end_line, n.complexity, n.body_text,
             s.literal_refs, s.env_refs, s.call_summary
      FROM   nodes n
      LEFT JOIN summaries s ON n.node_id = s.node_id
      WHERE  n.name LIKE '%' || ? || '%'
        AND  n.name != ?
      ORDER BY n.is_exported DESC, n.complexity DESC
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
        AND  (? IS NULL 
              OR target_symbol LIKE '%' || ? || '%'
              OR target_symbol LIKE '% ' || ?       -- matches "GET /:id" when searching "/:id"
              OR target_symbol LIKE '%/' || ? || '%') -- matches "/files/:id" when searching "/:id"
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

    findLiteral: db.prepare(`
  SELECT l.value, l.kind, l.file_path, l.start_line, l.containing_fn,
         n.start_line as fn_start_line, n.end_line as fn_end_line, n.complexity as fn_complexity, n.body_text as fn_body
  FROM   literals l
  LEFT JOIN nodes n ON n.name = l.containing_fn AND n.file_path = l.file_path
  WHERE  l.value LIKE '%' || ? || '%'
  ORDER BY
    CASE WHEN l.value = ? THEN 0 ELSE 1 END,  -- exact first
    length(l.value)                             -- shorter = more specific
  LIMIT 10
`),

    findConfig: db.prepare(`
  SELECT c.key, c.raw_text, c.file_path, c.start_line, c.containing_fn,
         n.start_line as fn_start_line, n.end_line as fn_end_line, n.complexity as fn_complexity, n.body_text as fn_body
  FROM   config_refs c
  LEFT JOIN nodes n ON n.name = c.containing_fn AND n.file_path = c.file_path
  WHERE  c.key = ? OR c.key LIKE '%' || ? || '%'
  ORDER BY
    CASE WHEN c.key = ? THEN 0 ELSE 1 END
  LIMIT 10
`),

    findLiteralsByFn: db.prepare(`
      SELECT value, kind, start_line
      FROM literals
      WHERE containing_fn = ? AND file_path = ?
    `),

    findConfigByFn: db.prepare(`
      SELECT key, raw_text, start_line
      FROM config_refs
      WHERE containing_fn = ? AND file_path = ?
    `),

    insertLiteral: db.prepare(`
  INSERT OR IGNORE INTO literals
    (literal_id, file_path, value, kind, containing_fn, start_line)
  VALUES (?, ?, ?, ?, ?, ?)
`),

    insertConfigRef: db.prepare(`
  INSERT OR IGNORE INTO config_refs
    (config_id, file_path, key, raw_text, containing_fn, start_line)
  VALUES (?, ?, ?, ?, ?, ?)
`),

    upsertSummary: db.prepare(`
  INSERT OR REPLACE INTO summaries
    (node_id, file_path, name, signature, dependencies,
     env_refs, literal_refs, call_summary)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`),

    deleteLiterals: db.prepare(`
  DELETE FROM literals WHERE file_path = ?
`),

    deleteConfigRefs: db.prepare(`
  DELETE FROM config_refs WHERE file_path = ?
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
    s.deleteLiterals.run(fileData.filePath);
    s.deleteConfigRefs.run(fileData.filePath);
    s.deleteSummariesByFile.run(fileData.filePath);

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

    if (fileData.literals) {
      let i = 0;
      for (const lit of fileData.literals) {
        s.insertLiteral.run(
          `${fileId}:lit:${i++}`,
          lit.filePath,
          lit.value,
          lit.kind,
          lit.containingFn,
          lit.startLine
        );
      }
    }

    if (fileData.configRefs) {
      let i = 0;
      for (const ref of fileData.configRefs) {
        s.insertConfigRef.run(
          `${fileId}:cfg:${i++}`,
          ref.filePath,
          ref.key,
          ref.rawText,
          ref.containingFn,
          ref.startLine
        );
      }
    }

    if (fileData.summaries) {
      for (const sum of fileData.summaries) {
        s.upsertSummary.run(
          sum.nodeId,
          sum.filePath,
          sum.name,
          sum.signature,
          sum.dependencies,
          sum.envRefs,
          sum.literalRefs,
          sum.callSummary
        );
      }
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
  return stmts().findRoutes.all(routeFilter, routeFilter, routeFilter, routeFilter);
}

export function queryFindLiteral(value) {
  return stmts().findLiteral.all(value, value);
}

export function queryFindConfig(key) {
  return stmts().findConfig.all(key, key, key);
}

export function queryFindLiteralsByFn(fnName, filePath) {
  return stmts().findLiteralsByFn.all(fnName, filePath);
}

export function queryFindConfigByFn(fnName, filePath) {
  return stmts().findConfigByFn.all(fnName, filePath);
}

// ADD after queryFindConfigByFn:

/**
 * Resolve a stable embedding ID back to a node record.
 * Stable ID format: "file_path:start_line:name"
 * e.g. "controllers/s3-upload.controller.js:9:getS3SignedUrl"
 */
export function queryNodeByStableId(stableId) {
  const parts = stableId.split(":");
  if (parts.length < 3) return null;

  // Last part is name, second-to-last is line, rest is file path
  // Handle Windows paths like "D:/foo/bar.js:9:fnName"
  const name = parts[parts.length - 1];
  const line = parseInt(parts[parts.length - 2], 10);
  const filePath = parts.slice(0, parts.length - 2).join(":");

  if (isNaN(line)) return null;

  return stmts().getNodeByFileAndLine.get(normalizeFilePath(filePath), line);
}

/**
 * Get all data needed to build a rich retrieval document for a node.
 * Used during indexing to build the text fed to the embedder.
 */
export function queryRetrievalDocument(nodeId) {
  return stmts().getRetrievalDocument.get(nodeId);
}

/**
 * Get all embeddable nodes across the entire workspace.
 * Used to rebuild the HNSW index on startup if needed.
 */
export function queryAllEmbeddableNodes() {
  return getGraphDb()
    .prepare(
      `
    SELECT n.node_id, n.file_path, n.name, n.kind, n.start_line,
           n.is_async, n.complexity, n.body_text,
           s.signature, s.env_refs, s.literal_refs, s.call_summary
    FROM   nodes n
    LEFT JOIN summaries s ON n.node_id = s.node_id
    WHERE  n.kind IN ('function', 'method', 'arrow_function', 'class')
      AND  n.name NOT LIKE '__module_%'
    ORDER BY n.file_path, n.start_line
  `
    )
    .all();
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
    DELETE FROM literals;
    DELETE FROM config_refs;
    DELETE FROM summaries;
  `);
}
