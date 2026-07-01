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
  "node_modules", ".git", ".claude", "dist", "build",
  ".next", ".nuxt", "__pycache__", ".pytest_cache",
  "target", "vendor", "native/build",
]);

const IGNORE_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.bundle\.js$/,
  /\.d\.ts$/,
  /\.map$/,
  /\.lock$/,
];

// ─────────────────────────────────────────────
// WM-2: File change callback
//
// workspaceMapper (graph layer) must not import from upstreamRequest.js
// (proxy layer) — this violates the dependency direction.
//
// Instead: server.js registers a callback at startup via setFileChangeCallback().
// When a file changes, the callback is invoked with the file path.
// upstreamRequest.js exports invalidateCacheForFile which server.js passes here.
// ─────────────────────────────────────────────

let _onFileChanged = null;

export function setFileChangeCallback(cb) {
  _onFileChanged = cb;
}

// ─────────────────────────────────────────────
// Symbol embedder
// ─────────────────────────────────────────────

let _symbolEmbedder  = null;
let _symbolRetriever = null;

export function setSymbolEmbedder(embedder, retriever) {
  _symbolEmbedder  = embedder;
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
      const texts   = batch.map((d) => d.document);
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
// File hash tracking — for change detection
// ─────────────────────────────────────────────

const fileHashes = new Map();

function getFileHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * WM-5: Returns { changed, content } so the caller can reuse
 * the content that was read for hashing — avoids reading twice.
 */
function checkAndUpdateHash(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { changed: false, content: null };
  }

  const newHash = getFileHash(content);
  const oldHash = fileHashes.get(filePath);

  if (newHash === oldHash) return { changed: false, content: null };

  fileHashes.set(filePath, newHash);
  return { changed: true, content };
}

// ─────────────────────────────────────────────
// Route detection patterns
// ─────────────────────────────────────────────

const ROUTE_PATTERN =
  /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.(get|post|put|patch|delete|all|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const BARE_URL_PATTERN =
  /req\.url\s*(?:===|!==|startsWith\s*\()\s*['"`]([^'"`]+)['"`]/g;
const ROUTER_MOUNT_PATTERN =
  /(?:app|server)\s*\.\s*use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
const IMPORT_ROUTER_PATTERN =
  /import\s+(\w+)\s+from\s+['"`]([^'"`]*)['"` ]/g;

const routePrefixMap = new Map();

// ─────────────────────────────────────────────
// Call edge patterns
// ─────────────────────────────────────────────

const CALL_EXPRESSION_PATTERN = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
const CALL_EXCLUSIONS = new Set([
  "if", "for", "while", "switch", "catch", "function", "class",
  "return", "typeof", "instanceof", "new", "await", "yield",
  "import", "export", "const", "let", "var", "async", "static",
  "get", "set", "console", "Math", "JSON", "Object", "Array",
  "String", "Number", "Boolean", "Promise", "Error", "Date",
  "Map", "Set", "Symbol", "parseInt", "parseFloat", "isNaN",
  "isFinite", "encodeURIComponent", "decodeURIComponent",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "setImmediate", "process", "Buffer", "require", "performance", "crypto",
]);

function extractCallEdges(source, filePath, nodes, allKnownSymbols) {
  const callEdges    = [];
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
      ) continue;

      seenCallees.add(callee);
      callEdges.push({
        sourceSymbol: node.name,
        targetSymbol: callee,
        targetFile:   null,
        relation:     "calls",
        sourceLine:   null,
      });
    }
  }
  return callEdges;
}

function extractRouteEdges(source, filePath, mountPrefix = "") {
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
    const routerVar  = match[1];
    const method     = match[2].toUpperCase();
    const routePath  = match[3];
    const sourceLine = offsetToLine(match.index);
    if (["res", "req", "err", "ctx", "next", "response", "request"].includes(routerVar)) continue;
    const prefix   = mountPrefix || routePrefixMap.get(filePath) || "";
    const fullPath = prefix + routePath;
    routeEdges.push({
      sourceSymbol: null,
      targetSymbol: `${method} ${fullPath}`,
      targetFile:   filePath,
      relation:     "defines_route",
      sourceLine,
    });
  }

  BARE_URL_PATTERN.lastIndex = 0;
  while ((match = BARE_URL_PATTERN.exec(source)) !== null) {
    const routePath  = match[1];
    const sourceLine = offsetToLine(match.index);
    const contextWindow = source.slice(
      Math.max(0, match.index - 10),
      match.index + match[0].length + 100
    );
    const methodMatch = contextWindow.match(/req\.method\s*===\s*['"`]([A-Z]+)['"`]/);
    const method      = methodMatch ? methodMatch[1] : "ANY";
    routeEdges.push({
      sourceSymbol: null,
      targetSymbol: `${method} ${routePath}`,
      targetFile:   null,
      relation:     "defines_route",
      sourceLine,
    });
  }

  return routeEdges;
}

// ─────────────────────────────────────────────
// Route prefix map builder
// Extracted to a shared function so both indexWorkspace
// and watchWorkspace can call it when files change.
// WM-6: watcher now calls this when router files change.
// ─────────────────────────────────────────────

function buildRoutePrefixMap(allFiles) {
  routePrefixMap.clear();

  for (const filePath of allFiles) {
    try {
      const src = fs.readFileSync(filePath, "utf-8");
      if (!src.includes(".use(")) continue;

      const importMap = new Map();
      IMPORT_ROUTER_PATTERN.lastIndex = 0;
      let imp;

      while ((imp = IMPORT_ROUTER_PATTERN.exec(src)) !== null) {
        const varName    = imp[1];
        const importPath = imp[2];
        if (!importPath.startsWith(".")) continue;
        try {
          const resolved = path.resolve(path.dirname(filePath), importPath).replace(/\\/g, "/");
          const withExt  = /\.\w{1,4}$/.test(resolved) ? resolved : resolved + ".js";
          importMap.set(varName, withExt);
        } catch { /* skip */ }
      }

      ROUTER_MOUNT_PATTERN.lastIndex = 0;
      let mount;

      while ((mount = ROUTER_MOUNT_PATTERN.exec(src)) !== null) {
        const prefix   = mount[1];
        const varName  = mount[2];
        const resolved = importMap.get(varName);
        if (resolved) {
          routePrefixMap.set(resolved, prefix);
          if (process.env.CF_DEBUG_GRAPH === "1") {
            console.log(`[GraphMapper] 📍 Mount: ${path.basename(resolved)} → "${prefix}"`);
          }
        }
      }
    } catch { /* skip */ }
  }
}

// ─────────────────────────────────────────────
// Directory walker
// ─────────────────────────────────────────────

function* walkDirectory(rootDir) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
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
      yield fullPath.replace(/\\/g, "/");
    }
  }
}

function buildIndexedFileMap() {
  const indexed = getAllIndexedFiles();
  const map     = new Map();
  for (const row of indexed) map.set(row.file_path, row.last_modified);
  return map;
}

// ─────────────────────────────────────────────
// Main indexer
// ─────────────────────────────────────────────

export async function indexWorkspace(workspacePath, options = {}) {
  setWorkspaceRoot(workspacePath);
  const { force = false, onProgress = null } = options;

  console.log(`[GraphMapper] 🗺️  Starting workspace index: ${workspacePath}`);
  const startTime      = Date.now();
  const alreadyIndexed = force ? new Map() : buildIndexedFileMap();
  const stats          = { indexed: 0, skipped: 0, errors: 0, total: 0 };

  const allFiles = [];
  for (const filePath of walkDirectory(workspacePath)) allFiles.push(filePath);
  stats.total = allFiles.length;
  console.log(`[GraphMapper] Found ${stats.total} indexable files`);

  // WM-1: Store edges from Pass 1 to reuse in Pass 2 — avoids re-running tree-sitter
  const fileData = new Map();

  // Pre-pass: build route prefix map
  buildRoutePrefixMap(allFiles);

  // ── Pass 1: Extract nodes ──────────────────────────────────────────────
  console.log(`[GraphMapper] Pass 1/2 — extracting nodes…`);

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];

    try {
      const stat  = fs.statSync(filePath);
      const mtime = stat.mtimeMs;

      if (!force && alreadyIndexed.has(filePath)) {
        if (Math.abs(alreadyIndexed.get(filePath) - mtime) < 1000) {
          stats.skipped++;
          // WM-7: yield on every file — even skipped files reset the timer
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

      const { nodes, edges } = extractSymbols(source, filePath);

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

      const { literals, configRefs } = extractLiterals(source, filePath, nodes);
      const summaries                = buildNodeSummaries(nodes, literals, configRefs, filePath);
      const retrievalDocs            = buildRetrievalDocuments(nodes, literals, configRefs, filePath);
      const mountPrefix              = routePrefixMap.get(filePath) || "";
      const routeEdges               = extractRouteEdges(source, filePath, mountPrefix);
      const pass1Edges               = [...edges, ...routeEdges];

      writeFileGraph({
        filePath,
        language:     getLanguageForFile(filePath)?.language || "unknown",
        lastModified: mtime,
        nodes,
        edges:        pass1Edges,
        literals,
        configRefs,
        summaries,
      });

      // WM-1: Store symbol edges (not route edges) for Pass 2 reuse
      fileData.set(filePath, {
        source,
        nodes,
        edges,          // ← symbol edges from extractSymbols — reused in Pass 2
        routeEdges,     // ← route edges — reused in Pass 2
        mtime,
        literals,
        configRefs,
        summaries,
        retrievalDocs,
      });

      stats.indexed++;

      if (onProgress && i % 10 === 0) {
        onProgress({
          current: i + 1,
          total:   stats.total,
          file:    path.relative(workspacePath, filePath),
          ...stats,
        });
      }

      // WM-7: Yield after every file — prevents event loop blocking
      // Old: yield every 5 files → up to 500ms blocking on large files
      await new Promise((r) => setImmediate(r));

    } catch (err) {
      stats.errors++;
      if (process.env.CF_DEBUG_GRAPH === "1") {
        console.warn(`[GraphMapper] ⚠️ Failed to index ${filePath}: ${err.message}`);
      }
      await new Promise((r) => setImmediate(r));
    }
  }

  // ── Pass 2: Compute cross-file call edges ──────────────────────────────
  console.log(`[GraphMapper] Pass 2/3 — computing cross-file call edges…`);
  const allKnownSymbols = new Set(getAllNodeNames());
  console.log(`[GraphMapper] Global symbol set: ${allKnownSymbols.size} symbols`);

  for (const [filePath, { source, nodes, edges, routeEdges, mtime, literals, configRefs, summaries }] of fileData) {
    try {
      const callEdges = extractCallEdges(source, filePath, nodes, allKnownSymbols);
      if (callEdges.length === 0) continue;

      // WM-1: Reuse edges from Pass 1 — no re-running tree-sitter
      const allEdges = [...edges, ...callEdges, ...routeEdges];

      writeFileGraph({
        filePath,
        language:     getLanguageForFile(filePath)?.language || "unknown",
        lastModified: mtime,
        nodes,
        edges:        allEdges,
        literals,
        configRefs,
        summaries,
      });
    } catch (err) {
      if (process.env.CF_DEBUG_GRAPH === "1") {
        console.warn(`[GraphMapper] ⚠️ Pass 2 failed for ${filePath}: ${err.message}`);
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

  const elapsed    = Date.now() - startTime;
  const graphStats = getGraphStats();
  console.log(
    `[GraphMapper] ✅ Index complete in ${elapsed}ms | ` +
    `Files: ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.errors} errors | ` +
    `Graph: ${graphStats.node_count} nodes, ${graphStats.edge_count} edges ` +
    `(${graphStats.calls_count} calls, ${graphStats.imports_count} imports, ${graphStats.routes_count} routes)`
  );

  statsEmitter.updateGraphStats({
    nodes: graphStats.node_count,
    edges: graphStats.edge_count,
    files: stats.indexed + stats.skipped,
  });

  // Store hashes for watcher change detection
  for (const [fp, { source }] of fileData) {
    fileHashes.set(fp, getFileHash(source));
  }

  return stats;
}

// ─────────────────────────────────────────────
// File watcher
// ─────────────────────────────────────────────

export function watchWorkspace(workspacePath) {
  const pendingFiles  = new Set();
  let debounceTimer   = null;

  const processChanges = async () => {
    const files = [...pendingFiles];
    pendingFiles.clear();

    const allKnownSymbols  = new Set(getAllNodeNames());
    let allRetrievalDocs   = [];

    // WM-6: Collect all current workspace files for route prefix map rebuild
    const allWorkspaceFiles = [];
    for (const f of walkDirectory(workspacePath)) allWorkspaceFiles.push(f);

    // Check if any changed file is a router mount file — if so, rebuild prefix map
    const hasRouterChange = files.some((f) => {
      try {
        const src = fs.readFileSync(f, "utf-8");
        return src.includes(".use(");
      } catch { return false; }
    });

    if (hasRouterChange) {
      buildRoutePrefixMap(allWorkspaceFiles);
    }

    for (const filePath of files) {
      if (!getLanguageForFile(filePath)) continue;

      // Small delay to let the editor finish writing
      await new Promise((r) => setTimeout(r, 200));

      // WM-5: checkAndUpdateHash returns content so we don't read twice
      const { changed, content: source } = checkAndUpdateHash(filePath);
      if (!changed || source === null) {
        if (process.env.CF_DEBUG_GRAPH === "1") {
          console.log(`[GraphMapper] ⏭️  Skipped ${path.basename(filePath)} (content unchanged)`);
        }
        continue;
      }

      if (source.length === 0) {
        fileHashes.delete(filePath);
        continue;
      }

      try {
        const stat = fs.statSync(filePath);

        const { nodes, edges } = extractSymbols(source, filePath);

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

        const { literals, configRefs } = extractLiterals(source, filePath, nodes);
        const summaries                = buildNodeSummaries(nodes, literals, configRefs, filePath);
        const callEdges                = extractCallEdges(source, filePath, nodes, allKnownSymbols);
        const watchMountPrefix         = routePrefixMap.get(filePath) || "";
        const routeEdges               = extractRouteEdges(source, filePath, watchMountPrefix);
        const allEdges                 = [...edges, ...callEdges, ...routeEdges];

        writeFileGraph({
          filePath:     filePath.replace(/\\/g, "/"),
          language:     getLanguageForFile(filePath)?.language || "unknown",
          lastModified: stat.mtimeMs,
          nodes,
          edges:        allEdges,
          literals,
          configRefs,
          summaries,
        });

        const retrievalDocs = buildRetrievalDocuments(
          nodes, literals, configRefs,
          filePath.replace(/\\/g, "/")
        );
        if (_symbolEmbedder && _symbolRetriever && retrievalDocs.length > 0) {
          allRetrievalDocs.push(...retrievalDocs);
        }

        console.log(
          `[GraphMapper] 🔄 Re-indexed: ${path.relative(workspacePath, filePath)} ` +
          `(${nodes.length} nodes, ${allEdges.length} edges, ${callEdges.length} call edges)`
        );

        // WM-2: Use registered callback instead of importing from proxy layer
        _onFileChanged?.(filePath);

        try {
          const updated = getGraphStats();
          statsEmitter.updateGraphStats({
            nodes: updated.node_count,
            edges: updated.edge_count,
            files: updated.file_count,
          });
        } catch { /* stats update failure is non-fatal */ }

      } catch (err) {
        if (err.code !== "ENOENT") {
          console.warn(
            `[GraphMapper] ⚠️  Re-index failed for ${path.basename(filePath)}: ` +
            `${err.code || err.message}`
          );
        }
        fileHashes.delete(filePath);
      }
    }

    if (allRetrievalDocs.length > 0) {
      embedRetrievalDocuments(allRetrievalDocs)
        .then((count) => {
          if (process.env.CF_DEBUG_GRAPH === "1") {
            console.log(
              `[GraphMapper] 🧠 Re-embedded ${count} symbols from ${files.length} changed file(s)`
            );
          }
        })
        .catch(() => { /* embedding failure is non-fatal */ });
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

  const watcher = fs.watch(workspacePath, { recursive: true }, (event, filename) => {
    if (!filename) return;

    const fullPath    = path.join(workspacePath, filename).replace(/\\/g, "/");
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

  console.log(`[GraphMapper] 👁️  Watching: ${workspacePath}`);

  return {
    stop: () => {
      watcher.close();
      clearTimeout(debounceTimer);
      console.log("[GraphMapper] Watcher stopped");
    },
  };
}