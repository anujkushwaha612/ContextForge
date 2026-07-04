/**
 * graphDb.js — FIXED VERSION
 *
 * Previous fixes kept: GD-1 (migrations), GD-3 (nodeId format),
 * GD-4 (edgeId includes source_line), GD-5 (no body_text in find_symbol).
 *
 * New fixes (GB-1 … GB-7), each reproduced against a live DB first:
 *
 *   GB-1  WRITE/READ PATH ASYMMETRY (critical). Read queries normalize paths
 *         (backslashes→/, lowercase) but writeFileGraph stored them RAW.
 *         Any path containing an uppercase character made these return
 *         nothing: whatDoesThisExport, whatDoesThisImport, whoDependsOnFile,
 *         getFileRecord, queryNodeByStableId (→ HNSW stableId resolution
 *         dead), findLiteralsByFn/findConfigByFn. Verified: indexed
 *         "src/Controllers/UserAuth.js" → export query returned 0 rows,
 *         stableId lookup NOT FOUND. Fix: one canonicalPath() applied at
 *         EVERY write and EVERY read.
 *         ⚠ nodeIds/stableIds are derived from the normalized path now —
 *         existing graph.db + HNSW symbol embeddings must be reindexed once
 *         (cf graph reindex / indexWorkspace force:true).
 *
 *   GB-2  FK ROLLBACK LOSES WHOLE FILE (critical). literals/config_refs FK
 *         on files(file_path) used lit.filePath as passed by the extractor —
 *         any mismatch with the file row (case, slashes) threw FK constraint
 *         inside the transaction, rolling back nodes+edges+everything for
 *         that file. Verified. Fix: literals/config always use the file's
 *         own canonical path; extractor-provided per-row paths ignored.
 *
 *   GB-3  LIKE WILDCARD INJECTION. findSymbolFuzzy("do_work") matched
 *         "doXwork" ('_' = any char); findLiteral("100_") matched "100%".
 *         Model-generated queries contain _ and % constantly. Fix: escape
 *         % _ \ and add ESCAPE '\' in fuzzy/literal/config/route LIKEs.
 *
 *   GB-4  MISSING INDEXES on hot paths (verified via EXPLAIN QUERY PLAN):
 *         - nodes(file_path, start_line)  → getNodeByFileAndLine was SCAN
 *           (runs on every stableId resolution during retrieval)
 *         - summaries(file_path), config_refs(file_path) → per-file deletes
 *           were SCANs (run on every reindex of every file)
 *         - edges(target_file) → whoDependsOnFile was SCAN
 *
 *   GB-5  upsertFile OR REPLACE → ON CONFLICT DO UPDATE. REPLACE is
 *         DELETE+INSERT: the delete CASCADE-dropped the file's nodes and
 *         edges mid-transaction before they were re-inserted — harmless
 *         today only because everything is re-inserted afterwards, but a
 *         needless full churn of every row on every file save, and a trap
 *         if insert order ever changes.
 *
 *   GB-6  DB path: CF_DATA_DIR respected (CLI sets it per-workspace),
 *         directory created if missing (fresh clone previously threw
 *         "unable to open database file"). Matches cacheDb CD-1.
 *
 *   GB-7  getGraphDb(dbPath) silently ignored dbPath when a connection
 *         already existed — now throws if a DIFFERENT path is requested,
 *         instead of silently returning the wrong database.
 */

import Database from "better-sqlite3";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

let _db = null;
let _dbPath = null;
let _stmts = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _workspaceRoot = null;
export function setWorkspaceRoot(root) {
  _workspaceRoot = root;
}
export function getWorkspaceRoot() {
  return _workspaceRoot || process.env.CF_WORKSPACE_PATH || process.cwd();
}

// GB-9: Path case cache — maps canonical (lowercased) paths to actual filesystem paths.
// This is necessary because we store paths in lowercase for consistency (GB-1),
// but on case-sensitive filesystems (Linux/macOS) we need the original case to read files.
// Populated during writeFileGraph() and used by readSymbolBody() to resolve paths.
const _pathCaseCache = new Map();

/**
 * Register the actual filesystem path for a canonical path.
 * Called during indexing to preserve the original case.
 * @param {string} canonicalPath - The lowercased canonical path
 * @param {string} actualPath - The actual filesystem path with correct case
 */
export function registerPathCase(canonicalPath, actualPath) {
  if (!canonicalPath || !actualPath) return;
  _pathCaseCache.set(canonicalPath, actualPath);
}

/**
 * Resolve a canonical path back to its actual filesystem path.
 * Falls back to the input path if not found in cache (for backward compatibility).
 * @param {string} canonicalPath - The lowercased canonical path
 * @returns {string} The actual filesystem path with correct case, or the input if not cached
 */
export function resolvePathCase(canonicalPath) {
  if (!canonicalPath) return canonicalPath;
  return _pathCaseCache.get(canonicalPath) || canonicalPath;
}

/**
 * Clear the path case cache. Called when clearing the graph.
 */
export function clearPathCaseCache() {
  _pathCaseCache.clear();
}

// GB-1: THE canonical path form. Applied at every write and every read.
// Lowercase matches normalizePathForCache in upstreamRequest.js.
// (Trade-off: on case-sensitive filesystems two files differing only by case
// would collide — vanishingly rare in real repos and consistent with the
// rest of the pipeline.)
function canonicalPath(p) {
  if (!p || typeof p !== "string") return p;
  return p.replace(/\\/g, "/").toLowerCase();
}

// GB-3: escape LIKE metacharacters; pair with ESCAPE '\' in the SQL.
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function getGraphDb(dbPath = null) {
  if (_db) {
    // GB-7: don't silently hand back a different database than requested
    if (dbPath && path.resolve(dbPath) !== _dbPath) {
      throw new Error(
        `[graphDb] Already open at ${_dbPath}; requested ${dbPath}. Call closeGraphDb() first.`
      );
    }
    return _db;
  }

  // GB-6: CLI-managed per-workspace dir wins; legacy repo-local fallback.
  const dataDir = process.env.CF_DATA_DIR || path.join(__dirname, "../data");
  mkdirSync(dataDir, { recursive: true });
  const resolvedPath = dbPath || path.join(dataDir, "graph.db");
  _db = new Database(resolvedPath);
  _dbPath = path.resolve(resolvedPath);

  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous  = NORMAL");
  _db.exec("PRAGMA foreign_keys = ON");

  // ── Initial schema ────────────────────────────────────────────────────────
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

    CREATE TABLE IF NOT EXISTS literals (
      literal_id    TEXT PRIMARY KEY,
      file_path     TEXT NOT NULL,
      value         TEXT NOT NULL,
      kind          TEXT NOT NULL,
      containing_fn TEXT,
      start_line    INTEGER NOT NULL,
      FOREIGN KEY (file_path) REFERENCES files(file_path) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS config_refs (
      config_id     TEXT PRIMARY KEY,
      file_path     TEXT NOT NULL,
      key           TEXT NOT NULL,
      raw_text      TEXT NOT NULL,
      containing_fn TEXT,
      start_line    INTEGER NOT NULL,
      FOREIGN KEY (file_path) REFERENCES files(file_path) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS summaries (
      node_id       TEXT PRIMARY KEY,
      file_path     TEXT NOT NULL,
      name          TEXT NOT NULL,
      signature     TEXT,
      dependencies  TEXT,
      env_refs      TEXT,
      literal_refs  TEXT,
      call_summary  TEXT,
      FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_name      ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_nodes_file      ON nodes(file_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_exported  ON nodes(is_exported) WHERE is_exported = 1;
    CREATE INDEX IF NOT EXISTS idx_edges_target    ON edges(target_symbol);
    CREATE INDEX IF NOT EXISTS idx_edges_source    ON edges(source_file);
    CREATE INDEX IF NOT EXISTS idx_edges_relation  ON edges(relation);
    CREATE INDEX IF NOT EXISTS idx_edges_caller    ON edges(source_symbol);
    CREATE INDEX IF NOT EXISTS idx_files_path      ON files(file_path);
    CREATE INDEX IF NOT EXISTS idx_literals_value  ON literals(value);
    CREATE INDEX IF NOT EXISTS idx_literals_file   ON literals(file_path);
    CREATE INDEX IF NOT EXISTS idx_literals_fn     ON literals(containing_fn);
    CREATE INDEX IF NOT EXISTS idx_config_key      ON config_refs(key);
    CREATE INDEX IF NOT EXISTS idx_config_fn       ON config_refs(containing_fn);
    CREATE INDEX IF NOT EXISTS idx_summaries_name  ON summaries(name);

    -- GB-4: hot-path indexes (previously full scans, verified via EXPLAIN)
    CREATE INDEX IF NOT EXISTS idx_nodes_path_line  ON nodes(file_path, start_line);
    CREATE INDEX IF NOT EXISTS idx_summaries_file   ON summaries(file_path);
    CREATE INDEX IF NOT EXISTS idx_config_file      ON config_refs(file_path);
    CREATE INDEX IF NOT EXISTS idx_edges_targetfile ON edges(target_file);
  `);

  // ── GD-1: Migrations — only TRUE migrations here (schema additions) ────────
  const migrations = [`ALTER TABLE edges ADD COLUMN source_line INTEGER`];

  for (const sql of migrations) {
    try {
      _db.exec(sql);
    } catch {
      /* column already exists — normal after first run */
    }
  }

  return _db;
}

// ─────────────────────────────────────────────
// Prepared statements
// ─────────────────────────────────────────────

function stmts() {
  if (_stmts) return _stmts;
  const db = getGraphDb();

  _stmts = {
    // GB-5: true upsert — no DELETE+INSERT, no CASCADE churn mid-transaction
    upsertFile: db.prepare(`
      INSERT INTO files
        (file_id, file_path, language, last_modified, indexed_at, node_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        language      = excluded.language,
        last_modified = excluded.last_modified,
        indexed_at    = excluded.indexed_at,
        node_count    = excluded.node_count
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

    deleteFileNodes: db.prepare(`DELETE FROM nodes WHERE file_id = ?`),
    deleteFileEdges: db.prepare(`DELETE FROM edges WHERE source_file = ?`),
    deleteLiterals: db.prepare(`DELETE FROM literals WHERE file_path = ?`),
    deleteConfigRefs: db.prepare(`DELETE FROM config_refs WHERE file_path = ?`),
    deleteSummariesByFile: db.prepare(`DELETE FROM summaries WHERE file_path = ?`),

    insertNode: db.prepare(`
      INSERT OR IGNORE INTO nodes
        (node_id, file_id, file_path, name, kind, start_line, end_line,
         is_exported, is_async, complexity, body_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

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
      SELECT n.file_path, n.name, n.kind, n.start_line, n.end_line,
             n.complexity, n.is_exported,
             s.literal_refs, s.env_refs, s.call_summary
      FROM   nodes n
      LEFT JOIN summaries s ON n.node_id = s.node_id
      WHERE  n.name = ?
      ORDER BY n.is_exported DESC, n.complexity DESC
    `),

    // GB-3: ESCAPE '\' so _ and % in symbol names match literally
    findSymbolFuzzy: db.prepare(`
      SELECT n.file_path, n.name, n.kind, n.start_line, n.end_line,
             n.complexity, n.is_exported,
             s.literal_refs, s.env_refs, s.call_summary
      FROM   nodes n
      LEFT JOIN summaries s ON n.node_id = s.node_id
      WHERE  n.name LIKE '%' || ? || '%' ESCAPE '\\'
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
      LEFT JOIN nodes n ON n.name      = e.target_symbol
                        AND n.file_path = e.target_file
      WHERE  e.source_symbol = ?
        AND  e.relation      = 'calls'
      ORDER BY e.target_symbol
    `),

    // GB-3: route filter escaped too
    findRoutes: db.prepare(`
      SELECT source_file, target_symbol AS route_path,
             source_symbol AS handler, source_line
      FROM   edges
      WHERE  relation = 'defines_route'
        AND  (? IS NULL
              OR target_symbol LIKE '%' || ? || '%' ESCAPE '\\'
              OR target_symbol LIKE '% '  || ? ESCAPE '\\'
              OR target_symbol LIKE '%/'  || ? || '%' ESCAPE '\\')
      ORDER BY source_file, target_symbol
    `),

    allNodeNames: db.prepare(`SELECT DISTINCT name FROM nodes`),

    stats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files) AS file_count,
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM edges WHERE relation = 'calls')         AS calls_count,
        (SELECT COUNT(*) FROM edges WHERE relation = 'imports')       AS imports_count,
        (SELECT COUNT(*) FROM edges WHERE relation = 'defines_route') AS routes_count
    `),

    // GB-3: literal search escaped (exact-match ranking uses the RAW value)
    // GB-8 FIX: JOIN was `n.name = l.containing_fn` — but containing_fn is
    // stored as the FULL STABLE ID ("filePath:startLine:name", written by
    // literalExtractor.js's findContainingFunction), while n.name is just
    // the bare symbol name ("checkAuth"). These can never be equal, so the
    // JOIN always failed: fn_start_line/fn_end_line/fn_complexity/fn_body
    // were NULL in every findLiteral result, for every literal, in every
    // project — semanticResolver.js's runLiteralIndex silently never
    // populated the containing_function object it builds from these
    // columns. nodes.node_id is already stored in this exact stable-ID
    // format (graphDb.js's own writeFileGraph, `${filePath}:${startLine}:
    // ${name}`) — join on that instead of the bare name.
    findLiteral: db.prepare(`
      SELECT l.value, l.kind, l.file_path, l.start_line, l.containing_fn,
             n.start_line AS fn_start_line, n.end_line AS fn_end_line,
             n.complexity AS fn_complexity, n.body_text AS fn_body
      FROM   literals l
      LEFT JOIN nodes n ON n.node_id = l.containing_fn AND n.file_path = l.file_path
      WHERE  l.value LIKE '%' || ? || '%' ESCAPE '\\'
      ORDER BY
        CASE WHEN l.value = ? THEN 0 ELSE 1 END,
        length(l.value)
      LIMIT 10
    `),

    // GB-8 FIX: same JOIN mismatch as findLiteral above.
    findConfig: db.prepare(`
      SELECT c.key, c.raw_text, c.file_path, c.start_line, c.containing_fn,
             n.start_line AS fn_start_line, n.end_line AS fn_end_line,
             n.complexity AS fn_complexity, n.body_text AS fn_body
      FROM   config_refs c
      LEFT JOIN nodes n ON n.node_id = c.containing_fn AND n.file_path = c.file_path
      WHERE  c.key = ? OR c.key LIKE '%' || ? || '%' ESCAPE '\\'
      ORDER BY
        CASE WHEN c.key = ? THEN 0 ELSE 1 END
      LIMIT 10
    `),

    findLiteralsByFn: db.prepare(`
      SELECT value, kind, start_line
      FROM   literals
      WHERE  containing_fn = ? AND file_path = ?
    `),

    findConfigByFn: db.prepare(`
      SELECT key, raw_text, start_line
      FROM   config_refs
      WHERE  containing_fn = ? AND file_path = ?
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

    allFiles: db.prepare(`SELECT file_path, last_modified FROM files`),
  };

  return _stmts;
}

// ─────────────────────────────────────────────
// Write operations
// ─────────────────────────────────────────────

export function writeFileGraph(fileData) {
  const db = getGraphDb();
  const s = stmts();

  // GB-1: canonicalize ONCE; every row and every derived id uses this form.
  const filePath = canonicalPath(fileData.filePath);
  
  // GB-9: Register the actual filesystem path for case-sensitive resolution.
  // This maps the canonical (lowercased) path to the original path with correct case.
  registerPathCase(filePath, fileData.filePath);

  const fileId = crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 16);

  const writeTransaction = db.transaction(() => {
    s.upsertFile.run(
      fileId,
      filePath,
      fileData.language,
      fileData.lastModified,
      Date.now(),
      fileData.nodes.length
    );

    s.deleteFileNodes.run(fileId);
    s.deleteFileEdges.run(filePath);
    s.deleteLiterals.run(filePath);
    s.deleteConfigRefs.run(filePath);
    s.deleteSummariesByFile.run(filePath);

    for (const node of fileData.nodes) {
      // GD-3 + GB-1: nodeId "filePath:startLine:name", canonical path form.
      const nodeId = `${filePath}:${node.startLine}:${node.name}`;

      s.insertNode.run(
        nodeId,
        fileId,
        filePath,
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
      // GD-4: source_line in hash; GB-1: canonical target_file
      const targetFile = edge.targetFile ? canonicalPath(edge.targetFile) : null;
      const edgeId = crypto
        .createHash("sha256")
        .update(
          filePath +
            "|" +
            (edge.sourceSymbol || "") +
            "|" +
            edge.targetSymbol +
            "|" +
            edge.relation +
            "|" +
            (edge.sourceLine ?? "")
        )
        .digest("hex")
        .slice(0, 16);

      s.insertEdge.run(
        edgeId,
        filePath,
        targetFile,
        edge.sourceSymbol || null,
        edge.targetSymbol,
        edge.relation,
        edge.sourceLine ?? null
      );
    }

    if (fileData.literals) {
      let i = 0;
      for (const lit of fileData.literals) {
        // GB-2: ALWAYS the file's canonical path — extractor-provided
        // lit.filePath variants (case/slash) previously threw FK constraint
        // and rolled back the entire file write.
        s.insertLiteral.run(
          `${fileId}:lit:${i++}`,
          filePath,
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
        // GB-2: same as literals
        s.insertConfigRef.run(
          `${fileId}:cfg:${i++}`,
          filePath,
          ref.key,
          ref.rawText,
          ref.containingFn,
          ref.startLine
        );
      }
    }

    if (fileData.summaries) {
      for (const sum of fileData.summaries) {
        // GB-1: recompute node_id in canonical form rather than trusting the
        // caller's casing (must match nodes.node_id or FK throws).
        const canonicalNodeId =
          sum.startLine !== undefined && sum.name
            ? `${filePath}:${sum.startLine}:${sum.name}`
            : canonicalPathNodeId(sum.nodeId);

        s.upsertSummary.run(
          canonicalNodeId,
          filePath,
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

// GB-1 helper: canonicalize the path portion of a "filePath:line:name" id.
function canonicalPathNodeId(stableId) {
  if (!stableId || typeof stableId !== "string") return stableId;
  const parts = stableId.split(":");
  if (parts.length < 3) return stableId;
  const name = parts[parts.length - 1];
  const line = parts[parts.length - 2];
  const filePath = canonicalPath(parts.slice(0, parts.length - 2).join(":"));
  return `${filePath}:${line}:${name}`;
}

// ─────────────────────────────────────────────
// Read operations
// ─────────────────────────────────────────────

export function queryWhoImportsThis(symbolName) {
  return stmts().whoImportsThis.all(symbolName);
}

export function queryWhatDoesThisExport(filePath) {
  return stmts().whatDoesThisExport.all(canonicalPath(filePath));
}

export function queryFindSymbol(symbolName) {
  return stmts().findSymbol.all(symbolName);
}

export function queryFindSymbolFuzzy(symbolName) {
  // GB-3: escaped pattern, raw value for the != exclusion
  return stmts().findSymbolFuzzy.all(escapeLike(symbolName), symbolName);
}

export function queryWhatDoesThisImport(filePath) {
  return stmts().whatDoesThisImport.all(canonicalPath(filePath));
}

export function queryWhoDependsOnFile(filePath) {
  return stmts().whoDependsOnFile.all(canonicalPath(filePath));
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
  // GB-3: escape the filter (may legitimately contain _ in route names)
  const f = routeFilter === null ? null : escapeLike(routeFilter);
  return stmts().findRoutes.all(f, f, f, f);
}

export function queryFindLiteral(value) {
  // GB-3: escaped pattern for LIKE, raw value for exact-match ranking
  return stmts().findLiteral.all(escapeLike(value), value);
}

export function queryFindConfig(key) {
  return stmts().findConfig.all(key, escapeLike(key), key);
}

export function queryFindLiteralsByFn(fnName, filePath) {
  return stmts().findLiteralsByFn.all(fnName, canonicalPath(filePath));
}

export function queryFindConfigByFn(fnName, filePath) {
  return stmts().findConfigByFn.all(fnName, canonicalPath(filePath));
}

/**
 * Resolve a stable embedding ID back to a node record.
 * Stable ID format: "filePath:startLine:name" (canonical path form).
 * Windows drive letters ("d:/...") handled by rightmost-two-colons split.
 */
export function queryNodeByStableId(stableId) {
  if (!stableId || typeof stableId !== "string") return null;

  const parts = stableId.split(":");
  if (parts.length < 3) return null;

  const name = parts[parts.length - 1];
  const line = parseInt(parts[parts.length - 2], 10);
  const filePath = parts.slice(0, parts.length - 2).join(":");

  if (isNaN(line) || !name || !filePath) return null;

  return stmts().getNodeByFileAndLine.get(canonicalPath(filePath), line);
}

export function queryRetrievalDocument(nodeId) {
  // GB-1: ids may arrive from older embeddings with raw casing — canonicalize
  return stmts().getRetrievalDocument.get(canonicalPathNodeId(nodeId));
}

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
  return stmts().getFile.get(canonicalPath(filePath));
}

export function closeGraphDb() {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
    _stmts = null;
  }
}

export function clearGraph() {
  const db = getGraphDb();
  db.exec(`
    DELETE FROM summaries;
    DELETE FROM config_refs;
    DELETE FROM literals;
    DELETE FROM edges;
    DELETE FROM nodes;
    DELETE FROM files;
  `);
  // GB-9: Clear the path case cache when clearing the graph
  clearPathCaseCache();
}
