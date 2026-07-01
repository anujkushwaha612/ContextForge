/**
 * patchEngine.js
 *
 * Fixes applied (original):
 *   PE-1: resolveFilePath helper extracted.
 *   PE-3: findFuzzyMatch O(n*7) rolling window rewrite.
 *   PE-4: replaceAll occurrence pre-check.
 *   PE-5: checkBodyIntegrity boundary < 1.
 *   PE-7: insert_at_line trailing newline trim.
 *
 * Fixes applied (this pass):
 *   PE-2: Triple re-index on stale recovery eliminated. reindexFile()
 *         was called before the synchronous recovery block, scheduling
 *         a deferred re-index that ran AFTER the synchronous one completed,
 *         resulting in three writeFileGraph calls for one stale detection.
 *         Now only the synchronous block runs during stale recovery.
 *
 *   PE-5: atomicWrite tmp file uses timestamp+pid suffix to prevent
 *         collision when two concurrent patches target the same file.
 *
 *   PE-6: Fuzzy occurrence check now verifies the fuzzy match string
 *         appears verbatim in the target scope before using it as the
 *         replacement key. Previously the fuzzy match could be a
 *         whitespace-normalized string not present in symbolBlock,
 *         causing replaceAll to silently no-op.
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
  CREATE_FILE: "create_file",
};

const MAX_PATCHABLE_FILE_SIZE = 500_000;

// ─────────────────────────────────────────────
// Canonical file path resolver
// ─────────────────────────────────────────────

function resolveFilePath(filePath) {
  let p = filePath.replace(/\\/g, "/").replace(/^\.\//, "");

  if (path.isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    return p;
  }

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
// Fuzzy match — rolling window, O(n * windowRange)
//
// Finds a window of source lines whose whitespace-stripped tokens
// match the whitespace-stripped needle. Window size varies ±3 lines
// to handle blank line differences between LLM-provided and actual source.
//
// Character count pre-filter (30% tolerance) skips windows that are
// clearly too different before doing the full token comparison.
// ─────────────────────────────────────────────

function findFuzzyMatch(source, searchString) {
  const needleRaw = searchString.replace(/\r\n/g, "\n");
  const needleTokens = needleRaw.replace(/\s+/g, "");
  if (needleTokens.length === 0) return null;

  const needleLines = needleRaw.split("\n");
  const needleLineCount = needleLines.length;

  const sourceLines = source.split("\n");
  const totalLines = sourceLines.length;

  const lineTokens = sourceLines.map((l) => l.replace(/\s+/g, ""));

  const minWindow = Math.max(1, needleLineCount - 3);
  const maxWindow = needleLineCount + 3;

  const needleCharCount = needleTokens.length;
  const minChars = Math.floor(needleCharCount * 0.7);
  const maxChars = Math.ceil(needleCharCount * 1.3);

  for (let windowSize = minWindow; windowSize <= maxWindow; windowSize++) {
    let windowTokens = lineTokens.slice(0, windowSize).join("");

    for (let start = 0; start <= totalLines - windowSize; start++) {
      if (start > 0) {
        windowTokens =
          windowTokens.slice(lineTokens[start - 1].length) + lineTokens[start + windowSize - 1];
      }

      if (windowTokens.length < minChars || windowTokens.length > maxChars) {
        continue;
      }

      if (windowTokens === needleTokens) {
        return sourceLines.slice(start, start + windowSize).join("\n");
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// Count occurrences of search string
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
// Body integrity check
// ─────────────────────────────────────────────

function checkBodyIntegrity(lines, row) {
  if (!row.body_text) return { stale: false };

  const bodyStart = row.body_start_line ?? row.start_line;
  const bodyEnd = row.body_end_line ?? row.end_line;

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
// Atomic write
//
// PE-5 FIX: Tmp file uses timestamp+pid suffix to prevent collision
// when two concurrent patches target the same file. Previously both
// would write to "file.js.cf_tmp" and race on renameSync.
// ─────────────────────────────────────────────

function atomicWrite(filePath, content, hasCRLF = false) {
  const output = hasCRLF ? content.replace(/\n/g, "\r\n") : content;
  // PE-5 FIX: unique suffix prevents concurrent-patch tmp file collision
  const tmpPath = filePath + `.cf_${Date.now()}_${process.pid}.tmp`;
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
// Synchronous re-index — used ONLY for stale recovery
//
// PE-2 FIX: Extracted from the inline stale recovery block so the
// logic is not duplicated. Called synchronously (not via setImmediate)
// because stale recovery must complete before re-resolving the symbol.
// ─────────────────────────────────────────────

function reindexFileSync(filePath, source) {
  try {
    const langInfo = getLanguageForFile(filePath);
    const language = langInfo?.language || "unknown";
    const stat = fs.statSync(filePath);
    const { nodes, edges } = extractSymbols(source, filePath);

    writeFileGraph({
      filePath: filePath.replace(/\\/g, "/"),
      language,
      lastModified: stat.mtimeMs,
      nodes,
      edges,
    });

    console.log(
      `[PatchEngine] 🔄 Sync re-indexed ${path.basename(filePath)} ` +
        `(${nodes.length} nodes, ${edges.length} edges)`
    );
  } catch (err) {
    console.error(`[PatchEngine] ⚠️  Sync re-index failed for ${filePath}: ${err.message}`);
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
    console.warn(`[PatchEngine] ⚠️  SimHash registry invalidation failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// Shared replace_string application
//
// PE-6 FIX: Before applying, verify the search key actually appears
// verbatim in the target scope. This prevents the case where a fuzzy
// match returns a whitespace-normalized string that findFuzzyMatch
// extracted from the raw source but which doesn't appear verbatim in
// the symbolBlock (because symbolBlock was extracted differently),
// causing replaceAll to silently no-op.
// ─────────────────────────────────────────────

function applyReplaceString(source, searchKey, replacementString, context) {
  // PE-6 FIX: Verify search key appears verbatim before counting/replacing
  if (!source.includes(searchKey)) {
    return {
      success: false,
      error:
        `Internal: search key not found verbatim in ${context}. ` +
        `This is a fuzzy-match boundary issue — try a more specific search_string.`,
    };
  }

  const occurrences = countOccurrences(source, searchKey);
  if (occurrences > 1) {
    return {
      success: false,
      error:
        `search_string appears ${occurrences} times in ${context}. ` +
        `Provide more surrounding context to make it unique (add the lines before/after).`,
      occurrences,
    };
  }

  return {
    success: true,
    newSource: source.replaceAll(searchKey, replacementString),
  };
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
      error:
        `Unknown operation '${operation}'. Valid: ` + Object.values(PATCH_OPERATIONS).join(", "),
    };
  }

  // ── CREATE_FILE ─────────────────────────────────────────────────────────
  if (operation === PATCH_OPERATIONS.CREATE_FILE) {
    const resolvedPath = resolveFilePath(file_path);
    if (fs.existsSync(resolvedPath)) {
      return {
        success: false,
        error: `File already exists: ${file_path}. Use replace_body to modify it.`
      };
    }
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    
    const bodyContent = new_body || "";
    fs.writeFileSync(resolvedPath, bodyContent, "utf-8");
    
    // Ensure the new file is indexed into the graph immediately
    reindexFile(resolvedPath, bodyContent);
    postPatchInvalidate(resolvedPath, bodyContent, semanticCache);

    return {
      success: true,
      file: resolvedPath,
      operation: "create_file",
      lines_inserted: bodyContent.split("\n").length,
    };
  }

  // ── INSERT_AT_LINE ──────────────────────────────────────────────────────
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

    const normalizedFilePath = resolveFilePath(file_path);

    let source, hasCRLF;
    try {
      ({ source, hasCRLF } = readSource(normalizedFilePath));
    } catch (err) {
      if (err.code === "ENOENT") {
        return {
          success: false,
          error: `File not found: ${file_path}`,
          hint: "This file does not exist yet. Use operation='create_file' with " +
                "new_body set to the full file content to create it."
        };
      }
      return {
        success: false,
        error: `Cannot read '${normalizedFilePath}': ${err.message}`,
      };
    }

    const lines = source.split("\n");
    const lineNumber = Number(insert_line);

    if (lineNumber < 1 || lineNumber > lines.length + 1) {
      return {
        success: false,
        error:
          `insert_line ${lineNumber} out of range ` +
          `(file has ${lines.length} lines, valid range 1–${lines.length + 1}).`,
      };
    }

    const insertIdx = lineNumber - 1;
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
      message:
        `Inserted ${newBodyLines.length} line(s) at line ${lineNumber} ` +
        `in ${path.basename(normalizedFilePath)}.`,
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
        error:
          `target_symbol is required for ${operation}. ` +
          `Only replace_string and insert_at_line can be used without a target_symbol.`,
      };
    }

    const normalizedFilePath = resolveFilePath(file_path);

    let source, hasCRLF;
    try {
      ({ source, hasCRLF } = readSource(normalizedFilePath));
    } catch (err) {
      if (err.code === "ENOENT") {
        return {
          success: false,
          error: `File not found: ${file_path}`,
          hint: "This file does not exist yet. Use operation='create_file' with " +
                "new_body set to the full file content to create it."
        };
      }
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
      const fuzzyMatch = findFuzzyMatch(source, normalizedSearch);
      if (fuzzyMatch) {
        console.log(`[PatchEngine] 🔧 Fuzzy match found (whitespace diff). Auto-applying.`);

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
          `[PatchEngine] ✅ replace_string (global, fuzzy): ` +
            `${path.basename(normalizedFilePath)} (${linesChanged} line(s) changed)`
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
          message:
            `replace_string applied (auto-corrected whitespace). ` +
            `${linesChanged} line(s) changed. Graph re-indexed.`,
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
      `[PatchEngine] ✅ replace_string (global): ` +
        `${path.basename(normalizedFilePath)} (${linesChanged} line(s) changed)`
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

  const normalizedFilePath = resolveFilePath(resolved.normalizedFilePath);

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
      error: `File too large (${source.length} chars)`,
    };
  }

  let lines = source.split("\n");

  const integrity = checkBodyIntegrity(lines, row);
  if (integrity.stale) {
    console.log(`[PatchEngine] ⚠️  Stale index: ${integrity.reason}. Re-indexing…`);

    // PE-2 FIX: Use reindexFileSync for stale recovery — do NOT call
    // reindexFile() here. reindexFile() defers via setImmediate, scheduling
    // a SECOND writeFileGraph call that fires after the synchronous one below.
    // Previously: reindexFile() (deferred) + inline sync block + setImmediate fires
    // = 3 writeFileGraph calls for one stale detection.
    // Now: reindexFileSync() only = 1 writeFileGraph call.
    reindexFileSync(normalizedFilePath, source);

    const fresh = resolveSymbol(target_symbol, file_path);
    if (fresh.error) {
      return { success: false, error: `After re-index: ${fresh.error}` };
    }
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

      // PE-6 FIX: Verify fuzzy match appears verbatim in symbolBlock before
      // using it as the replacement key. findFuzzyMatch works on the raw source
      // lines and may return a string that doesn't appear verbatim in symbolBlock
      // (different line extraction), causing replaceAll to silently no-op.
      const fuzzyInSymbolVerified =
        fuzzyInSymbol && symbolBlock.includes(fuzzyInSymbol) ? fuzzyInSymbol : null;

      if (fuzzyInSymbolVerified) {
        console.log(`[PatchEngine] 🔧 Fuzzy match inside '${target_symbol}'. Auto-applying.`);

        const replaceResult = applyReplaceString(
          symbolBlock,
          fuzzyInSymbolVerified,
          replacement_string,
          `'${target_symbol}'`
        );
        if (!replaceResult.success) return replaceResult;

        const updatedBlockLines = replaceResult.newSource.split("\n");
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

        const linesChanged = fuzzyInSymbolVerified.split("\n").length;
        const symFuzzyOffset = symbolBlock.indexOf(fuzzyInSymbolVerified);
        const symFuzzyStartLine =
          symFuzzyOffset >= 0
            ? startIdx + symbolBlock.slice(0, symFuzzyOffset).split("\n").length - 1
            : startIdx;
        const symFuzzyEndLine = symFuzzyStartLine + linesChanged - 1;

        console.log(
          `[PatchEngine] ✅ replace_string (symbol, fuzzy): ` +
            `${path.basename(normalizedFilePath)} ` +
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
          message:
            `replace_string applied inside '${target_symbol}' (auto-corrected whitespace). ` +
            `${linesChanged} line(s) changed. Graph re-indexed.`,
        };
      }

      // Strategy 2: Exact match in global file scope
      if (source.includes(normalizedSearch)) {
        console.log(
          `[PatchEngine] 🔧 Search string not in '${target_symbol}' but found in file. ` +
            `Auto-escalating to global scope.`
        );

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
          `[PatchEngine] ✅ replace_string (auto-escalated to global): ` +
            `${path.basename(normalizedFilePath)} (${linesChanged} line(s) changed)`
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
          message:
            `replace_string applied (auto-escalated from '${target_symbol}' to global scope). ` +
            `${linesChanged} line(s) changed. Graph re-indexed.`,
        };
      }

      // Strategy 3: Fuzzy match in global file scope
      const fuzzyInFile = findFuzzyMatch(source, normalizedSearch);
      const fuzzyInFileVerified = fuzzyInFile && source.includes(fuzzyInFile) ? fuzzyInFile : null;

      if (fuzzyInFileVerified) {
        console.log(
          `[PatchEngine] 🔧 Fuzzy match found in file (outside '${target_symbol}'). ` +
            `Auto-applying globally.`
        );

        const globalFuzzyResult = applyReplaceString(
          source,
          fuzzyInFileVerified,
          replacement_string,
          `'${path.basename(normalizedFilePath)}' (global fuzzy from '${target_symbol}')`
        );
        if (!globalFuzzyResult.success) return globalFuzzyResult;

        try {
          atomicWrite(normalizedFilePath, globalFuzzyResult.newSource, hasCRLF);
        } catch (err) {
          return { success: false, error: `Write failed: ${err.message}` };
        }

        const linesChanged = fuzzyInFileVerified.split("\n").length;
        console.log(
          `[PatchEngine] ✅ replace_string (global, fuzzy): ` +
            `${path.basename(normalizedFilePath)} (${linesChanged} line(s) changed)`
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
          message:
            `replace_string applied (auto-escalated to global + auto-corrected whitespace). ` +
            `${linesChanged} line(s) changed. Graph re-indexed.`,
        };
      }

      return {
        success: false,
        error:
          `replace_string: search_string not found inside '${target_symbol}' ` +
          `or anywhere in '${normalizedFilePath}' (even after fuzzy whitespace matching). ` +
          `TIP: Use find_symbol('${target_symbol}') to get the current body, ` +
          `then copy the exact text.`,
        symbol: target_symbol,
        search_string_preview: search_string.slice(0, 200),
      };
    }

    // Exact match found within symbol scope
    const replaceResult = applyReplaceString(
      symbolBlock,
      normalizedSearch,
      replacement_string,
      `'${target_symbol}'`
    );
    if (!replaceResult.success) return replaceResult;

    const updatedBlockLines = replaceResult.newSource.split("\n");
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
      message:
        `replace_string applied. ${linesChanged} line(s) changed inside '${target_symbol}'. ` +
        `Graph re-indexed.`,
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
    message:
      `Patch applied. '${target_symbol}' in ${normalizedFilePath} ` +
      `updated (${diffSummary}). Graph re-indexed.`,
  };
}
