/**
 * workspaceMapper.js
 *
 * source_line fix: route edges now carry the line number where the
 * handler is defined. This lets find_route return exact line numbers
 * so the LLM can do a targeted file slice instead of reading the whole file.
 *
 * BARE_URL_PATTERN: detects http.createServer-style handlers that use
 * req.url === "/path" instead of Express app.get("/path").
 * This is what server.js uses — without this, find_route("/v1/stats/stream")
 * returns nothing and the LLM burns 5 retries trying to find the handler.
 */

import fs from "node:fs";
import path from "node:path";
import { statsEmitter } from "../proxy/statsEmitter.js";
import { extractSymbols, getLanguageForFile } from "./symbolExtractor.js";
import {
  writeFileGraph,
  getAllIndexedFiles,
  getGraphStats,
  getAllNodeNames,
} from "./graphDb.js";
import { clearSessionToolCache } from "../proxy/upstreamRequest.js";

// ─────────────────────────────────────────────
// Directory ignore list
// ─────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".claude", "dist", "build", "out",
  ".next", ".nuxt", "coverage", "__pycache__", ".pytest_cache",
  "target", "vendor", "native/build", "models",
]);

const IGNORE_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.bundle\.js$/,
  /\.d\.ts$/,
  /\.map$/,
  /\.lock$/,
];

// ─────────────────────────────────────────────
// Route detection patterns
// ─────────────────────────────────────────────

// Express/Fastify/Hono style: app.get('/path', handler)
const ROUTE_PATTERN =
  /(?:app|router|server|fastify|hono)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// http.createServer style: req.url === '/path' or req.url.startsWith('/path')
// This is what server.js uses — completely missed by ROUTE_PATTERN above.
// Captures the URL string literal from bare conditional checks.
const BARE_URL_PATTERN =
  /req\.url\s*(?:===|!==|startsWith\s*\()\s*['"`]([^'"`]+)['"`]/g;

// ─────────────────────────────────────────────
// Call expression patterns
// ─────────────────────────────────────────────

const CALL_EXPRESSION_PATTERN = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

const CALL_EXCLUSIONS = new Set([
  "if", "for", "while", "switch", "catch", "function", "class", "return",
  "typeof", "instanceof", "new", "await", "yield", "import", "export",
  "const", "let", "var", "async", "static", "get", "set",
  "console", "Math", "JSON", "Object", "Array", "String", "Number",
  "Boolean", "Promise", "Error", "Date", "Map", "Set", "Symbol",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "setImmediate", "process", "Buffer", "require",
  "performance", "crypto",
]);

// ─────────────────────────────────────────────
// extractCallEdges
// ─────────────────────────────────────────────

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
        callee === node.name   ||
        CALL_EXCLUSIONS.has(callee) ||
        !knownSymbols.has(callee)   ||
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

// ─────────────────────────────────────────────
// extractRouteEdges
//
// Now detects BOTH Express-style and bare req.url handlers.
// Returns sourceLine so find_route can give the LLM an exact
// line number to target with contextforge_retrieve.
// ─────────────────────────────────────────────

function extractRouteEdges(source, filePath) {
  const routeEdges = [];

  // Helper: convert a character offset to a line number
  function offsetToLine(offset) {
    let line = 0;
    for (let i = 0; i < offset && i < source.length; i++) {
      if (source[i] === "\n") line++;
    }
    return line;
  }

  // ── Express/Fastify/Hono routes ──
  ROUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = ROUTE_PATTERN.exec(source)) !== null) {
    const method     = match[1].toUpperCase();
    const routePath  = match[2];
    const sourceLine = offsetToLine(match.index);

    routeEdges.push({
      sourceSymbol: null,
      targetSymbol: `${method} ${routePath}`,
      targetFile:   null,
      relation:     "defines_route",
      sourceLine,
    });
  }

  // ── http.createServer bare req.url handlers ──
  // Detects patterns like:
  //   if (req.url === "/v1/stats/stream" && req.method === "GET")
  //   if (req.url.startsWith("/v1/cache/"))
  // These are the handlers in server.js — Express pattern never fires there.
  BARE_URL_PATTERN.lastIndex = 0;
  while ((match = BARE_URL_PATTERN.exec(source)) !== null) {
    const routePath  = match[1];
    const sourceLine = offsetToLine(match.index);

    // Detect HTTP method from context — look for req.method === "X" nearby
    const contextWindow = source.slice(
      Math.max(0, match.index - 10),
      match.index + match[0].length + 100,
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
// File discovery
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

// ─────────────────────────────────────────────
// Incremental index check
// ─────────────────────────────────────────────

function buildIndexedFileMap() {
  const indexed = getAllIndexedFiles();
  const map     = new Map();
  for (const row of indexed) map.set(row.file_path, row.last_modified);
  return map;
}

// ─────────────────────────────────────────────
// indexWorkspace — two-pass
// ─────────────────────────────────────────────

export async function indexWorkspace(workspacePath, options = {}) {
  const { force = false, onProgress = null } = options;

  console.log(`[GraphMapper] 🗺️  Starting workspace index: ${workspacePath}`);
  const startTime = Date.now();

  const alreadyIndexed = force ? new Map() : buildIndexedFileMap();
  const stats = { indexed: 0, skipped: 0, errors: 0, total: 0 };

  const allFiles = [];
  for (const filePath of walkDirectory(workspacePath)) allFiles.push(filePath);
  stats.total = allFiles.length;

  console.log(`[GraphMapper] Found ${stats.total} indexable files`);

  /** @type {Map<string, { source: string, nodes: Array, mtime: number }>} */
  const fileData = new Map();

  console.log(`[GraphMapper] Pass 1/2 — extracting nodes…`);

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];

    try {
      const stat  = fs.statSync(filePath);
      const mtime = stat.mtimeMs;

      if (!force && alreadyIndexed.has(filePath)) {
        if (Math.abs(alreadyIndexed.get(filePath) - mtime) < 1000) {
          stats.skipped++;
          continue;
        }
      }

      const source = fs.readFileSync(filePath, "utf-8");
      if (source.length > 500_000) { stats.skipped++; continue; }

      const { nodes, edges } = extractSymbols(source, filePath);

      // G7: warn for JS/TS files with no named declarations
      const isSynthetic = nodes.length === 1 && nodes[0].name.startsWith("__module_");
      if (isSynthetic && source.length > 1000) {
        const lang   = getLanguageForFile(filePath)?.language;
        const isJsTs = lang === "javascript" || lang === "typescript" || lang === "tsx";
        if (isJsTs) {
          console.warn(
            `[GraphMapper] ⚠️  ${path.basename(filePath)} has no named declarations ` +
            `(${source.length} chars) — synthetic __module node created.`,
          );
        }
      }

      const routeEdges = extractRouteEdges(source, filePath);
      const pass1Edges = [...edges, ...routeEdges];

      writeFileGraph({
        filePath,
        language:     getLanguageForFile(filePath)?.language || "unknown",
        lastModified: mtime,
        nodes,
        edges: pass1Edges,
      });

      fileData.set(filePath, { source, nodes, mtime });
      stats.indexed++;

      if (onProgress && i % 10 === 0) {
        onProgress({ current: i + 1, total: stats.total,
          file: path.relative(workspacePath, filePath), ...stats });
      }
      if (i % 5 === 0) await new Promise((r) => setImmediate(r));

    } catch (err) {
      stats.errors++;
      if (process.env.CF_DEBUG_GRAPH === "1") {
        console.warn(`[GraphMapper] ⚠️ Failed to index ${filePath}: ${err.message}`);
      }
    }
  }

  console.log(`[GraphMapper] Pass 2/2 — computing cross-file call edges…`);

  const allKnownSymbols = new Set(getAllNodeNames());
  console.log(`[GraphMapper] Global symbol set: ${allKnownSymbols.size} symbols`);

  for (const [filePath, { source, nodes, mtime }] of fileData) {
    try {
      const callEdges = extractCallEdges(source, filePath, nodes, allKnownSymbols);
      if (callEdges.length === 0) continue;

      const { edges: symbolEdges } = extractSymbols(source, filePath);
      const routeEdges = extractRouteEdges(source, filePath);
      const allEdges   = [...symbolEdges, ...callEdges, ...routeEdges];

      writeFileGraph({
        filePath,
        language:     getLanguageForFile(filePath)?.language || "unknown",
        lastModified: mtime,
        nodes,
        edges: allEdges,
      });
    } catch (err) {
      if (process.env.CF_DEBUG_GRAPH === "1") {
        console.warn(`[GraphMapper] ⚠️ Pass 2 failed for ${filePath}: ${err.message}`);
      }
    }
    await new Promise((r) => setImmediate(r));
  }

  const elapsed    = Date.now() - startTime;
  const graphStats = getGraphStats();

  console.log(
    `[GraphMapper] ✅ Index complete in ${elapsed}ms | ` +
    `Files: ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.errors} errors | ` +
    `Graph: ${graphStats.node_count} nodes, ${graphStats.edge_count} edges ` +
    `(${graphStats.calls_count} calls, ${graphStats.imports_count} imports, ` +
    `${graphStats.routes_count} routes)`,
  );

  statsEmitter.updateGraphStats({
    nodes: graphStats.node_count,
    edges: graphStats.edge_count,
    files: stats.indexed + stats.skipped,
  });

  return stats;
}

// ─────────────────────────────────────────────
// watchWorkspace
// ─────────────────────────────────────────────

export function watchWorkspace(workspacePath) {
  const pendingFiles = new Set();
  let debounceTimer  = null;

  const processChanges = async () => {
    const files = [...pendingFiles];
    pendingFiles.clear();

    if (process.env.CF_DEBUG_GRAPH === "1") {
      console.log(
        `[GraphMapper] 🔄 processChanges triggered for ${files.length} file(s): ` +
        files.map((f) => path.basename(f)).join(", "),
      );
    }

    const allKnownSymbols = new Set(getAllNodeNames());

    for (const filePath of files) {
      if (!getLanguageForFile(filePath)) continue;

      // W2: wait for editor/PatchEngine to flush
      await new Promise((r) => setTimeout(r, 200));

      try {
        const stat   = fs.statSync(filePath);
        const source = fs.readFileSync(filePath, "utf-8");

        if (source.length === 0) {
          console.warn(`[GraphMapper] ⚠️  ${path.basename(filePath)} read as empty — skipping`);
          continue;
        }

        const { nodes, edges } = extractSymbols(source, filePath);

        const isSynthetic = nodes.length === 1 && nodes[0].name.startsWith("__module_");
        if (isSynthetic && source.length > 1000) {
          const lang   = getLanguageForFile(filePath)?.language;
          const isJsTs = lang === "javascript" || lang === "typescript" || lang === "tsx";
          if (isJsTs) {
            console.warn(
              `[GraphMapper] ⚠️  ${path.basename(filePath)} re-indexed with synthetic __module node`,
            );
          }
        }

        const callEdges  = extractCallEdges(source, filePath, nodes, allKnownSymbols);
        const routeEdges = extractRouteEdges(source, filePath);
        const allEdges   = [...edges, ...callEdges, ...routeEdges];

        writeFileGraph({
          filePath:     filePath.replace(/\\/g, "/"),
          language:     getLanguageForFile(filePath)?.language || "unknown",
          lastModified: stat.mtimeMs,
          nodes,
          edges: allEdges,
        });

        console.log(
          `[GraphMapper] 🔄 Re-indexed: ${path.relative(workspacePath, filePath)} ` +
          `(${nodes.length} nodes, ${allEdges.length} edges, ${callEdges.length} call edges)`,
        );

        // Clear session tool cache so next request gets fresh graph data
        clearSessionToolCache();

        try {
          const updated = getGraphStats();
          statsEmitter.updateGraphStats({
            nodes: updated.node_count,
            edges: updated.edge_count,
            files: updated.file_count,
          });
        } catch { /* non-critical */ }

      } catch (err) {
        if (err.code !== "ENOENT") {
          console.warn(
            `[GraphMapper] ⚠️  Re-index failed for ${path.basename(filePath)}: ` +
            `${err.code || err.message}`,
          );
        }
      }
    }
  };

  const watcher = fs.watch(
    workspacePath,
    { recursive: true },
    (event, filename) => {
      if (!filename) return;
      const fullPath = path.join(workspacePath, filename).replace(/\\/g, "/");
      if ([...IGNORE_DIRS].some((d) => fullPath.includes(d))) return;
      if (!getLanguageForFile(fullPath)) return;
      if (IGNORE_PATTERNS.some((p) => p.test(path.basename(fullPath)))) return;

      if (process.env.CF_DEBUG_GRAPH === "1") {
        console.log(`[GraphMapper] 👁️  Watch event: ${event} → ${path.basename(fullPath)}`);
      }

      pendingFiles.add(fullPath);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(processChanges, 800);
    },
  );

  console.log(`[GraphMapper] 👁️  Watching: ${workspacePath}`);

  return {
    stop: () => {
      watcher.close();
      clearTimeout(debounceTimer);
      console.log("[GraphMapper] Watcher stopped");
    },
  };
}