/**
 * patchEngine.js
 *
 * Fixes applied:
 *   PE-1: Path normalization extracted to resolveFilePath() helper —
 *         was copy-pasted 4 times with subtle differences.
 *
 *   PE-3: findFuzzyMatch rewritten to avoid O(n²) string allocations.
 *         Now precomputes token sequences and uses a rolling window
 *         with character-count pre-filter before full token comparison.
 *
 *   PE-4: replaceAll now checks occurrence count before applying.
 *         If search_string appears more than once, returns an error
 *         asking for a more specific string — prevents silent multi-replace.
 *
 *   PE-5: checkBodyIntegrity boundary check fixed from < 0 to < 1
 *         (line numbers are 1-indexed, never 0).
 *
 *   PE-7: insert_at_line trims trailing newline from new_body before
 *         splitting — prevents extra blank line insertion.
 *
 *   capBodyText removal: find_symbol no longer truncates function bodies.
 *         Truncation forced a mandatory extra read hop for every large
 *         function. find_symbol now returns metadata only (file, lines,
 *         complexity). read_function returns the full body with no limit.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { queryFindSymbol, writeFileGraph, getWorkspaceRoot } from "./graphDb.js";
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
  REPLACE_STRING: "replace_string",
  INSERT_AT_LINE: "insert_at_line",
};

const MAX_PATCHABLE_FILE_SIZE = 500_000;

// ─────────────────────────────────────────────
// PE-1: Canonical file path resolver
//
// Extracted from 4 copy-paste sites. Converts any path the LLM
// may provide (absolute Windows, absolute POSIX, relative) to
// an absolute path using the workspace root as the base for
// relative paths.
// ─────────────────────────────────────────────

function resolveFilePath(filePath) {
  let p = filePath.replace(/\\/g, "/").replace(/^\.\//, "");

  // Already absolute
  if (path.isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    return p;
  }

  // Relative — resolve against workspace root
  return path.resolve(getWorkspaceRoot(), p).replace(/\\/g, "/");
}

// ─────────────────────────────────────────────
// CRLF-safe file reader
// ─────────────────────────────────────────────

function readSource(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const hasCRLF = raw.includes("\r\n");
  const source = hasCRLF ? raw.replace(/\r\n/g, "\n") : raw;
  return { source, hasCRLF };
}

// ─────────────────────────────────────────────
// PE-3: Fuzzy match helper — O(n) rewrite
//
// Old implementation: O(n²) sliding window with string allocations
// per candidate. On a 5000-line file with a 10-line needle this
// produced ~35,000 string allocations, blocking the event loop
// for 100ms+.
//
// New implementation:
//   1. Precompute needle token sequence (strip all whitespace)
//   2. Precompute per-line token sequences once
//   3. Use a rolling window: subtract departing line tokens,
//      add arriving line tokens
//   4. Character count pre-filter: skip windows whose total
//      character count differs by more than 30% from needle
//      (fast integer comparison before string join)
// ─────────────────────────────────────────────

function findFuzzyMatch(source, searchString) {
  const needleRaw = searchString.replace(/\r\n/g, "\n");
  const needleTokens = needleRaw.replace(/\s+/g, "");
  if (needleTokens.length === 0) return null;

  const needleLines = needleRaw.split("\n");
  const needleLineCount = needleLines.length;

  const sourceLines = source.split("\n");
  const totalLines = sourceLines.length;

  // Precompute per-line token strings — done once, O(n)
  const lineTokens = sourceLines.map((l) => l.replace(/\s+/g, ""));

  // Window size: needle ± 3 lines to handle blank line differences
  const minWindow = Math.max(1, needleLineCount - 3);
  const maxWindow = needleLineCount + 3;

  // Character count pre-filter bounds (30% tolerance)
  const needleCharCount = needleTokens.length;
  const minChars = Math.floor(needleCharCount * 0.7);
  const maxChars = Math.ceil(needleCharCount * 1.3);

  for (let windowSize = minWindow; windowSize <= maxWindow; windowSize++) {
    // Build initial window token string for [0, windowSize)
    let windowTokens = lineTokens.slice(0, windowSize).join("");

    for (let start = 0; start <= totalLines - windowSize; start++) {
      if (start > 0) {
        // Rolling update: remove departing line, add arriving line
        windowTokens =
          windowTokens.slice(lineTokens[start - 1].length) + lineTokens[start + windowSize - 1];
      }

      // Character count pre-filter — O(1) integer compare
      if (windowTokens.length < minChars || windowTokens.length > maxChars) {
        continue;
      }

      // Full token comparison
      if (windowTokens === needleTokens) {
        return sourceLines.slice(start, start + windowSize).join("\n");
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// PE-4: Count occurrences of search string
// Used to detect ambiguous replaces before applying them.
// ─────────────────────────────────────────────

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// ─────────────────────────────────────────────
// Symbol resolution
// ─────────────────────────────────────────────

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
// PE-5: Body integrity check
// Fixed: boundary check was `< 0` but line numbers are 1-indexed
// so the correct guard is `< 1`.
// ─────────────────────────────────────────────

function checkBodyIntegrity(lines, row) {
  if (!row.body_text) return { stale: false };

  const bodyStart = row.body_start_line ?? row.start_line;
  const bodyEnd = row.body_end_line ?? row.end_line;

  // PE-5 fix: was `bodyStart < 0` — line numbers are 1-indexed, minimum is 1
  if (bodyStart < 1 || bodyEnd >= lines.length) {
    return {
      stale: true,
      reason:
        `Body line range ${bodyStart}–${bodyEnd} out of bounds ` +
        `(file has ${lines.length} lines). File edited since last index.`,
    };
  }

  const currentBody = lines
    .slice(bodyStart, bodyEnd + 1)
    .join("\n")
    .trim();
  const indexedBody = row.body_text.replace(/\r\n/g, "\n").trim();

  if (currentBody !== indexedBody) {
    return {
      stale: true,
      reason: `Body mismatch at lines ${bodyStart}–${bodyEnd}. File modified since last index.`,
    };
  }

  return { stale: false };
}

// ─────────────────────────────────────────────
// Indentation preservation
// ─────────────────────────────────────────────

function reindentBody(newBody, fileLines, startLine) {
  const originalFirstLine = fileLines[startLine] || "";
  const indentMatch = originalFirstLine.match(/^(\s+)/);
  const baseIndent = indentMatch ? indentMatch[1] : "";

  if (!baseIndent) return newBody.split("\n");

  const bodyLines = newBody.split("\n");
  const existingIndents = bodyLines
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const m = l.match(/^(\s*)/);
      return m ? m[1].length : 0;
    });

  const minIndent = existingIndents.length > 0 ? Math.min(...existingIndents) : 0;

  return bodyLines.map((l) => {
    if (l.trim().length === 0) return "";
    return baseIndent + l.slice(minIndent);
  });
}

// ─────────────────────────────────────────────
// Line splice
// ─────────────────────────────────────────────

function applyLineSplice(lines, row, newBody, operation) {
  const startIdx = row.start_line;
  const endIdx = row.end_line;
  const newLines = reindentBody(newBody, lines, startIdx);

  switch (operation) {
    case PATCH_OPERATIONS.REPLACE_BODY:
      return [...lines.slice(0, startIdx), ...newLines, ...lines.slice(endIdx + 1)];
    case PATCH_OPERATIONS.INSERT_AFTER:
      return [...lines.slice(0, endIdx + 1), ...newLines, ...lines.slice(endIdx + 1)];
    case PATCH_OPERATIONS.INSERT_BEFORE:
      return [...lines.slice(0, startIdx), ...newLines, ...lines.slice(startIdx)];
    case PATCH_OPERATIONS.DELETE:
      return [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)];
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

// ─────────────────────────────────────────────
// Atomic write — preserves original line endings
// ─────────────────────────────────────────────

function atomicWrite(filePath, content, hasCRLF = false) {
  const output = hasCRLF ? content.replace(/\n/g, "\r\n") : content;
  const tmpPath = filePath + ".cf_tmp";
  try {
    fs.writeFileSync(tmpPath, output, "utf-8");
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
// Re-index — deferred to avoid blocking event loop
// ─────────────────────────────────────────────

function reindexFile(filePath, newSource) {
  // Defer to next event loop tick so the patch response is
  // returned to the LLM before the (synchronous) re-index runs.
  setImmediate(() => {
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
        `[PatchEngine] 🔄 Re-indexed ${path.basename(filePath)} ` +
          `(${nodes.length} nodes, ${edges.length} edges)`
      );
    } catch (err) {
      console.error(`[PatchEngine] ⚠️  Re-index failed for ${filePath}: ${err.message}`);
    }
  });
}

// ─────────────────────────────────────────────
// Diff summary
// ─────────────────────────────────────────────

function buildDiffSummary(linesBefore, linesAfter, startLine, endLine) {
  const removed = endLine - startLine + 1;
  const netDelta = linesAfter - linesBefore;
  const sign = netDelta >= 0 ? "+" : "";
  return `${sign}${netDelta} lines net (${removed} removed, ${removed + netDelta} inserted)`;
}

// ─────────────────────────────────────────────
// Post-patch cache invalidation
// ─────────────────────────────────────────────

function postPatchInvalidate(normalizedFilePath, newSource, semanticCache) {
  try {
    const newHash = crypto.createHash("sha256").update(newSource).digest("hex");
    invalidateByFile(normalizedFilePath, newHash, semanticCache);
  } catch (err) {
    console.warn(`[PatchEngine] ⚠️  Vault invalidation failed: ${err.message}`);
  }
  try {
    invalidateRegistryEntry(normalizedFilePath);
  } catch (err) {
    console.warn(`[PatchEngine] ⚠️  SimHash registry invalidation failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// Shared replace_string application
// Extracted to avoid duplication across global and symbol-scoped paths.
// Includes PE-4 occurrence check.
// ─────────────────────────────────────────────

function applyReplaceString(source, normalizedSearch, replacementString, context) {
  // PE-4: Check occurrence count before applying
  // replaceAll silently replaces ALL occurrences — if search_string appears
  // multiple times the patch modifies more than the LLM intended.
  const occurrences = countOccurrences(source, normalizedSearch);
  if (occurrences > 1) {
    return {
      success: false,
      error:
        `search_string appears ${occurrences} times in ${context}. ` +
        `Provide more surrounding context to make it unique (add the lines before/after).`,
      occurrences,
    };
  }

  return { success: true, newSource: source.replaceAll(normalizedSearch, replacementString) };
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

export async function executePatch({
  file_path,
  target_symbol = null,
  new_body = "",
  operation = PATCH_OPERATIONS.REPLACE_BODY,
  search_string = null,
  replacement_string = null,
  insert_line = null,
  semanticCache = null,
}) {
  console.log(`[PatchEngine] 🩹 ${operation}('${target_symbol || "GLOBAL"}') in ${file_path}`);

  if (!Object.values(PATCH_OPERATIONS).includes(operation)) {
    return {
      success: false,
      error: `Unknown operation '${operation}'. Valid: ${Object.values(PATCH_OPERATIONS).join(", ")}`,
    };
  }

  // ── INSERT_AT_LINE ────────────────────────────────────────────────────────
  if (operation === PATCH_OPERATIONS.INSERT_AT_LINE) {
    if (insert_line === null || !Number.isInteger(Number(insert_line))) {
      return {
        success: false,
        error: "insert_at_line requires an integer insert_line parameter (1-based line number).",
      };
    }
    if (!new_body?.trim()) {
      return { success: false, error: "insert_at_line requires new_body." };
    }

    // PE-1: use resolveFilePath helper
    const normalizedFilePath = resolveFilePath(file_path);

    let source, hasCRLF;
    try {
      ({ source, hasCRLF } = readSource(normalizedFilePath));
    } catch (err) {
      return { success: false, error: `Cannot read '${normalizedFilePath}': ${err.message}` };
    }

    const lines = source.split("\n");
    const lineNumber = Number(insert_line);

    if (lineNumber < 1 || lineNumber > lines.length + 1) {
      return {
        success: false,
        error: `insert_line ${lineNumber} out of range (file has ${lines.length} lines, valid range 1–${lines.length + 1}).`,
      };
    }

    const insertIdx = lineNumber - 1;

    // PE-7: trim trailing newline before splitting to prevent extra blank line
    const newBodyLines = new_body.trimEnd().split("\n");

    const newLines = [...lines.slice(0, insertIdx), ...newBodyLines, ...lines.slice(insertIdx)];
    const newSource = newLines.join("\n");

    try {
      atomicWrite(normalizedFilePath, newSource, hasCRLF);
    } catch (err) {
      return { success: false, error: `Write failed: ${err.message}` };
    }

    console.log(
      `[PatchEngine] ✅ insert_at_line ${lineNumber}: ${path.basename(normalizedFilePath)} ` +
        `(${lines.length} → ${newLines.length} lines)`
    );

    reindexFile(normalizedFilePath, newSource);
    postPatchInvalidate(normalizedFilePath, newSource, semanticCache);

    return {
      success: true,
      file: normalizedFilePath,
      symbol: null,
      operation,
      insert_line: lineNumber,
      lines_inserted: newBodyLines.length,
      file_lines_after: newLines.length,
      message: `Inserted ${newBodyLines.length} line(s) at line ${lineNumber} in ${path.basename(normalizedFilePath)}.`,
    };
  }

  // ── replace_string validation ─────────────────────────────────────────────
  if (operation === PATCH_OPERATIONS.REPLACE_STRING) {
    if (!search_string || typeof search_string !== "string" || !search_string.trim()) {
      return {
        success: false,
        error: "replace_string requires a non-empty search_string parameter.",
      };
    }
    if (replacement_string === null || replacement_string === undefined) {
      return {
        success: false,
        error: 'replace_string requires a replacement_string parameter. Pass "" to delete.',
      };
    }
  }

  if (
    operation !== PATCH_OPERATIONS.DELETE &&
    operation !== PATCH_OPERATIONS.REPLACE_STRING &&
    !new_body?.trim()
  ) {
    return {
      success: false,
      error: "new_body is required for non-delete operations",
    };
  }

  // ── GLOBAL REPLACE_STRING (no target_symbol) ──────────────────────────────
  if (!target_symbol) {
    if (operation !== PATCH_OPERATIONS.REPLACE_STRING) {
      return {
        success: false,
        error: `target_symbol is required for ${operation}. Only replace_string and insert_at_line can be used without a target_symbol.`,
      };
    }

    // PE-1: use resolveFilePath helper
    const normalizedFilePath = resolveFilePath(file_path);

    let source, hasCRLF;
    try {
      ({ source, hasCRLF } = readSource(normalizedFilePath));
    } catch (err) {
      return { success: false, error: `Cannot read '${normalizedFilePath}': ${err.message}` };
    }

    if (source.length > MAX_PATCHABLE_FILE_SIZE) {
      return {
        success: false,
        error: `File too large to patch (${source.length} chars > ${MAX_PATCHABLE_FILE_SIZE})`,
      };
    }

    const normalizedSearch = search_string.replace(/\r\n/g, "\n");

    if (!source.includes(normalizedSearch)) {
      const fuzzyMatch = findFuzzyMatch(source, normalizedSearch);
      if (fuzzyMatch) {
        console.log(`[PatchEngine] 🔧 Fuzzy match found (whitespace diff). Auto-applying.`);

        // PE-4: check occurrences even on fuzzy match
        const replaceResult = applyReplaceString(
          source,
          fuzzyMatch,
          replacement_string,
          `'${path.basename(normalizedFilePath)}'`
        );
        if (!replaceResult.success) return replaceResult;

        try {
          atomicWrite(normalizedFilePath, replaceResult.newSource, hasCRLF);
        } catch (err) {
          return { success: false, error: `Write failed: ${err.message}` };
        }

        const linesChanged = fuzzyMatch.split("\n").length;
        const fuzzyMatchOffset = source.indexOf(fuzzyMatch);
        const patchStartLine =
          fuzzyMatchOffset >= 0 ? source.slice(0, fuzzyMatchOffset).split("\n").length - 1 : null;
        const patchEndLine = patchStartLine !== null ? patchStartLine + linesChanged - 1 : null;

        console.log(
          `[PatchEngine] ✅ replace_string (global, fuzzy): ${path.basename(normalizedFilePath)} ` +
            `(${linesChanged} line(s) changed)`
        );

        reindexFile(normalizedFilePath, replaceResult.newSource);
        postPatchInvalidate(normalizedFilePath, replaceResult.newSource, semanticCache);

        return {
          success: true,
          file: normalizedFilePath,
          symbol: null,
          operation,
          lines_changed: linesChanged,
          fuzzy_applied: true,
          patch_start_line: patchStartLine,
          patch_end_line: patchEndLine,
          message: `replace_string applied (auto-corrected whitespace). ${linesChanged} line(s) changed. Graph re-indexed.`,
        };
      }

      return {
        success: false,
        error:
          `replace_string: search_string not found anywhere in '${normalizedFilePath}'. ` +
          `Ensure you are targeting the correct file and the text matches exactly.`,
        search_string_preview: search_string.slice(0, 120),
      };
    }

    // PE-4: check occurrences before applying
    const replaceResult = applyReplaceString(
      source,
      normalizedSearch,
      replacement_string,
      `'${path.basename(normalizedFilePath)}'`
    );
    if (!replaceResult.success) return replaceResult;

    try {
      atomicWrite(normalizedFilePath, replaceResult.newSource, hasCRLF);
    } catch (err) {
      return { success: false, error: `Write failed: ${err.message}` };
    }

    const linesChanged = normalizedSearch.split("\n").length;
    const matchOffset = source.indexOf(normalizedSearch);
    const patchStartLine =
      matchOffset >= 0 ? source.slice(0, matchOffset).split("\n").length - 1 : null;
    const patchEndLine = patchStartLine !== null ? patchStartLine + linesChanged - 1 : null;

    console.log(
      `[PatchEngine] ✅ replace_string (global): ${path.basename(normalizedFilePath)} ` +
        `(${linesChanged} line(s) changed)`
    );

    reindexFile(normalizedFilePath, replaceResult.newSource);
    postPatchInvalidate(normalizedFilePath, replaceResult.newSource, semanticCache);

    return {
      success: true,
      file: normalizedFilePath,
      symbol: null,
      operation,
      lines_changed: linesChanged,
      patch_start_line: patchStartLine,
      patch_end_line: patchEndLine,
      message: `replace_string applied globally. ${linesChanged} line(s) changed. Graph re-indexed.`,
    };
  }

  // ── Resolve symbol ────────────────────────────────────────────────────────
  const resolved = resolveSymbol(target_symbol, file_path);
  if (resolved.error) return { success: false, error: resolved.error };

  let { row } = resolved;

  // PE-1: use resolveFilePath helper — DB path may be relative
  const normalizedFilePath = resolveFilePath(resolved.normalizedFilePath);

  let source, hasCRLF;
  try {
    ({ source, hasCRLF } = readSource(normalizedFilePath));
  } catch (err) {
    return { success: false, error: `Cannot read '${normalizedFilePath}': ${err.message}` };
  }

  if (source.length > MAX_PATCHABLE_FILE_SIZE) {
    return { success: false, error: `File too large (${source.length} chars)` };
  }

  let lines = source.split("\n");

  // PE-5: checkBodyIntegrity boundary fixed (< 1 not < 0)
  const integrity = checkBodyIntegrity(lines, row);
  if (integrity.stale) {
    console.log(`[PatchEngine] ⚠️  Stale index: ${integrity.reason}. Re-indexing…`);
    reindexFile(normalizedFilePath, source);

    // Wait for reindex to complete before re-resolving
    // reindexFile is deferred with setImmediate — we need it synchronous here
    // so we call the internals directly for the stale-recovery path only.
    try {
      const langInfo = getLanguageForFile(normalizedFilePath);
      const language = langInfo?.language || "unknown";
      const stat = fs.statSync(normalizedFilePath);
      const { nodes, edges } = extractSymbols(source, normalizedFilePath);
      writeFileGraph({
        filePath: normalizedFilePath.replace(/\\/g, "/"),
        language,
        lastModified: stat.mtimeMs,
        nodes,
        edges,
      });
    } catch (reindexErr) {
      console.error(`[PatchEngine] ⚠️  Sync re-index failed: ${reindexErr.message}`);
    }

    const fresh = resolveSymbol(target_symbol, file_path);
    if (fresh.error) return { success: false, error: `After re-index: ${fresh.error}` };
    row = fresh.row;

    try {
      ({ source, hasCRLF } = readSource(normalizedFilePath));
      lines = source.split("\n");
    } catch {
      /* use existing source */
    }
  }

  if (operation === PATCH_OPERATIONS.REPLACE_BODY) {
    const symbolLineCount = row.end_line - row.start_line + 1;
    const newBodyLineCount = new_body.split("\n").length;
    if (symbolLineCount > 20 && newBodyLineCount < symbolLineCount * 0.3) {
      return {
        success: false,
        error:
          `Safety check: new_body is ${newBodyLineCount} lines but '${target_symbol}' ` +
          `is ${symbolLineCount} lines. new_body appears incomplete.`,
        hint: "retrieve_symbol_not_file",
      };
    }
  }

  if (operation === PATCH_OPERATIONS.REPLACE_STRING) {
    const startIdx = row.start_line;
    const endIdx = row.end_line;
    const symbolBlock = lines.slice(startIdx, endIdx + 1).join("\n");
    const normalizedSearch = search_string.replace(/\r\n/g, "\n");

    if (!symbolBlock.includes(normalizedSearch)) {
      // Strategy 1: Fuzzy match within symbol body
      const fuzzyInSymbol = findFuzzyMatch(symbolBlock, normalizedSearch);
      if (fuzzyInSymbol) {
        console.log(`[PatchEngine] 🔧 Fuzzy match inside '${target_symbol}'. Auto-applying.`);

        // PE-4 check within symbol scope
        const occurrencesInSymbol = countOccurrences(symbolBlock, fuzzyInSymbol);
        if (occurrencesInSymbol > 1) {
          return {
            success: false,
            error:
              `search_string appears ${occurrencesInSymbol} times inside '${target_symbol}'. ` +
              `Provide more surrounding context to make it unique.`,
            occurrences: occurrencesInSymbol,
          };
        }

        const updatedBlock = symbolBlock.replaceAll(fuzzyInSymbol, replacement_string);
        const updatedBlockLines = updatedBlock.split("\n");
        const newLines = [
          ...lines.slice(0, startIdx),
          ...updatedBlockLines,
          ...lines.slice(endIdx + 1),
        ];
        const newSource = newLines.join("\n");

        try {
          atomicWrite(normalizedFilePath, newSource, hasCRLF);
        } catch (err) {
          return { success: false, error: `Write failed: ${err.message}` };
        }

        const linesChanged = fuzzyInSymbol.split("\n").length;
        const symFuzzyOffset = symbolBlock.indexOf(fuzzyInSymbol);
        const symFuzzyStartLine =
          symFuzzyOffset >= 0
            ? startIdx + symbolBlock.slice(0, symFuzzyOffset).split("\n").length - 1
            : startIdx;
        const symFuzzyEndLine = symFuzzyStartLine + linesChanged - 1;

        console.log(
          `[PatchEngine] ✅ replace_string (symbol, fuzzy): ${path.basename(normalizedFilePath)} ` +
            `(${linesChanged} line(s) changed inside '${target_symbol}')`
        );

        reindexFile(normalizedFilePath, newSource);
        postPatchInvalidate(normalizedFilePath, newSource, semanticCache);

        return {
          success: true,
          file: normalizedFilePath,
          symbol: target_symbol,
          operation,
          lines_changed: linesChanged,
          fuzzy_applied: true,
          patch_start_line: symFuzzyStartLine,
          patch_end_line: symFuzzyEndLine,
          message: `replace_string applied inside '${target_symbol}' (auto-corrected whitespace). ${linesChanged} line(s) changed. Graph re-indexed.`,
        };
      }

      // Strategy 2: Exact match in global file scope
      if (source.includes(normalizedSearch)) {
        console.log(
          `[PatchEngine] 🔧 Search string not in '${target_symbol}' but found in file. Auto-escalating to global scope.`
        );

        // PE-4 check at file scope
        const globalResult = applyReplaceString(
          source,
          normalizedSearch,
          replacement_string,
          `'${path.basename(normalizedFilePath)}' (escalated from '${target_symbol}')`
        );
        if (!globalResult.success) return globalResult;

        try {
          atomicWrite(normalizedFilePath, globalResult.newSource, hasCRLF);
        } catch (err) {
          return { success: false, error: `Write failed: ${err.message}` };
        }

        const linesChanged = normalizedSearch.split("\n").length;
        console.log(
          `[PatchEngine] ✅ replace_string (auto-escalated to global): ${path.basename(normalizedFilePath)} ` +
            `(${linesChanged} line(s) changed)`
        );

        reindexFile(normalizedFilePath, globalResult.newSource);
        postPatchInvalidate(normalizedFilePath, globalResult.newSource, semanticCache);

        return {
          success: true,
          file: normalizedFilePath,
          symbol: null,
          operation,
          lines_changed: linesChanged,
          auto_escalated: true,
          message: `replace_string applied (auto-escalated from '${target_symbol}' to global scope). ${linesChanged} line(s) changed. Graph re-indexed.`,
        };
      }

      // Strategy 3: Fuzzy match in global file scope
      const fuzzyInFile = findFuzzyMatch(source, normalizedSearch);
      if (fuzzyInFile) {
        console.log(
          `[PatchEngine] 🔧 Fuzzy match found in file (outside '${target_symbol}'). Auto-applying globally.`
        );

        const globalFuzzyResult = applyReplaceString(
          source,
          fuzzyInFile,
          replacement_string,
          `'${path.basename(normalizedFilePath)}' (global fuzzy from '${target_symbol}')`
        );
        if (!globalFuzzyResult.success) return globalFuzzyResult;

        try {
          atomicWrite(normalizedFilePath, globalFuzzyResult.newSource, hasCRLF);
        } catch (err) {
          return { success: false, error: `Write failed: ${err.message}` };
        }

        const linesChanged = fuzzyInFile.split("\n").length;
        console.log(
          `[PatchEngine] ✅ replace_string (global, fuzzy): ${path.basename(normalizedFilePath)} ` +
            `(${linesChanged} line(s) changed)`
        );

        reindexFile(normalizedFilePath, globalFuzzyResult.newSource);
        postPatchInvalidate(normalizedFilePath, globalFuzzyResult.newSource, semanticCache);

        return {
          success: true,
          file: normalizedFilePath,
          symbol: null,
          operation,
          lines_changed: linesChanged,
          fuzzy_applied: true,
          auto_escalated: true,
          message: `replace_string applied (auto-escalated to global + auto-corrected whitespace). ${linesChanged} line(s) changed. Graph re-indexed.`,
        };
      }

      // All strategies exhausted
      return {
        success: false,
        error:
          `replace_string: search_string not found inside '${target_symbol}' or anywhere in '${normalizedFilePath}' ` +
          `(even after fuzzy whitespace matching). ` +
          `TIP: Use find_symbol('${target_symbol}') to get the current body, then copy the exact text.`,
        symbol: target_symbol,
        search_string_preview: search_string.slice(0, 200),
      };
    }

    // Exact match found within symbol scope
    // PE-4: check occurrences within symbol block
    const occurrencesInSymbol = countOccurrences(symbolBlock, normalizedSearch);
    if (occurrencesInSymbol > 1) {
      return {
        success: false,
        error:
          `search_string appears ${occurrencesInSymbol} times inside '${target_symbol}'. ` +
          `Provide more surrounding context to make it unique.`,
        occurrences: occurrencesInSymbol,
      };
    }

    const updatedBlock = symbolBlock.replaceAll(normalizedSearch, replacement_string);
    const updatedBlockLines = updatedBlock.split("\n");
    const newLines = [
      ...lines.slice(0, startIdx),
      ...updatedBlockLines,
      ...lines.slice(endIdx + 1),
    ];
    const newSource = newLines.join("\n");

    try {
      atomicWrite(normalizedFilePath, newSource, hasCRLF);
    } catch (err) {
      return { success: false, error: `Write failed: ${err.message}` };
    }

    const linesChanged = normalizedSearch.split("\n").length;
    const symMatchOffset = symbolBlock.indexOf(normalizedSearch);
    const symPatchStartLine =
      symMatchOffset >= 0
        ? startIdx + symbolBlock.slice(0, symMatchOffset).split("\n").length - 1
        : startIdx;
    const symPatchEndLine = symPatchStartLine + linesChanged - 1;

    console.log(
      `[PatchEngine] ✅ replace_string: ${path.basename(normalizedFilePath)} ` +
        `(${linesChanged} line(s) changed inside '${target_symbol}')`
    );

    reindexFile(normalizedFilePath, newSource);
    postPatchInvalidate(normalizedFilePath, newSource, semanticCache);

    return {
      success: true,
      file: normalizedFilePath,
      symbol: target_symbol,
      operation,
      lines_changed: linesChanged,
      patch_start_line: symPatchStartLine,
      patch_end_line: symPatchEndLine,
      message: `replace_string applied. ${linesChanged} line(s) changed inside '${target_symbol}'. Graph re-indexed.`,
    };
  }

  // ── replace_body / insert_after / insert_before / delete ─────────────────
  let newLines;
  try {
    newLines = applyLineSplice(lines, row, new_body, operation);
  } catch (err) {
    return { success: false, error: `Splice failed: ${err.message}` };
  }

  const newSource = newLines.join("\n");

  try {
    atomicWrite(normalizedFilePath, newSource, hasCRLF);
  } catch (err) {
    return { success: false, error: `Write failed: ${err.message}` };
  }

  console.log(
    `[PatchEngine] ✅ Written: ${path.basename(normalizedFilePath)} ` +
      `(${lines.length} → ${newLines.length} lines)`
  );

  reindexFile(normalizedFilePath, newSource);
  postPatchInvalidate(normalizedFilePath, newSource, semanticCache);

  const diffSummary = buildDiffSummary(lines.length, newLines.length, row.start_line, row.end_line);

  return {
    success: true,
    file: normalizedFilePath,
    symbol: target_symbol,
    operation,
    lines_before: row.start_line,
    lines_after: row.end_line,
    file_lines_before: lines.length,
    file_lines_after: newLines.length,
    diff_summary: diffSummary,
    message: `Patch applied. '${target_symbol}' in ${normalizedFilePath} updated (${diffSummary}). Graph re-indexed.`,
  };
}
