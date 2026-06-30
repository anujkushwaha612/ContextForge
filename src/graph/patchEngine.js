/**
 * patchEngine.js
 *
 * Upgrades applied:
 *   Fuzzy match: when replace_string fails due to whitespace differences,
 *     return the exact matching block with a "Did you mean?" message so
 *     the LLM can self-correct without a human in the loop.
 *
 *   insert_at_line: new operation that inserts new_body at a specific
 *     1-based line number without needing a named symbol to anchor to.
 *     Solves the anonymous handler problem (SSE handler in server.js).
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
  INSERT_AT_LINE: "insert_at_line", // ← new
};

const MAX_PATCHABLE_FILE_SIZE = 500_000;

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
// Fuzzy match helper
//
// When replace_string fails, the most common cause on Windows is
// whitespace differences:
//   - LLM sends search_string with \n between lines
//   - file has \r\n (fixed by readSource normalization)
//   - OR LLM uses 2-space indent but file uses 4-space
//   - OR LLM omits/adds a trailing newline
//
// findFuzzyMatch strips all whitespace from both the search string and
// a sliding window of the source to find a content-identical match.
// When found, it returns the EXACT raw slice from source so the LLM
// can use it verbatim as search_string on the next attempt.
//
// Returns: string (exact match from source) | null (no match found)
// ─────────────────────────────────────────────

function findFuzzyMatch(source, searchString) {
  // Strip all whitespace to get canonical token sequence
  const needleTokens = searchString.replace(/\s+/g, "");
  if (needleTokens.length === 0) return null;

  const lines = source.split("\n");
  const needleLines = searchString.split("\n").length;
  // Search window: needle line count ± 3 lines to account for blank line differences
  const windowSize = needleLines + 3;

  for (let start = 0; start <= lines.length - needleLines + 3; start++) {
    for (
      let end = start + Math.max(1, needleLines - 3);
      end <= Math.min(lines.length, start + windowSize);
      end++
    ) {
      const candidate = lines.slice(start, end).join("\n");
      const candidateTokens = candidate.replace(/\s+/g, "");

      if (candidateTokens === needleTokens) {
        return candidate; // exact raw slice from source
      }
    }
  }

  return null;
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
// Body integrity check
// ─────────────────────────────────────────────

function checkBodyIntegrity(lines, row) {
  if (!row.body_text) return { stale: false };

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

  const minIndent =
    existingIndents.length > 0 ? Math.min(...existingIndents) : 0;

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
      return [
        ...lines.slice(0, startIdx),
        ...newLines,
        ...lines.slice(endIdx + 1),
      ];
    case PATCH_OPERATIONS.INSERT_AFTER:
      return [
        ...lines.slice(0, endIdx + 1),
        ...newLines,
        ...lines.slice(endIdx + 1),
      ];
    case PATCH_OPERATIONS.INSERT_BEFORE:
      return [
        ...lines.slice(0, startIdx),
        ...newLines,
        ...lines.slice(startIdx),
      ];
    case PATCH_OPERATIONS.DELETE:
      return [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)];
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

// ─────────────────────────────────────────────
// Atomic write — restores original line endings
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
// Re-index
// ─────────────────────────────────────────────

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
      `[PatchEngine] 🔄 Re-indexed ${path.basename(filePath)} ` +
        `(${nodes.length} nodes, ${edges.length} edges)`,
    );
  } catch (err) {
    console.error(
      `[PatchEngine] ⚠️  Re-index failed for ${filePath}: ${err.message}`,
    );
  }
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
    console.warn(
      `[PatchEngine] ⚠️  SimHash registry invalidation failed: ${err.message}`,
    );
  }
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
  insert_line = null, // ← new: for INSERT_AT_LINE
  semanticCache = null,
}) {
  console.log(
    `[PatchEngine] 🩹 ${operation}('${target_symbol || "GLOBAL"}') in ${file_path}`,
  );

  if (!Object.values(PATCH_OPERATIONS).includes(operation)) {
    return {
      success: false,
      error: `Unknown operation '${operation}'. Valid: ${Object.values(PATCH_OPERATIONS).join(", ")}`,
    };
  }

  // ── INSERT_AT_LINE: no symbol needed, just a line number ─────────────────
  // This is the solution for anonymous handlers (SSE handler in server.js).
  // find_route returns the line number, LLM calls insert_at_line directly.
  if (operation === PATCH_OPERATIONS.INSERT_AT_LINE) {
    if (
      insert_line === null ||
      insert_line === undefined ||
      !Number.isInteger(Number(insert_line))
    ) {
      return {
        success: false,
        error:
          "insert_at_line requires an integer insert_line parameter (1-based line number).",
      };
    }
    if (!new_body?.trim()) {
      return { success: false, error: "insert_at_line requires new_body." };
    }

    let normalizedFilePath = file_path
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    if (!path.isAbsolute(normalizedFilePath) && !normalizedFilePath.match(/^[A-Za-z]:\//)) {
      normalizedFilePath = path.resolve(getWorkspaceRoot(), normalizedFilePath);
    }
    let source, hasCRLF;
    try {
      ({ source, hasCRLF } = readSource(normalizedFilePath));
    } catch (err) {
      return {
        success: false,
        error: `Cannot read '${normalizedFilePath}': ${err.message}`,
      };
    }

    const lines = source.split("\n");
    const lineNumber = Number(insert_line);

    // Clamp to valid range: 1 = before first line, lines.length+1 = after last line
    if (lineNumber < 1 || lineNumber > lines.length + 1) {
      return {
        success: false,
        error: `insert_line ${lineNumber} out of range (file has ${lines.length} lines, valid range 1–${lines.length + 1}).`,
      };
    }

    // splice is 0-based, insert_line is 1-based
    const insertIdx = lineNumber - 1;
    const newBodyLines = new_body.split("\n");
    const newLines = [
      ...lines.slice(0, insertIdx),
      ...newBodyLines,
      ...lines.slice(insertIdx),
    ];
    const newSource = newLines.join("\n");

    try {
      atomicWrite(normalizedFilePath, newSource, hasCRLF);
    } catch (err) {
      return { success: false, error: `Write failed: ${err.message}` };
    }

    console.log(
      `[PatchEngine] ✅ insert_at_line ${lineNumber}: ${path.basename(normalizedFilePath)} ` +
        `(${lines.length} → ${newLines.length} lines)`,
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

  // ── replace_string validation ──
  if (operation === PATCH_OPERATIONS.REPLACE_STRING) {
    if (
      !search_string ||
      typeof search_string !== "string" ||
      !search_string.trim()
    ) {
      return {
        success: false,
        error: "replace_string requires a non-empty search_string parameter.",
      };
    }
    if (replacement_string === null || replacement_string === undefined) {
      return {
        success: false,
        error:
          'replace_string requires a replacement_string parameter. Pass "" to delete.',
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

  // ── GLOBAL REPLACE_STRING (no target_symbol) ──────────────────────────
  if (!target_symbol) {
    if (operation !== PATCH_OPERATIONS.REPLACE_STRING) {
      return {
        success: false,
        error: `target_symbol is required for ${operation}. Only replace_string and insert_at_line can be used without a target_symbol.`,
      };
    }

    let normalizedFilePath = file_path
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    if (!path.isAbsolute(normalizedFilePath) && !normalizedFilePath.match(/^[A-Za-z]:\//)) {
      normalizedFilePath = path.resolve(getWorkspaceRoot(), normalizedFilePath);
    }
    let source, hasCRLF;
    try {
      ({ source, hasCRLF } = readSource(normalizedFilePath));
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

    const normalizedSearch = search_string.replace(/\r\n/g, "\n");

    if (!source.includes(normalizedSearch)) {
      // ── FIX: Auto-apply fuzzy match instead of asking LLM to retry ──
      // Previously returned a "Did you mean?" error with <exact_match> tags,
      // forcing the LLM to burn an entire round-trip (~8-10k tokens) just to
      // copy-paste the exact text. Now we auto-apply the replacement using
      // the fuzzy-matched text, saving a full LLM hop.
      const fuzzyMatch = findFuzzyMatch(source, normalizedSearch);
      if (fuzzyMatch) {
        console.log(
          `[PatchEngine] 🔧 Fuzzy match found (whitespace diff). Auto-applying replacement.`,
        );
        const newSource = source.replaceAll(fuzzyMatch, replacement_string);
        try {
          atomicWrite(normalizedFilePath, newSource, hasCRLF);
        } catch (err) {
          return { success: false, error: `Write failed: ${err.message}` };
        }
        const linesChanged = fuzzyMatch.split("\n").length;
        console.log(
          `[PatchEngine] ✅ replace_string (global, fuzzy): ${path.basename(normalizedFilePath)} ` +
            `(${linesChanged} line(s) changed)`,
        );
        reindexFile(normalizedFilePath, newSource);
        postPatchInvalidate(normalizedFilePath, newSource, semanticCache);
        const fuzzyMatchOffset = source.indexOf(fuzzyMatch);
        const fuzzyPatchStartLine =
          fuzzyMatchOffset >= 0
            ? source.slice(0, fuzzyMatchOffset).split("\n").length - 1
            : null;
        const fuzzyPatchEndLine =
          fuzzyPatchStartLine !== null
            ? fuzzyPatchStartLine + linesChanged - 1
            : null;

        return {
          success: true,
          file: normalizedFilePath,
          symbol: null,
          operation,
          lines_changed: linesChanged,
          fuzzy_applied: true,
          patch_start_line: fuzzyPatchStartLine,
          patch_end_line: fuzzyPatchEndLine,
          message: `replace_string applied (auto-corrected whitespace differences). ${linesChanged} line(s) changed. Graph re-indexed.`,
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

    const newSource = source.replaceAll(normalizedSearch, replacement_string);

    try {
      atomicWrite(normalizedFilePath, newSource, hasCRLF);
    } catch (err) {
      return { success: false, error: `Write failed: ${err.message}` };
    }

    const linesChanged = normalizedSearch.split("\n").length;
    // Find where the match occurred so patchTools.js can read back the patched region
    const matchOffset = source.indexOf(normalizedSearch);
    const patchStartLine =
      matchOffset >= 0
        ? source.slice(0, matchOffset).split("\n").length - 1
        : null;
    const patchEndLine =
      patchStartLine !== null ? patchStartLine + linesChanged - 1 : null;

    console.log(
      `[PatchEngine] ✅ replace_string (global): ${path.basename(normalizedFilePath)} ` +
        `(${linesChanged} line(s) changed)`,
    );

    reindexFile(normalizedFilePath, newSource);
    postPatchInvalidate(normalizedFilePath, newSource, semanticCache);

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

  // ── Resolve symbol ──
  const resolved = resolveSymbol(target_symbol, file_path);
  if (resolved.error) return { success: false, error: resolved.error };

  let { row, normalizedFilePath } = resolved;

  if (!path.isAbsolute(normalizedFilePath) && !normalizedFilePath.match(/^[A-Za-z]:\//)) {
    normalizedFilePath = path.resolve(getWorkspaceRoot(), normalizedFilePath);
  }

  let source, hasCRLF;
  try {
    ({ source, hasCRLF } = readSource(normalizedFilePath));
  } catch (err) {
    return {
      success: false,
      error: `Cannot read '${normalizedFilePath}': ${err.message}`,
    };
  }

  if (source.length > MAX_PATCHABLE_FILE_SIZE) {
    return { success: false, error: `File too large (${source.length} chars)` };
  }

  let lines = source.split("\n");

  const integrity = checkBodyIntegrity(lines, row);
  if (integrity.stale) {
    console.log(
      `[PatchEngine] ⚠️  Stale index: ${integrity.reason}. Re-indexing…`,
    );
    reindexFile(normalizedFilePath, source);
    const fresh = resolveSymbol(target_symbol, file_path);
    if (fresh.error)
      return { success: false, error: `After re-index: ${fresh.error}` };
    row = fresh.row;
    // FIX: Re-read lines from current source to match fresh row bounds.
    // Previously the stale `lines` array was used with fresh row indices,
    // causing off-by-one mismatches when the file had been modified.
    try {
      ({ source, hasCRLF } = readSource(normalizedFilePath));
      lines = source.split("\n");
    } catch {
      /* use existing source — fine */
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
      // ── FIX: Auto-escalation chain instead of returning errors ──
      // Previously each failure returned an error to the LLM, costing a full
      // round-trip (~8-10k tokens) per attempt. Now we try 3 strategies
      // in sequence WITHOUT burning LLM hops:
      //   1. Fuzzy match within symbol scope → auto-apply
      //   2. Exact match in global file scope → auto-apply
      //   3. Fuzzy match in global file scope → auto-apply
      //   4. All failed → return error (only 1 LLM hop burned)

      // Strategy 1: Fuzzy match within symbol body
      const fuzzyInSymbol = findFuzzyMatch(symbolBlock, normalizedSearch);
      if (fuzzyInSymbol) {
        console.log(
          `[PatchEngine] 🔧 Fuzzy match inside '${target_symbol}'. Auto-applying.`,
        );
        const updatedBlock = symbolBlock.replaceAll(
          fuzzyInSymbol,
          replacement_string,
        );
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
        console.log(
          `[PatchEngine] ✅ replace_string (symbol, fuzzy): ${path.basename(normalizedFilePath)} ` +
            `(${linesChanged} line(s) changed inside '${target_symbol}')`,
        );
        reindexFile(normalizedFilePath, newSource);
        postPatchInvalidate(normalizedFilePath, newSource, semanticCache);
        const symFuzzyOffset = symbolBlock.indexOf(fuzzyInSymbol);
        const symFuzzyStartLine =
          symFuzzyOffset >= 0
            ? startIdx +
              symbolBlock.slice(0, symFuzzyOffset).split("\n").length -
              1
            : startIdx;
        const symFuzzyEndLine = symFuzzyStartLine + linesChanged - 1;

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

      // Strategy 2: Exact match in global file scope (text exists outside symbol bounds)
      if (source.includes(normalizedSearch)) {
        console.log(
          `[PatchEngine] 🔧 Search string not in '${target_symbol}' but found in file. Auto-escalating to global scope.`,
        );
        const newSource = source.replaceAll(
          normalizedSearch,
          replacement_string,
        );
        try {
          atomicWrite(normalizedFilePath, newSource, hasCRLF);
        } catch (err) {
          return { success: false, error: `Write failed: ${err.message}` };
        }
        const linesChanged = normalizedSearch.split("\n").length;
        console.log(
          `[PatchEngine] ✅ replace_string (auto-escalated to global): ${path.basename(normalizedFilePath)} ` +
            `(${linesChanged} line(s) changed)`,
        );
        reindexFile(normalizedFilePath, newSource);
        postPatchInvalidate(normalizedFilePath, newSource, semanticCache);
        return {
          success: true,
          file: normalizedFilePath,
          symbol: null,
          operation,
          lines_changed: linesChanged,
          auto_escalated: true,
          message: `replace_string applied (auto-escalated from '${target_symbol}' to global scope — text was outside symbol bounds). ${linesChanged} line(s) changed. Graph re-indexed.`,
        };
      }

      // Strategy 3: Fuzzy match in global file scope
      const fuzzyInFile = findFuzzyMatch(source, normalizedSearch);
      if (fuzzyInFile) {
        console.log(
          `[PatchEngine] 🔧 Fuzzy match found in file (outside '${target_symbol}'). Auto-applying globally.`,
        );
        const newSource = source.replaceAll(fuzzyInFile, replacement_string);
        try {
          atomicWrite(normalizedFilePath, newSource, hasCRLF);
        } catch (err) {
          return { success: false, error: `Write failed: ${err.message}` };
        }
        const linesChanged = fuzzyInFile.split("\n").length;
        console.log(
          `[PatchEngine] ✅ replace_string (global, fuzzy): ${path.basename(normalizedFilePath)} ` +
            `(${linesChanged} line(s) changed)`,
        );
        reindexFile(normalizedFilePath, newSource);
        postPatchInvalidate(normalizedFilePath, newSource, semanticCache);
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

      // All strategies exhausted — return error (only 1 LLM hop burned total)
      return {
        success: false,
        error:
          `replace_string: search_string not found inside '${target_symbol}' or anywhere in '${normalizedFilePath}' ` +
          `(even after fuzzy whitespace matching). Verify the exact text exists in the current file version. ` +
          `TIP: Use find_symbol('${target_symbol}') to get the current body, then copy the exact text.`,
        symbol: target_symbol,
        search_string_preview: search_string.slice(0, 200),
      };
    }

    const updatedBlock = symbolBlock.replaceAll(
      normalizedSearch,
      replacement_string,
    );
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
    console.log(
      `[PatchEngine] ✅ replace_string: ${path.basename(normalizedFilePath)} ` +
        `(${linesChanged} line(s) changed inside '${target_symbol}')`,
    );

    reindexFile(normalizedFilePath, newSource);
    postPatchInvalidate(normalizedFilePath, newSource, semanticCache);

    // Find line number within symbol block
    const symMatchOffset = symbolBlock.indexOf(normalizedSearch);
    const symPatchStartLine =
      symMatchOffset >= 0
        ? startIdx + symbolBlock.slice(0, symMatchOffset).split("\n").length - 1
        : startIdx;
    const symPatchEndLine = symPatchStartLine + linesChanged - 1;

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
      `(${lines.length} → ${newLines.length} lines)`,
  );

  reindexFile(normalizedFilePath, newSource);
  postPatchInvalidate(normalizedFilePath, newSource, semanticCache);

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
    lines_before: row.start_line,
    lines_after: row.end_line,
    file_lines_before: lines.length,
    file_lines_after: newLines.length,
    diff_summary: diffSummary,
    message: `Patch applied. '${target_symbol}' in ${normalizedFilePath} updated (${diffSummary}). Graph re-indexed.`,
  };
}
