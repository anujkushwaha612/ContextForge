/**
 * patchEngine.js
 *
 * Write-side counterpart to vaultRetriever.js.
 *
 * Given a symbol name, a file path, and a replacement body,
 * locates the symbol in the graph index, splices the file on disk,
 * re-indexes the file, and returns a structured result for the LLM.
 *
 * LINE INDEXING CONTRACT:
 *   graphDb stores 0-based line numbers as emitted by Tree-sitter.
 *   All slice operations in this file use 0-based indices directly.
 *   No +1 / -1 corrections are applied — the DB values are used as-is.
 *
 *   start_line  → first line of the full node (including signature)
 *   end_line    → last line of the full node (inclusive, 0-based)
 *   body_start_line → first line of the body (after opening brace)
 *   body_end_line   → last line of the body (before closing brace)
 *
 *   Slice convention:
 *     lines.slice(0, start_line)          → everything before symbol
 *     lines.slice(start_line, end_line+1) → the symbol itself
 *     lines.slice(end_line + 1)           → everything after symbol
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { queryFindSymbol, writeFileGraph } from "./graphDb.js";
import { extractSymbols, getLanguageForFile } from "./symbolExtractor.js";
import { invalidateByFile } from "../logging/cacheDb.js";
import { invalidateRegistryEntry } from "../compression/semanticDedup.js";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

export const PATCH_OPERATIONS = {
  REPLACE_BODY: "replace_body",
  INSERT_AFTER: "insert_after",
  INSERT_BEFORE: "insert_before",
  DELETE: "delete",
};

const MAX_PATCHABLE_FILE_SIZE = 500_000;

// ─────────────────────────────────────────────
// Symbol resolution
// ─────────────────────────────────────────────

/**
 * Resolve a symbol to its graph record, verifying it lives in the
 * requested file. Accepts relative and absolute path variants.
 *
 * @returns {{ row, normalizedFilePath } | { error: string }}
 */
function resolveSymbol(symbolName, filePath) {
  const rows = queryFindSymbol(symbolName);

  if (!rows || rows.length === 0) {
    return {
      error:
        `Symbol '${symbolName}' not found in graph index. ` +
        `Verify the exact declared name or run a graph re-index.`,
    };
  }

  const normalizedRequest = filePath.replace(/\\/g, "/").replace(/^\.\//, "");

  const matchingRow = rows.find((r) => {
    const indexedPath = r.file_path.replace(/\\/g, "/");
    return (
      indexedPath === normalizedRequest ||
      indexedPath.endsWith("/" + normalizedRequest) ||
      normalizedRequest.endsWith("/" + indexedPath) ||
      indexedPath === normalizedRequest.replace(/^\/+/, "")
    );
  });

  if (!matchingRow) {
    const foundIn = rows.map((r) => r.file_path).join(", ");
    return {
      error:
        `Symbol '${symbolName}' is indexed but not in '${filePath}'. ` +
        `Found in: ${foundIn}. Check the file_path argument.`,
    };
  }

  return { row: matchingRow, normalizedFilePath: matchingRow.file_path };
}

// ─────────────────────────────────────────────
// Body integrity check
// ─────────────────────────────────────────────

/**
 * Verify the body stored in the graph matches what is currently on disk.
 *
 * Uses body_text (stored at index time) as ground truth.
 * body_start_line / body_end_line are 0-based, sourced directly from
 * Tree-sitter — no offset correction needed.
 *
 * If the check fails, the caller re-indexes before patching.
 *
 * @param {string[]} lines   — current file split by "\n"
 * @param {object}   row     — graph node row from queryFindSymbol
 * @returns {{ stale: boolean, reason?: string }}
 */
function checkBodyIntegrity(lines, row) {
  if (!row.body_text) {
    // No body stored (e.g. import node) — proceed on line numbers alone
    return { stale: false };
  }

  // body_start_line and body_end_line are 0-based.
  // body_end_line is the last line inclusive — slice end must be +1.
  const bodyStart = row.body_start_line ?? row.start_line;
  const bodyEnd = row.body_end_line ?? row.end_line;

  if (bodyStart < 0 || bodyEnd >= lines.length) {
    return {
      stale: true,
      reason:
        `Body line range ${bodyStart}–${bodyEnd} out of bounds ` +
        `(file has ${lines.length} lines). File edited since last index.`,
    };
  }

  // Slice is 0-based start, exclusive end → bodyEnd + 1
  const currentBody = lines
    .slice(bodyStart, bodyEnd + 1)
    .join("\n")
    .trim();
  const indexedBody = row.body_text.trim();

  if (currentBody !== indexedBody) {
    return {
      stale: true,
      reason:
        `Body mismatch at lines ${bodyStart}–${bodyEnd}. ` +
        `File has been modified since last index.`,
    };
  }

  return { stale: false };
}

// ─────────────────────────────────────────────
// Indentation preservation
// ─────────────────────────────────────────────

/**
 * Re-indent new_body to match the indentation of the original symbol.
 *
 * Problem: LLM generates new_body starting at column 0 (flat).
 * If the target symbol is indented (e.g. a method inside a class),
 * writing flat text corrupts the file's formatting.
 * For Python, this also breaks semantics.
 *
 * Algorithm:
 *   1. Capture leading whitespace from the first line of the original symbol.
 *   2. Find the minimum indentation already present in new_body (strip base).
 *   3. Prepend the captured indent to every non-blank line.
 *
 * @param {string}   newBody      — replacement code from LLM
 * @param {string[]} fileLines    — current file lines (0-based)
 * @param {number}   startLine    — 0-based start line of original symbol
 * @returns {string[]}            — re-indented lines ready for splice
 */
function reindentBody(newBody, fileLines, startLine) {
  const originalFirstLine = fileLines[startLine] || "";
  const indentMatch = originalFirstLine.match(/^(\s+)/);
  const baseIndent = indentMatch ? indentMatch[1] : "";

  // No indentation on original → nothing to do
  if (!baseIndent) return newBody.split("\n");

  const bodyLines = newBody.split("\n");

  // Find minimum existing indent in new_body (ignoring blank lines)
  // so we strip it cleanly before applying the file's indent level.
  const existingIndents = bodyLines
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const m = l.match(/^(\s*)/);
      return m ? m[1].length : 0;
    });

  const minIndent =
    existingIndents.length > 0 ? Math.min(...existingIndents) : 0;

  return bodyLines.map((l) => {
    if (l.trim().length === 0) return ""; // blank line — no indent
    const stripped = l.slice(minIndent); // strip LLM's base indent
    return baseIndent + stripped; // apply file's indent
  });
}

// ─────────────────────────────────────────────
// Line splice
// ─────────────────────────────────────────────

/**
 * Apply the patch operation to the file's lines array.
 *
 * LINE INDEXING:
 *   start_line and end_line are 0-based (as stored in graphDb).
 *   end_line is the last line of the symbol, inclusive.
 *   Slice to exclude: lines.slice(end_line + 1) gets everything after.
 *
 * @param {string[]} lines      — current file lines
 * @param {object}   row        — graph node (start_line, end_line are 0-based)
 * @param {string}   newBody    — replacement source from LLM
 * @param {string}   operation  — PATCH_OPERATIONS value
 * @returns {string[]}          — modified lines array
 */
function applyLineSplice(lines, row, newBody, operation) {
  // 0-based, used directly — no offset correction
  const startIdx = row.start_line;
  const endIdx = row.end_line;

  // Re-indent before splicing
  const newLines = reindentBody(newBody, lines, startIdx);

  switch (operation) {
    case PATCH_OPERATIONS.REPLACE_BODY:
      return [
        ...lines.slice(0, startIdx), // before symbol
        ...newLines, // replacement
        ...lines.slice(endIdx + 1), // after symbol
      ];

    case PATCH_OPERATIONS.INSERT_AFTER:
      return [
        ...lines.slice(0, endIdx + 1), // up to and including symbol
        ...newLines,
        ...lines.slice(endIdx + 1), // rest of file
      ];

    case PATCH_OPERATIONS.INSERT_BEFORE:
      return [
        ...lines.slice(0, startIdx), // before symbol
        ...newLines,
        ...lines.slice(startIdx), // symbol onward
      ];

    case PATCH_OPERATIONS.DELETE:
      return [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)];

    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

// ─────────────────────────────────────────────
// Atomic write
// ─────────────────────────────────────────────

/**
 * Write content atomically.
 * Temp file → rename prevents partial writes on crash.
 * On POSIX rename is atomic. On Windows: best-effort.
 */
function atomicWrite(filePath, content) {
  const tmpPath = filePath + ".cf_tmp";
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// Re-index
// ─────────────────────────────────────────────

/**
 * Re-index a single file after patching.
 * Synchronous — graph must be current before we return the result
 * so the next contextforge_query_graph call sees updated line numbers.
 */
function reindexFile(filePath, newSource) {
  try {
    const langInfo = getLanguageForFile(filePath);
    const language = langInfo?.language || "unknown";
    const stat = fs.statSync(filePath);
    const { nodes, edges } = extractSymbols(newSource, filePath);

    writeFileGraph({
      filePath: filePath.replace(/\\/g, "/"),
      language,
      lastModified: stat.mtimeMs,
      nodes,
      edges,
    });

    console.log(
      `[PatchEngine] 🔄 Re-indexed ${filePath} ` +
        `(${nodes.length} nodes, ${edges.length} edges)`,
    );
  } catch (err) {
    // Non-fatal — graph self-heals on next watchWorkspace event
    console.error(
      `[PatchEngine] ⚠️  Re-index failed for ${filePath}: ${err.message}`,
    );
  }
}

// ─────────────────────────────────────────────
// Diff summary
// ─────────────────────────────────────────────

function buildDiffSummary(linesBefore, linesAfter, startLine, endLine) {
  const removed = endLine - startLine + 1; // 0-based inclusive range
  const netDelta = linesAfter - linesBefore;
  const sign = netDelta >= 0 ? "+" : "";
  return `${sign}${netDelta} lines net (${removed} removed, ${removed + netDelta} inserted)`;
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

/**
 * Apply a patch to a source file.
 *
 * @param {object} args
 * @param {string} args.file_path
 * @param {string} args.target_symbol
 * @param {string} args.new_body
 * @param {string} args.operation
 * @param {object} [args.semanticCache]   — for vault cache invalidation
 *
 * @returns {object}  always has { success: boolean }
 */
export async function executePatch({
  file_path,
  target_symbol,
  new_body = "",
  operation = PATCH_OPERATIONS.REPLACE_BODY,
  semanticCache = null,
}) {
  console.log(
    `[PatchEngine] 🩹 ${operation}('${target_symbol}') in ${file_path}`,
  );

  // ── Validate operation ──
  if (!Object.values(PATCH_OPERATIONS).includes(operation)) {
    return {
      success: false,
      error: `Unknown operation '${operation}'. Valid: ${Object.values(PATCH_OPERATIONS).join(", ")}`,
    };
  }

  if (operation !== PATCH_OPERATIONS.DELETE && !new_body?.trim()) {
    return {
      success: false,
      error: "new_body is required for non-delete operations",
    };
  }

  // ── Resolve symbol ──
  const resolved = resolveSymbol(target_symbol, file_path);
  if (resolved.error) {
    return { success: false, error: resolved.error };
  }

  let { row, normalizedFilePath } = resolved;

  // ── Read file ──
  let source;
  try {
    source = fs.readFileSync(normalizedFilePath, "utf-8");
  } catch (err) {
    return {
      success: false,
      error: `Cannot read '${normalizedFilePath}': ${err.message}`,
    };
  }

  if (source.length > MAX_PATCHABLE_FILE_SIZE) {
    return {
      success: false,
      error: `File too large to patch (${source.length} chars > ${MAX_PATCHABLE_FILE_SIZE})`,
    };
  }

  const lines = source.split("\n");

  // ── Integrity check — re-index if stale ──
  const integrity = checkBodyIntegrity(lines, row);
  if (integrity.stale) {
    console.log(
      `[PatchEngine] ⚠️  Stale index: ${integrity.reason}. Re-indexing...`,
    );
    reindexFile(normalizedFilePath, source);

    // Re-resolve with fresh data
    const fresh = resolveSymbol(target_symbol, file_path);
    if (fresh.error) {
      return { success: false, error: `After re-index: ${fresh.error}` };
    }
    row = fresh.row;
  }

  // ── Safety check: incomplete new_body guard ──────────────────────────────
  // If new_body is suspiciously shorter than the original symbol,
  // the LLM likely generated from a truncated body reference.
  // Reject early — no disk write occurs.
  if (operation === PATCH_OPERATIONS.REPLACE_BODY) {
    const symbolLineCount = row.end_line - row.start_line + 1;
    const newBodyLineCount = new_body.split("\n").length;
    const SUSPICIOUS_RATIO = 0.3;

    if (
      symbolLineCount > 20 &&
      newBodyLineCount < symbolLineCount * SUSPICIOUS_RATIO
    ) {
      return {
        success: false,
        error:
          `Safety check: new_body is ${newBodyLineCount} lines but ` +
          `'${target_symbol}' is ${symbolLineCount} lines in the graph. ` +
          `new_body appears incomplete. ` +
          `Call contextforge_retrieve(vault_id, search_query:"${target_symbol}") ` +
          `to retrieve just this function, then resubmit with the complete body.`,
        hint: "retrieve_symbol_not_file",
        symbol: target_symbol,
        symbol_lines: symbolLineCount,
        new_body_lines: newBodyLineCount,
      };
    }
  }

  // ── Splice ──
  let newLines;
  try {
    newLines = applyLineSplice(lines, row, new_body, operation);
  } catch (err) {
    return { success: false, error: `Splice failed: ${err.message}` };
  }

  const newSource = newLines.join("\n");

  // ── Atomic write ──
  try {
    atomicWrite(normalizedFilePath, newSource);
  } catch (err) {
    return { success: false, error: `Write failed: ${err.message}` };
  }

  console.log(
    `[PatchEngine] ✅ Written: ${normalizedFilePath} ` +
      `(${lines.length} → ${newLines.length} lines)`,
  );

  // ── Re-index ──
  reindexFile(normalizedFilePath, newSource);

  // ── Full cache invalidation ──
  // Three layers must all be cleared:
  //   1. SQLite vault entries for this file path
  //   2. Semantic vector cache entries
  //   3. SemanticDedup in-process SimHash registry
  try {
    const newHash = crypto.createHash("sha256").update(newSource).digest("hex");

    invalidateByFile(normalizedFilePath, newHash, semanticCache);
    console.log(
      `[PatchEngine] 🗑️  Vault cache invalidated: ${normalizedFilePath}`,
    );
  } catch (err) {
    console.warn(`[PatchEngine] ⚠️  Vault invalidation failed: ${err.message}`);
  }

  try {
    invalidateRegistryEntry(normalizedFilePath);
  } catch (err) {
    console.warn(
      `[PatchEngine] ⚠️  SimHash registry invalidation failed: ${err.message}`,
    );
  }

  // ── Result ──
  const diffSummary = buildDiffSummary(
    lines.length,
    newLines.length,
    row.start_line,
    row.end_line,
  );

  return {
    success: true,
    file: normalizedFilePath,
    symbol: target_symbol,
    operation,
    lines_before: row.start_line, // 0-based, as stored
    lines_after: row.end_line, // 0-based, as stored
    file_lines_before: lines.length,
    file_lines_after: newLines.length,
    diff_summary: diffSummary,
    message:
      `Patch applied. '${target_symbol}' in ${normalizedFilePath} updated ` +
      `(${diffSummary}). Graph re-indexed. ` +
      `Use contextforge_query_graph find_symbol to verify new line numbers.`,
  };
}
