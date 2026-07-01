/**
 * workspaceMapper.js
 *
 * Indexes the workspace and watches for file changes.
 *
 * Fixes applied:
 *   WM-1: Pass 2 no longer re-runs extractSymbols (tree-sitter) — symbol
 *         edges are stored in fileData during Pass 1 and reused in Pass 2.
 *         Eliminates the double tree-sitter parse per file.
 *
 *   WM-2: invalidateCacheForFile no longer imported from upstreamRequest.js
 *         (proxy layer). workspaceMapper is graph layer — it should not
 *         depend on proxy layer. A callback is registered at startup via
 *         setFileChangeCallback() and called on file change events.
 *
 *   WM-3: fs.watch recursive warning added for Linux where recursive mode
 *         is silently non-recursive.
 *
 *   WM-5: File content reused after hasFileChanged — no longer read twice
 *         per change event.
 *
 *   WM-6: Route prefix map updated when a router file changes via watcher.
 *
 *   WM-7: Event loop yield changed from every 5 files to every file —
 *         prevents up to 500ms blocking during indexing of large files.
 *
 *   WM-8: normalizePath() introduced — single function for all path
 *         normalization. Eliminates backslash/forward-slash and case
 *         mismatches that caused silent lookup failures on Windows.
 *
 *   WM-9: buildIndexedFileMap key format fixed — was storing relPath keys
 *         but lookup used absolute filePath. alreadyIndexed.has() always
 *         returned false, making force:false behave like force:true and
 *         re-indexing all files on every startup.
 *
 *   WM-10: routePrefixMap keys unified — was populated with absolute paths
 *          but queried with relPath after the relPath refactor. Mount prefix
 *          lookups always missed, so all routes were registered without their
 *          mount prefix (e.g. "/files" instead of "/api/files").
 *
 *   WM-11: walkDirectory now logs failures instead of silently returning.
 *          Silent catch made it impossible to diagnose indexing gaps.
 *
 *   WM-12: force defaults to true — stale SQLite entries from previous
 *          sessions caused graph to return outdated symbol locations after
 *          patches. Re-indexing 30 files takes ~200ms, worth the accuracy.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { statsEmitter } from "../proxy/statsEmitter.js";
import { extractSymbols, getLanguageForFile } from "./symbolExtractor.js";
import {
  writeFileGraph,
  getAllIndexedFiles,
  getGraphStats,
  getAllNodeNames,
  setWorkspaceRoot,
} from "./graphDb.js";
import {
  extractLiterals,
  buildNodeSummaries,
  buildRetrievalDocuments,
} from "./literalExtractor.js";
import { setGraphEmbedder } from "./semanticResolver.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "__pycache__",
  ".pytest_cache",
  "target",
  "vendor",
  "native/build",
]);

const IGNORE_PATTERNS = [/\.min\.(js|css)$/, /\.bundle\.js$/, /\.d\.ts$/, /\.map$/, /\.lock$/];

// ─────────────────────────────────────────────
// WM-8: Path normalization
//
// All paths stored in Maps, passed to SQLite, or compared against
// each other must go through normalizePath first.
//
// Rules:
//   - Backslashes → forward slashes (Windows fs.watch emits backslashes)
//   - Lowercase (Windows is case-insensitive, Node.js is not)
//
// This single function replaces ad-hoc .replace(/\\/g, "/") calls
// scattered throughout the file, which missed cases and caused
// silent lookup failures (Map.get returns undefined instead of value).
// ─────────────────────────────────────────────

function normalizePath(p) {
  if (!p) return p;
  return p.replace(/\\/g, "/").toLowerCase();
}

// ─────────────────────────────────────────────
// WM-2: File change callback
// ─────────────────────────────────────────────

let _onFileChanged = null;

export function setFileChangeCallback(cb) {
  _onFileChanged = cb;
}

// ─────────────────────────────────────────────
// Symbol embedder
// ─────────────────────────────────────────────

let _symbolEmbedder = null;
let _symbolRetriever = null;

export function setSymbolEmbedder(embedder, retriever) {
  _symbolEmbedder = embedder;
  _symbolRetriever = retriever;
  setGraphEmbedder(embedder, retriever);
  console.log("[GraphMapper] 🧠 Symbol embedding pipeline ready");
}

const EMBED_BATCH_SIZE = 16;

async function embedRetrievalDocuments(docs) {
  if (!_symbolEmbedder || !_symbolRetriever || docs.length === 0) return 0;
  let embedded = 0;

  for (let i = 0; i < docs.length; i += EMBED_BATCH_SIZE) {
    const batch = docs.slice(i, i + EMBED_BATCH_SIZE);
    try {
      const texts = batch.map((d) => d.document);
      const vectors = await _symbolEmbedder.embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const { stableId, document } = batch[j];
        const vector = vectors[j];
        if (!vector) continue;
        const float32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
        try {
          _symbolRetriever.addDocumentWithEmbedding(stableId, document, float32);
          embedded++;
        } catch (err) {
          if (process.env.CF_DEBUG_GRAPH === "1") {
            console.warn(`[GraphMapper] ⚠️ Failed to embed ${stableId}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      if (process.env.CF_DEBUG_GRAPH === "1") {
        console.warn(`[GraphMapper] ⚠️ Batch embedding failed (batch ${i}): ${err.message}`);
      }
    }
    await new Promise((r) => setImmediate(r));
  }
  return embedded;
}

// ─────────────────────────────────────────────
// File hash tracking
// ─────────────────────────────────────────────

const fileHashes = new Map(); // normalized absolute path → sha256 hex

function getFileHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function checkAndUpdateHash(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { changed: false, content: null };
  }

  const newHash = getFileHash(content);
  // WM-8: normalize key for consistent lookup
  const key = normalizePath(filePath);
  const oldHash = fileHashes.get(key);

  if (newHash === oldHash) return { changed: false, content: null };

  fileHashes.set(key, newHash);
  return { changed: true, content };
}

// ─────────────────────────────────────────────
// Route detection patterns
// ─────────────────────────────────────────────

const ROUTE_PATTERN =
  /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.(get|post|put|patch|delete|all|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const BARE_URL_PATTERN = /req\.url\s*(?:===|!==|startsWith\s*\()\s*['"`]([^'"`]+)['"`]/g;
const ROUTER_MOUNT_PATTERN =
  /(?:app|server)\s*\.\s*use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
const IMPORT_ROUTER_PATTERN = /import\s+(\w+)\s+from\s+['"`]([^'"`]*)['"` ]/g;

// WM-10: routePrefixMap keyed by normalized relPath (not absolute path).
// Previously keyed by absolute path but queried with relPath — always missed.
const routePrefixMap = new Map(); // normalized relPath → mount prefix string

// ─────────────────────────────────────────────
// Call edge patterns
// ─────────────────────────────────────────────

const CALL_EXPRESSION_PATTERN = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
const CALL_EXCLUSIONS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "class",
  "return",
  "typeof",
  "instanceof",
  "new",
  "await",
  "yield",
  "import",
  "export",
  "const",
  "let",
  "var",
  "async",
  "static",
  "get",
  "set",
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Promise",
  "Error",
  "Date",
  "Map",
  "Set",
  "Symbol",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "setImmediate",
  "process",
  "Buffer",
  "require",
  "performance",
  "crypto",
]);

function extractCallEdges(source, filePath, nodes, allKnownSymbols) {
  const callEdges = [];
  const localSymbols = new Set(nodes.map((n) => n.name));
  const knownSymbols = allKnownSymbols ?? localSymbols;

  for (const node of nodes) {
    if (!["function", "method", "arrow_function"].includes(node.kind)) continue;
    const scanText = node.bodyText ?? source;
    if (!scanText || scanText.length === 0) continue;

    const seenCallees = new Set();
    CALL_EXPRESSION_PATTERN.lastIndex = 0;
    let match;

    while ((match = CALL_EXPRESSION_PATTERN.exec(scanText)) !== null) {
      const callee = match[1];
      if (
        callee === node.name ||
        CALL_EXCLUSIONS.has(callee) ||
        !knownSymbols.has(callee) ||
        seenCallees.has(callee)
      )
        continue;

      seenCallees.add(callee);
      callEdges.push({
        sourceSymbol: node.name,
        targetSymbol: callee,
        targetFile: null,
        relation: "calls",
        sourceLine: null,
      });
    }
  }
  return callEdges;
}

function extractRouteEdges(source, relPath, mountPrefix = "") {
  const routeEdges = [];

  function offsetToLine(offset) {
    let line = 0;
    for (let i = 0; i < offset && i < source.length; i++) {
      if (source[i] === "\n") line++;
    }
    return line;
  }

  ROUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = ROUTE_PATTERN.exec(source)) !== null) {
    const routerVar = match[1];
    const method = match[2].toUpperCase();
    const routePath = match[3];
    const sourceLine = offsetToLine(match.index);
    if (["res", "req", "err", "ctx", "next", "response", "request"].includes(routerVar)) continue;

    // WM-10: query routePrefixMap with normalized relPath
    const prefix = mountPrefix || routePrefixMap.get(normalizePath(relPath)) || "";
    const fullPath = prefix + routePath;
    routeEdges.push({
      sourceSymbol: null,
      targetSymbol: `${method} ${fullPath}`,
      targetFile: relPath,
      relation: "defines_route",
      sourceLine,
    });
  }

  BARE_URL_PATTERN.lastIndex = 0;
  while ((match = BARE_URL_PATTERN.exec(source)) !== null) {
    const routePath = match[1];
    const sourceLine = offsetToLine(match.index);
    const contextWindow = source.slice(
      Math.max(0, match.index - 10),
      match.index + match[0].length + 100
    );
    const methodMatch = contextWindow.match(/req\.method\s*===\s*['"`]([A-Z]+)['"`]/);
    const method = methodMatch ? methodMatch[1] : "ANY";
    routeEdges.push({
      sourceSymbol: null,
      targetSymbol: `${method} ${routePath}`,
      targetFile: null,
      relation: "defines_route",
      sourceLine,
    });
  }

  return routeEdges;
}

// ─────────────────────────────────────────────
// Route prefix map builder
//
// WM-10: Keys are now normalized relPath strings, not absolute paths.
// Previously absolute paths were stored here but relPath was used for
// lookup — Map.get always returned undefined, so all routes were
// registered without their mount prefix.
// ─────────────────────────────────────────────

function buildRoutePrefixMap(allFiles, workspacePath) {
  routePrefixMap.clear();

  for (const filePath of allFiles) {
    try {
      const src = fs.readFileSync(filePath, "utf-8");
      if (!src.includes(".use(")) continue;

      const importMap = new Map(); // varName → normalized relPath

      IMPORT_ROUTER_PATTERN.lastIndex = 0;
      let imp;

      while ((imp = IMPORT_ROUTER_PATTERN.exec(src)) !== null) {
        const varName = imp[1];
        const importPath = imp[2];
        if (!importPath.startsWith(".")) continue;
        try {
          const absResolved = path.resolve(path.dirname(filePath), importPath);
          // Add .js extension if missing
          const withExt = /\.\w{1,4}$/.test(absResolved) ? absResolved : absResolved + ".js";
          // WM-10: store as normalized relPath so lookup matches
          const relResolved = normalizePath(path.relative(workspacePath, withExt));
          importMap.set(varName, relResolved);
        } catch {
          /* skip unresolvable imports */
        }
      }

      ROUTER_MOUNT_PATTERN.lastIndex = 0;
      let mount;

      while ((mount = ROUTER_MOUNT_PATTERN.exec(src)) !== null) {
        const prefix = mount[1];
        const varName = mount[2];
        const relResolved = importMap.get(varName);
        if (relResolved) {
          routePrefixMap.set(relResolved, prefix);
          if (process.env.CF_DEBUG_GRAPH === "1") {
            console.log(`[GraphMapper] 📍 Mount: ${relResolved} → "${prefix}"`);
          }
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }
}

// ─────────────────────────────────────────────
// Directory walker
//
// WM-11: Now logs failures instead of silently returning.
// Silent catch made it impossible to diagnose indexing gaps
// (e.g. permission errors, paths with special characters on Windows).
// ─────────────────────────────────────────────

function* walkDirectory(rootDir) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    // WM-11: was `catch { return; }` — silent failure hid indexing gaps
    console.warn(`[GraphMapper] ⚠️ Cannot read directory: ${rootDir} — ${err.message}`);
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      yield* walkDirectory(fullPath);
    } else if (entry.isFile()) {
      if (!getLanguageForFile(fullPath)) continue;
      if (IGNORE_PATTERNS.some((p) => p.test(entry.name))) continue;
      // WM-8: normalize immediately — all downstream consumers get
      // consistent forward-slash paths regardless of OS
      yield normalizePath(fullPath);
    }
  }
}

// ─────────────────────────────────────────────
// WM-9: buildIndexedFileMap
//
// SQLite stores relPath as file_path (e.g. "controllers/file.controller.js").
// The skip check in indexWorkspace uses absolute filePath as the key.
// These never matched — alreadyIndexed.has(filePath) always returned false,
// so force:false behaved identically to force:true, re-indexing everything
// on every startup.
//
// Fix: key the map by normalized relPath so the lookup matches.
// The caller must convert filePath → relPath before calling .has()/.get().
// ─────────────────────────────────────────────

function buildIndexedFileMap() {
  const indexed = getAllIndexedFiles();
  const map = new Map();
  for (const row of indexed) {
    // Normalize the stored relPath so case/slash differences don't cause misses
    map.set(normalizePath(row.file_path), row.last_modified);
  }
  return map;
}

// ─────────────────────────────────────────────
// Main indexer
// ─────────────────────────────────────────────

export async function indexWorkspace(workspacePath, options = {}) {
  // WM-8: normalize workspacePath at entry — used as base for all
  // path.relative() calls throughout this function
  const normalizedWorkspacePath = normalizePath(path.resolve(workspacePath));
  setWorkspaceRoot(normalizedWorkspacePath);

  // WM-12: default force:true — stale SQLite entries from previous sessions
  // cause graph to return outdated symbol locations after patches.
  // Re-indexing 30 files costs ~200ms at startup, worth the accuracy guarantee.
  const { force = true, onProgress = null } = options;

  console.log(`[GraphMapper] 🗺️  Starting workspace index: ${normalizedWorkspacePath}`);
  const startTime = Date.now();
  const alreadyIndexed = force ? new Map() : buildIndexedFileMap();
  const stats = { indexed: 0, skipped: 0, errors: 0, total: 0 };

  const allFiles = [];
  for (const filePath of walkDirectory(normalizedWorkspacePath)) {
    allFiles.push(filePath);
  }
  stats.total = allFiles.length;
  console.log(`[GraphMapper] Found ${stats.total} indexable files`);

  const fileData = new Map();

  // WM-10: pass workspacePath so buildRoutePrefixMap can compute relPaths
  buildRoutePrefixMap(allFiles, normalizedWorkspacePath);

  // ── Pass 1: Extract nodes ──────────────────────────────────────────────
  console.log(`[GraphMapper] Pass 1/2 — extracting nodes…`);

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i]; // already normalized absolute path

    try {
      const stat = fs.statSync(filePath);
      const mtime = stat.mtimeMs;

      // WM-9: compute relPath for SQLite key lookup
      // path.relative needs the original casing for Windows fs operations,
      // then we normalize the result for map lookup
      const relPath = normalizePath(path.relative(normalizedWorkspacePath, filePath));

      if (!force && alreadyIndexed.has(relPath)) {
        if (Math.abs(alreadyIndexed.get(relPath) - mtime) < 1000) {
          stats.skipped++;
          await new Promise((r) => setImmediate(r));
          continue;
        }
      }

      const source = fs.readFileSync(filePath, "utf-8");
      if (source.length > 500_000) {
        stats.skipped++;
        await new Promise((r) => setImmediate(r));
        continue;
      }

      const { nodes, edges } = extractSymbols(source, relPath);

      if (process.env.CF_DEBUG_GRAPH === "1") {
        const isSynthetic = nodes.length === 1 && nodes[0].name.startsWith("__module_");
        if (isSynthetic && source.length > 1000) {
          const lang = getLanguageForFile(filePath)?.language;
          if (lang === "javascript" || lang === "typescript" || lang === "tsx") {
            console.warn(
              `[GraphMapper] ⚠️  ${path.basename(filePath)} has no named declarations ` +
                `(${source.length} chars) — synthetic __module node created.`
            );
          }
        }
      }

      const { literals, configRefs } = extractLiterals(source, relPath, nodes);
      const summaries = buildNodeSummaries(nodes, literals, configRefs, relPath);
      const retrievalDocs = buildRetrievalDocuments(nodes, literals, configRefs, relPath);

      // WM-10: routePrefixMap is now keyed by normalized relPath
      const mountPrefix = routePrefixMap.get(normalizePath(relPath)) || "";
      const routeEdges = extractRouteEdges(source, relPath, mountPrefix);
      const pass1Edges = [...edges, ...routeEdges];

      writeFileGraph({
        filePath: relPath,
        language: getLanguageForFile(filePath)?.language || "unknown",
        lastModified: mtime,
        nodes,
        edges: pass1Edges,
        literals,
        configRefs,
        summaries,
      });

      fileData.set(filePath, {
        source,
        nodes,
        edges,
        routeEdges,
        mtime,
        literals,
        configRefs,
        summaries,
        retrievalDocs,
        relPath,
      });

      stats.indexed++;

      if (onProgress && i % 10 === 0) {
        onProgress({
          current: i + 1,
          total: stats.total,
          file: relPath,
          ...stats,
        });
      }

      await new Promise((r) => setImmediate(r));
    } catch (err) {
      stats.errors++;
      // WM-11: always log errors, not just in debug mode
      console.warn(`[GraphMapper] ⚠️ Failed to index ${filePath}: ${err.message}`);
      await new Promise((r) => setImmediate(r));
    }
  }

  // ── Pass 2: Compute cross-file call edges ──────────────────────────────
  console.log(`[GraphMapper] Pass 2/3 — computing cross-file call edges…`);
  const allKnownSymbols = new Set(getAllNodeNames());
  console.log(`[GraphMapper] Global symbol set: ${allKnownSymbols.size} symbols`);

  for (const [
    filePath,
    { source, nodes, edges, routeEdges, mtime, literals, configRefs, summaries, relPath },
  ] of fileData) {
    try {
      const callEdges = extractCallEdges(source, relPath, nodes, allKnownSymbols);
      if (callEdges.length === 0) continue;

      const allEdges = [...edges, ...callEdges, ...routeEdges];

      writeFileGraph({
        filePath: relPath,
        language: getLanguageForFile(filePath)?.language || "unknown",
        lastModified: mtime,
        nodes,
        edges: allEdges,
        literals,
        configRefs,
        summaries,
      });
    } catch (err) {
      if (process.env.CF_DEBUG_GRAPH === "1") {
        console.warn(`[GraphMapper] ⚠️ Pass 2 failed for ${relPath}: ${err.message}`);
      }
    }
    await new Promise((r) => setImmediate(r));
  }

  // ── Pass 3: Embed symbols into HNSW ────────────────────────────────────
  if (_symbolEmbedder && _symbolRetriever) {
    const allDocs = [];
    for (const [, { retrievalDocs }] of fileData) {
      if (retrievalDocs) allDocs.push(...retrievalDocs);
    }
    if (allDocs.length > 0) {
      console.log(`[GraphMapper] 🧠 Pass 3/3 — embedding ${allDocs.length} symbols into HNSW…`);
      const embedded = await embedRetrievalDocuments(allDocs);
      console.log(`[GraphMapper] ✅ Embedded ${embedded}/${allDocs.length} symbols`);
    }
  }

  const elapsed = Date.now() - startTime;
  const graphStats = getGraphStats();
  console.log(
    `[GraphMapper] ✅ Index complete in ${elapsed}ms | ` +
      `Files: ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.errors} errors | ` +
      `Graph: ${graphStats.node_count} nodes, ${graphStats.edge_count} edges ` +
      `(${graphStats.calls_count} calls, ${graphStats.imports_count} imports, ` +
      `${graphStats.routes_count} routes)`
  );

  statsEmitter.updateGraphStats({
    nodes: graphStats.node_count,
    edges: graphStats.edge_count,
    files: stats.indexed + stats.skipped,
  });

  // WM-8: store hashes with normalized absolute path as key
  for (const [fp, { source }] of fileData) {
    fileHashes.set(normalizePath(fp), getFileHash(source));
  }

  return stats;
}

// ─────────────────────────────────────────────
// File watcher
// ─────────────────────────────────────────────

export function watchWorkspace(workspacePath) {
  // WM-8: normalize at entry so all internal operations use consistent paths
  const normalizedWorkspacePath = normalizePath(path.resolve(workspacePath));

  const pendingFiles = new Set();
  let debounceTimer = null;

  const processChanges = async () => {
    const files = [...pendingFiles];
    pendingFiles.clear();

    const allKnownSymbols = new Set(getAllNodeNames());
    let allRetrievalDocs = [];

    const allWorkspaceFiles = [];
    for (const f of walkDirectory(normalizedWorkspacePath)) {
      allWorkspaceFiles.push(f);
    }

    const hasRouterChange = files.some((f) => {
      try {
        const src = fs.readFileSync(f, "utf-8");
        return src.includes(".use(");
      } catch {
        return false;
      }
    });

    if (hasRouterChange) {
      // WM-10: pass workspacePath for relPath computation
      buildRoutePrefixMap(allWorkspaceFiles, normalizedWorkspacePath);
    }

    for (const filePath of files) {
      if (!getLanguageForFile(filePath)) continue;

      await new Promise((r) => setTimeout(r, 200));

      const { changed, content: source } = checkAndUpdateHash(filePath);
      if (!changed || source === null) {
        if (process.env.CF_DEBUG_GRAPH === "1") {
          console.log(`[GraphMapper] ⏭️  Skipped ${path.basename(filePath)} (content unchanged)`);
        }
        continue;
      }

      if (source.length === 0) {
        fileHashes.delete(normalizePath(filePath));
        continue;
      }

      try {
        const stat = fs.statSync(filePath);
        const relPath = normalizePath(path.relative(normalizedWorkspacePath, filePath));

        const { nodes, edges } = extractSymbols(source, relPath);

        if (process.env.CF_DEBUG_GRAPH === "1") {
          const isSynthetic = nodes.length === 1 && nodes[0].name.startsWith("__module_");
          if (isSynthetic && source.length > 1000) {
            const lang = getLanguageForFile(filePath)?.language;
            if (lang === "javascript" || lang === "typescript" || lang === "tsx") {
              console.warn(
                `[GraphMapper] ⚠️  ${path.basename(filePath)} re-indexed with synthetic __module node`
              );
            }
          }
        }

        const { literals, configRefs } = extractLiterals(source, relPath, nodes);
        const summaries = buildNodeSummaries(nodes, literals, configRefs, relPath);
        const callEdges = extractCallEdges(source, relPath, nodes, allKnownSymbols);

        // WM-10: query with normalized relPath
        const watchMountPrefix = routePrefixMap.get(normalizePath(relPath)) || "";
        const routeEdges = extractRouteEdges(source, relPath, watchMountPrefix);
        const allEdges = [...edges, ...callEdges, ...routeEdges];

        writeFileGraph({
          filePath: relPath,
          language: getLanguageForFile(filePath)?.language || "unknown",
          lastModified: stat.mtimeMs,
          nodes,
          edges: allEdges,
          literals,
          configRefs,
          summaries,
        });

        const retrievalDocs = buildRetrievalDocuments(nodes, literals, configRefs, relPath);
        if (_symbolEmbedder && _symbolRetriever && retrievalDocs.length > 0) {
          allRetrievalDocs.push(...retrievalDocs);
        }

        console.log(
          `[GraphMapper] 🔄 Re-indexed: ${relPath} ` +
            `(${nodes.length} nodes, ${allEdges.length} edges, ` +
            `${callEdges.length} call edges)`
        );

        // WM-2: callback with normalized absolute path
        _onFileChanged?.(filePath);

        try {
          const updated = getGraphStats();
          statsEmitter.updateGraphStats({
            nodes: updated.node_count,
            edges: updated.edge_count,
            files: updated.file_count,
          });
        } catch {
          /* stats update failure is non-fatal */
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.warn(
            `[GraphMapper] ⚠️  Re-index failed for ${path.basename(filePath)}: ` +
              `${err.code || err.message}`
          );
        }
        fileHashes.delete(normalizePath(filePath));
      }
    }

    if (allRetrievalDocs.length > 0) {
      embedRetrievalDocuments(allRetrievalDocs)
        .then((count) => {
          if (process.env.CF_DEBUG_GRAPH === "1") {
            console.log(
              `[GraphMapper] 🧠 Re-embedded ${count} symbols from ` +
                `${files.length} changed file(s)`
            );
          }
        })
        .catch(() => {
          /* embedding failure is non-fatal */
        });
    }
  };

  // WM-3: Warn on Linux where fs.watch recursive is silently non-recursive
  if (process.platform === "linux") {
    console.warn(
      `[GraphMapper] ⚠️  fs.watch with recursive:true is not supported on Linux. ` +
        `Only files in the workspace root directory will be watched for changes. ` +
        `Files in subdirectories (src/, controllers/, etc.) will NOT trigger re-indexing. ` +
        `Consider adding 'chokidar' as a dependency for cross-platform recursive watching.`
    );
  }

  const watcher = fs.watch(normalizedWorkspacePath, { recursive: true }, (event, filename) => {
    if (!filename) return;

    // WM-8: normalize immediately — fs.watch emits backslashes on Windows
    const fullPath = normalizePath(path.join(normalizedWorkspacePath, filename));
    const pathSegments = fullPath.split("/");

    if ([...IGNORE_DIRS].some((d) => pathSegments.includes(d))) return;
    if (!getLanguageForFile(fullPath)) return;
    if (IGNORE_PATTERNS.some((p) => p.test(path.basename(fullPath)))) return;

    if (process.env.CF_DEBUG_GRAPH === "1") {
      console.log(`[GraphMapper] 👁️  Watch event: ${event} → ${path.basename(fullPath)}`);
    }

    pendingFiles.add(fullPath);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processChanges, 800);
  });

  console.log(`[GraphMapper] 👁️  Watching: ${normalizedWorkspacePath}`);

  return {
    stop: () => {
      watcher.close();
      clearTimeout(debounceTimer);
      console.log("[GraphMapper] Watcher stopped");
    },
  };
}
