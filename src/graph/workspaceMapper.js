import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { statsEmitter } from "../proxy/statsEmitter.js";
import { extractSymbols, getLanguageForFile } from "./symbolExtractor.js";
import { writeFileGraph, getAllIndexedFiles, getGraphStats, getAllNodeNames, setWorkspaceRoot } from "./graphDb.js";
import { invalidateCacheForFile } from "../proxy/upstreamRequest.js";
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
  "out",
  ".next",
  ".nuxt",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  "target",
  "vendor",
  "native/build",
  "models",
]);
const IGNORE_PATTERNS = [/\.min\.(js|css)$/, /\.bundle\.js$/, /\.d\.ts$/, /\.map$/, /\.lock$/];

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

const fileHashes = new Map();

function getFileHash(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

function hasFileChanged(filePath) {
  const newHash = getFileHash(filePath);
  if (!newHash) return false;
  const oldHash = fileHashes.get(filePath);
  if (newHash === oldHash) return false;
  fileHashes.set(filePath, newHash);
  return true;
}

// ── Route detection patterns ──

const ROUTE_PATTERN =
  /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.(get|post|put|patch|delete|all|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const BARE_URL_PATTERN = /req\.url\s*(?:===|!==|startsWith\s*\()\s*['"`]([^'"`]+)['"`]/g;
const ROUTER_MOUNT_PATTERN =
  /(?:app|server)\s*\.\s*use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
const IMPORT_ROUTER_PATTERN = /import\s+(\w+)\s+from\s+['"`]([^'"`]*)['"` ]/g;

const routePrefixMap = new Map();

// ── Call edge patterns ──

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

function extractRouteEdges(source, filePath, mountPrefix = "") {
  const routeEdges = [];
  function offsetToLine(offset) {
    let line = 0;
    for (let i = 0; i < offset && i < source.length; i++) if (source[i] === "\n") line++;
    return line;
  }

  // Express-style routes
  ROUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = ROUTE_PATTERN.exec(source)) !== null) {
    const routerVar = match[1];
    const method = match[2].toUpperCase();
    const routePath = match[3];
    const sourceLine = offsetToLine(match.index);
    if (["res", "req", "err", "ctx", "next", "response", "request"].includes(routerVar)) continue;
    const prefix = mountPrefix || routePrefixMap.get(filePath) || "";
    const fullPath = prefix + routePath;
    routeEdges.push({
      sourceSymbol: null,
      targetSymbol: `${method} ${fullPath}`,
      targetFile: filePath,
      relation: "defines_route",
      sourceLine,
    });
  }

  // Bare req.url handlers
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
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
      if ([...IGNORE_DIRS].some((d) => relativePath.includes(d))) continue;
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
  const map = new Map();
  for (const row of indexed) map.set(row.file_path, row.last_modified);
  return map;
}

export async function indexWorkspace(workspacePath, options = {}) {
  setWorkspaceRoot(workspacePath);
  const { force = false, onProgress = null } = options;
  console.log(`[GraphMapper] 🗺️  Starting workspace index: ${workspacePath}`);
  const startTime = Date.now();
  const alreadyIndexed = force ? new Map() : buildIndexedFileMap();
  const stats = { indexed: 0, skipped: 0, errors: 0, total: 0 };
  const allFiles = [];
  for (const filePath of walkDirectory(workspacePath)) allFiles.push(filePath);
  stats.total = allFiles.length;
  console.log(`[GraphMapper] Found ${stats.total} indexable files`);

  const fileData = new Map();

  // Pre-pass: build route prefix map by scanning for app.use() + imports
  routePrefixMap.clear();
  for (const filePath of allFiles) {
    try {
      const src = fs.readFileSync(filePath, "utf-8");
      if (!src.includes(".use(")) continue;
      const importMap = new Map();
      IMPORT_ROUTER_PATTERN.lastIndex = 0;
      let imp;
      while ((imp = IMPORT_ROUTER_PATTERN.exec(src)) !== null) {
        const varName = imp[1];
        const importPath = imp[2];
        if (!importPath.startsWith(".")) continue;
        try {
          const resolved = path.resolve(path.dirname(filePath), importPath).replace(/\\/g, "/");
          const withExt = /\.\w{1,4}$/.test(resolved) ? resolved : resolved + ".js";
          importMap.set(varName, withExt);
        } catch {
          /* skip */
        }
      }
      ROUTER_MOUNT_PATTERN.lastIndex = 0;
      let mount;
      while ((mount = ROUTER_MOUNT_PATTERN.exec(src)) !== null) {
        const prefix = mount[1];
        const varName = mount[2];
        const resolved = importMap.get(varName);
        if (resolved) {
          routePrefixMap.set(resolved, prefix);
          if (process.env.CF_DEBUG_GRAPH === "1") {
            console.log(`[GraphMapper] 📍 Mount: ${path.basename(resolved)} → "${prefix}"`);
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  console.log(`[GraphMapper] Pass 1/2 — extracting nodes…`);

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];
    try {
      const stat = fs.statSync(filePath);
      const mtime = stat.mtimeMs;
      if (!force && alreadyIndexed.has(filePath)) {
        if (Math.abs(alreadyIndexed.get(filePath) - mtime) < 1000) {
          stats.skipped++;
          continue;
        }
      }
      const source = fs.readFileSync(filePath, "utf-8");
      if (source.length > 500_000) {
        stats.skipped++;
        continue;
      }

      const { nodes, edges } = extractSymbols(source, filePath);
      const isSynthetic = nodes.length === 1 && nodes[0].name.startsWith("__module_");
      if (isSynthetic && source.length > 1000) {
        const lang = getLanguageForFile(filePath)?.language;
        const isJsTs = lang === "javascript" || lang === "typescript" || lang === "tsx";
        if (isJsTs)
          console.warn(
            `[GraphMapper] ⚠️  ${path.basename(filePath)} has no named declarations (${source.length} chars) — synthetic __module node created.`
          );
      }

      const { literals, configRefs } = extractLiterals(source, filePath, nodes);
      const summaries = buildNodeSummaries(nodes, literals, configRefs, filePath);
      const retrievalDocs = buildRetrievalDocuments(nodes, literals, configRefs, filePath);

      const mountPrefix = routePrefixMap.get(filePath) || "";
      const routeEdges = extractRouteEdges(source, filePath, mountPrefix);
      const pass1Edges = [...edges, ...routeEdges];

      writeFileGraph({
        filePath,
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
        mtime,
        literals,
        configRefs,
        summaries,
        retrievalDocs,
      });
      stats.indexed++;

      if (onProgress && i % 10 === 0)
        onProgress({
          current: i + 1,
          total: stats.total,
          file: path.relative(workspacePath, filePath),
          ...stats,
        });
      if (i % 5 === 0) await new Promise((r) => setImmediate(r));
    } catch (err) {
      stats.errors++;
      if (process.env.CF_DEBUG_GRAPH === "1")
        console.warn(`[GraphMapper] ⚠️ Failed to index ${filePath}: ${err.message}`);
    }
  }

  console.log(`[GraphMapper] Pass 2/3 — computing cross-file call edges…`);
  const allKnownSymbols = new Set(getAllNodeNames());
  console.log(`[GraphMapper] Global symbol set: ${allKnownSymbols.size} symbols`);

  for (const [filePath, { source, nodes, mtime, literals, configRefs, summaries }] of fileData) {
    try {
      const callEdges = extractCallEdges(source, filePath, nodes, allKnownSymbols);
      if (callEdges.length === 0) continue;
      const { edges: symbolEdges } = extractSymbols(source, filePath);
      const mountPfx = routePrefixMap.get(filePath) || "";
      const routeEdges = extractRouteEdges(source, filePath, mountPfx);
      const allEdges = [...symbolEdges, ...callEdges, ...routeEdges];
      writeFileGraph({
        filePath,
        language: getLanguageForFile(filePath)?.language || "unknown",
        lastModified: mtime,
        nodes,
        edges: allEdges,
        literals,
        configRefs,
        summaries,
      });
    } catch (err) {
      if (process.env.CF_DEBUG_GRAPH === "1")
        console.warn(`[GraphMapper] ⚠️ Pass 2 failed for ${filePath}: ${err.message}`);
    }
    await new Promise((r) => setImmediate(r));
  }

  if (_symbolEmbedder && _symbolRetriever) {
    const allDocs = [];
    for (const [, { retrievalDocs }] of fileData) if (retrievalDocs) allDocs.push(...retrievalDocs);
    if (allDocs.length > 0) {
      console.log(`[GraphMapper] 🧠 Pass 3/3 — embedding ${allDocs.length} symbols into HNSW…`);
      const embedded = await embedRetrievalDocuments(allDocs);
      console.log(`[GraphMapper] ✅ Embedded ${embedded}/${allDocs.length} symbols`);
    }
  }

  const elapsed = Date.now() - startTime;
  const graphStats = getGraphStats();
  console.log(
    `[GraphMapper] ✅ Index complete in ${elapsed}ms | Files: ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.errors} errors | Graph: ${graphStats.node_count} nodes, ${graphStats.edge_count} edges (${graphStats.calls_count} calls, ${graphStats.imports_count} imports, ${graphStats.routes_count} routes)`
  );

  statsEmitter.updateGraphStats({
    nodes: graphStats.node_count,
    edges: graphStats.edge_count,
    files: stats.indexed + stats.skipped,
  });
  for (const [fp] of fileData) {
    const h = getFileHash(fp);
    if (h) fileHashes.set(fp, h);
  }
  return stats;
}

export function watchWorkspace(workspacePath) {
  const pendingFiles = new Set();
  let debounceTimer = null;

  const processChanges = async () => {
    const files = [...pendingFiles];
    pendingFiles.clear();
    if (process.env.CF_DEBUG_GRAPH === "1") {
      console.log(
        `[GraphMapper] 🔄 processChanges triggered for ${files.length} file(s): ` +
          files.map((f) => path.basename(f)).join(", ")
      );
    }
    const allKnownSymbols = new Set(getAllNodeNames());
    let allRetrievalDocs = [];

    for (const filePath of files) {
      if (!getLanguageForFile(filePath)) continue;
      await new Promise((r) => setTimeout(r, 200));

      if (!hasFileChanged(filePath)) {
        if (process.env.CF_DEBUG_GRAPH === "1")
          console.log(`[GraphMapper] ⏭️  Skipped ${path.basename(filePath)} (content unchanged)`);
        continue;
      }

      try {
        const stat = fs.statSync(filePath);
        const source = fs.readFileSync(filePath, "utf-8");
        if (source.length === 0) {
          fileHashes.delete(filePath);
          continue;
        }

        const { nodes, edges } = extractSymbols(source, filePath);
        const isSynthetic = nodes.length === 1 && nodes[0].name.startsWith("__module_");
        if (isSynthetic && source.length > 1000) {
          const lang = getLanguageForFile(filePath)?.language;
          if (lang === "javascript" || lang === "typescript" || lang === "tsx") {
            console.warn(
              `[GraphMapper] ⚠️  ${path.basename(filePath)} re-indexed with synthetic __module node`
            );
          }
        }
        const { literals, configRefs } = extractLiterals(source, filePath, nodes);
        const summaries = buildNodeSummaries(nodes, literals, configRefs, filePath);

        const callEdges = extractCallEdges(source, filePath, nodes, allKnownSymbols);
        const watchMountPrefix = routePrefixMap.get(filePath) || "";
        const routeEdges = extractRouteEdges(source, filePath, watchMountPrefix);
        const allEdges = [...edges, ...callEdges, ...routeEdges];

        writeFileGraph({
          filePath: filePath.replace(/\\/g, "/"),
          language: getLanguageForFile(filePath)?.language || "unknown",
          lastModified: stat.mtimeMs,
          nodes,
          edges: allEdges,
          literals,
          configRefs,
          summaries,
        });

        const retrievalDocs = buildRetrievalDocuments(
          nodes,
          literals,
          configRefs,
          filePath.replace(/\\/g, "/")
        );
        if (_symbolEmbedder && _symbolRetriever && retrievalDocs.length > 0) {
          allRetrievalDocs.push(...retrievalDocs);
        }

        console.log(
          `[GraphMapper] 🔄 Re-indexed: ${path.relative(workspacePath, filePath)} (${nodes.length} nodes, ${allEdges.length} edges, ${callEdges.length} call edges)`
        );
        invalidateCacheForFile(filePath);

        try {
          const updated = getGraphStats();
          statsEmitter.updateGraphStats({
            nodes: updated.node_count,
            edges: updated.edge_count,
            files: updated.file_count,
          });
        } catch {}
      } catch (err) {
        if (err.code !== "ENOENT")
          console.warn(
            `[GraphMapper] ⚠️  Re-index failed for ${path.basename(filePath)}: ${err.code || err.message}`
          );
        fileHashes.delete(filePath);
      }
    }

    // Batch embedding
    if (allRetrievalDocs.length > 0) {
      embedRetrievalDocuments(allRetrievalDocs)
        .then((count) => {
          if (process.env.CF_DEBUG_GRAPH === "1") {
            console.log(
              `[GraphMapper] 🧠 Re-embedded ${count} symbols from ${files.length} changed file(s)`
            );
          }
        })
        .catch(() => {});
    }
  };

  const watcher = fs.watch(workspacePath, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const fullPath = path.join(workspacePath, filename).replace(/\\/g, "/");
    if ([...IGNORE_DIRS].some((d) => fullPath.includes(d))) return;
    if (!getLanguageForFile(fullPath)) return;
    if (IGNORE_PATTERNS.some((p) => p.test(path.basename(fullPath)))) return;
    if (process.env.CF_DEBUG_GRAPH === "1")
      console.log(`[GraphMapper] 👁️  Watch event: ${event} → ${path.basename(fullPath)}`);
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
