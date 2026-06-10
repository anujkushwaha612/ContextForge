/**
 * workspaceMapper.js
 *
 * Walks the workspace directory, extracts symbols from every source file,
 * and writes the results to graph.db.
 *
 * Design decisions:
 *   - Runs at server boot in the background (non-blocking)
 *   - Incremental: skips files where mtime matches the indexed record
 *   - Rate-limited: yields between files to not starve the event loop
 *   - Ignores: node_modules, .git, build/, dist/, native/build/
 */

import fs   from "node:fs";
import path from "node:path";

import { extractSymbols, getLanguageForFile } from "./symbolExtractor.js";
import {
  writeFileGraph,
  getAllIndexedFiles,
  getGraphStats,
} from "./graphDb.js";

// ─────────────────────────────────────────────
// Directory ignore list
// ─────────────────────────────────────────────

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
  "target",          // Rust build output
  "vendor",          // Go vendor
  "native/build",    // Your compiled native modules
  "models",          // ONNX models — binary, not source
]);

const IGNORE_PATTERNS = [
  /\.min\.(js|css)$/,    // minified files
  /\.bundle\.js$/,
  /\.d\.ts$/,            // TypeScript declaration files (auto-generated)
  /\.map$/,              // source maps
  /\.lock$/,             // lockfiles
];

// ─────────────────────────────────────────────
// File discovery
// ─────────────────────────────────────────────

/**
 * Walk directory recursively, yield all indexable file paths.
 * Generator — lazy, doesn't load file contents.
 *
 * @param {string} rootDir
 * @yields {string} absolute file path
 */
function* walkDirectory(rootDir) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return; // Permission denied or doesn't exist
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      // Check if this directory should be ignored
      const dirName = entry.name;
      if (IGNORE_DIRS.has(dirName)) continue;

      // Also check full path patterns (handles "native/build")
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
      if ([...IGNORE_DIRS].some((d) => relativePath.includes(d))) continue;

      yield* walkDirectory(fullPath);
    } else if (entry.isFile()) {
      // Check if this file type is indexable
      if (!getLanguageForFile(fullPath)) continue;

      // Check ignore patterns
      if (IGNORE_PATTERNS.some((p) => p.test(entry.name))) continue;

      yield fullPath.replace(/\\/g, "/");
    }
  }
}

// ─────────────────────────────────────────────
// Incremental index check
// ─────────────────────────────────────────────

/**
 * Build a Map of already-indexed files and their mtimes.
 * Used to skip files that haven't changed.
 */
function buildIndexedFileMap() {
  const indexed = getAllIndexedFiles();
  const map     = new Map();
  for (const row of indexed) {
    map.set(row.file_path, row.last_modified);
  }
  return map;
}

// ─────────────────────────────────────────────
// Main mapper
// ─────────────────────────────────────────────

/**
 * Index the entire workspace.
 * Runs incrementally — only re-indexes files that have changed.
 *
 * @param {string}   workspacePath  - Root directory to index
 * @param {object}   options
 * @param {boolean}  options.force  - Re-index all files even if unchanged
 * @param {Function} options.onProgress - Called with progress updates
 * @returns {Promise<{ indexed: number, skipped: number, errors: number }>}
 */
export async function indexWorkspace(workspacePath, options = {}) {
  const { force = false, onProgress = null } = options;

  console.log(`[GraphMapper] 🗺️  Starting workspace index: ${workspacePath}`);
  const startTime = Date.now();

  // Build incremental check map
  const alreadyIndexed = force ? new Map() : buildIndexedFileMap();

  const stats = { indexed: 0, skipped: 0, errors: 0, total: 0 };

  // Collect all files first (fast — just stat calls)
  const allFiles = [];
  for (const filePath of walkDirectory(workspacePath)) {
    allFiles.push(filePath);
  }
  stats.total = allFiles.length;

  console.log(`[GraphMapper] Found ${stats.total} indexable files`);

  // Process files with event loop yield between each
  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];

    try {
      // Check mtime for incremental skip
      const stat = fs.statSync(filePath);
      const mtime = stat.mtimeMs;

      if (!force && alreadyIndexed.has(filePath)) {
        const indexedMtime = alreadyIndexed.get(filePath);
        if (Math.abs(indexedMtime - mtime) < 1000) {
          // File unchanged (within 1 second tolerance)
          stats.skipped++;
          continue;
        }
      }

      // Read file
      const source = fs.readFileSync(filePath, "utf-8");

      // Skip very large files (> 500KB) — likely generated
      if (source.length > 500_000) {
        stats.skipped++;
        continue;
      }

      // Extract symbols
      const { nodes, edges } = extractSymbols(source, filePath);

      // Write to graph.db
      writeFileGraph({
        filePath,
        language:     getLanguageForFile(filePath)?.language || "unknown",
        lastModified: mtime,
        nodes,
        edges,
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

      // Yield to event loop every 5 files — prevents blocking server
      if (i % 5 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

    } catch (err) {
      stats.errors++;
      // Don't crash the mapper on individual file errors
      if (process.env.CF_DEBUG_GRAPH === "1") {
        console.warn(`[GraphMapper] ⚠️ Failed to index ${filePath}: ${err.message}`);
      }
    }
  }

  const elapsed = Date.now() - startTime;
  const graphStats = getGraphStats();

  console.log(
    `[GraphMapper] ✅ Index complete in ${elapsed}ms | ` +
    `Files: ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.errors} errors | ` +
    `Graph: ${graphStats.node_count} nodes, ${graphStats.edge_count} edges`,
  );

  return stats;
}

/**
 * Watch for file changes and re-index incrementally.
 * Uses fs.watch — no extra dependencies.
 *
 * @param {string} workspacePath
 * @returns {{ stop: Function }} watcher handle
 */
export function watchWorkspace(workspacePath) {
  // Debounce — collect changes for 500ms before re-indexing
  const pendingFiles = new Set();
  let debounceTimer  = null;

  const processChanges = async () => {
    const files = [...pendingFiles];
    pendingFiles.clear();

    for (const filePath of files) {
      if (!getLanguageForFile(filePath)) continue;

      try {
        const stat   = fs.statSync(filePath);
        const source = fs.readFileSync(filePath, "utf-8");
        const { nodes, edges } = extractSymbols(source, filePath);

        writeFileGraph({
          filePath: filePath.replace(/\\/g, "/"),
          language: getLanguageForFile(filePath)?.language || "unknown",
          lastModified: stat.mtimeMs,
          nodes,
          edges,
        });

        console.log(
          `[GraphMapper] 🔄 Re-indexed: ${path.relative(workspacePath, filePath)} ` +
          `(${nodes.length} nodes, ${edges.length} edges)`,
        );
      } catch {
        // File deleted or permission error — ignore
      }
    }
  };

  const watcher = fs.watch(workspacePath, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const fullPath = path.join(workspacePath, filename).replace(/\\/g, "/");

    // Skip ignored paths
    if ([...IGNORE_DIRS].some((d) => fullPath.includes(d))) return;

    pendingFiles.add(fullPath);

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processChanges, 500);
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