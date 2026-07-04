/**
 * graphTools.js
 *
 * Fixes applied (original):
 *   GT-1: Path normalization strips workspace root prefix.
 *   GT-2: show_callers reads each file once.
 *   GT-3: CONFIDENCE_THRESHOLD removed.
 *   GT-4: executeReadFileChunk uses workspace root, not cwd.
 *   GT-5: process.cwd() fallback removed.
 *
 * Fixes applied (this pass):
 *   GT-3: show_callers snippet extraction corrected — start/end indices
 *         were off by 1 relative to the 1-indexed callLine. Snippet now
 *         correctly centers on the call line with 3 lines before and after.
 *
 *   GT-4: read_function path resolution now uses normalizeTargetPath()
 *         instead of manual drive-letter regex — handles cross-platform
 *         Windows absolute paths correctly when server runs on Linux.
 *
 *   GT-6: find query now attempts direct queryFindSymbol first before
 *         routing through planRetrieval. Direct match returns in <1ms
 *         and skips the full retrieval planner overhead.
 *
 *   GT-8: formatEvidence omits empty calls/literalRefs/envRefs arrays.
 *         Empty arrays added ~250 tokens per 20-result query for no value.
 *
 *   GT-10: find_route with no filter (returns all routes) now capped at
 *          50 results with a truncation notice. Large route tables were
 *          returned unfiltered, potentially sending 3000+ token responses.
 */

import {
  queryWhoImportsThis,
  queryWhatDoesThisExport,
  queryFindSymbol,
  queryFindSymbolFuzzy,
  queryWhatDoesThisImport,
  queryWhoDependsOnFile,
  queryWhoCallsThis,
  querySymbolImpact,
  querySymbolDependencies,
  queryFindRoutes,
  getGraphStats,
  queryFindLiteralsByFn,
  queryFindConfigByFn,
  getWorkspaceRoot,
  getAllIndexedFiles,
  resolvePathCase,
} from "./graphDb.js";
import { statsEmitter } from "../proxy/statsEmitter.js";
import fs from "node:fs";
import path from "node:path";
import { planRetrieval } from "./retrievalPlanner.js";

export { getWorkspaceRoot } from "./graphDb.js";

export const GRAPH_TOOL_NAME = "contextforge_query_graph";

const GRAPH_TOOL_ALIASES = new Set([
  GRAPH_TOOL_NAME,
  `mcp__contextforge__${GRAPH_TOOL_NAME}`,
  `contextforge__${GRAPH_TOOL_NAME}`,
]);

export function normalizeGraphToolName(name) {
  if (!name) return name;
  const match = name.match(/(?:mcp__\w+__|[\w]+__)?(contextforge_query_graph)$/);
  return match ? match[1] : name;
}

// ─────────────────────────────────────────────
// Canonical path normalizer
//
// Converts any path the LLM may pass — absolute Windows, absolute POSIX,
// relative — to a workspace-relative forward-slash path that matches
// what the graph DB stores.
//
// NOTE: Comparison is lowercased for case-insensitive filesystem safety.
// Slice uses original casing to preserve path case in results.
// String length is identical between original and lowercased for ASCII
// paths. Non-ASCII directory names (e.g. CJK characters) may cause
// incorrect slice offsets — acceptable tradeoff for English codebases.
// ─────────────────────────────────────────────

function normalizeTargetPath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return rawPath ?? "";

  let p = rawPath.replace(/\\/g, "/");

  const wsRoot = getWorkspaceRoot().replace(/\\/g, "/");
  const wsPrefix = wsRoot.endsWith("/") ? wsRoot.toLowerCase() : wsRoot.toLowerCase() + "/";

  const pLower = p.toLowerCase();

  if (pLower.startsWith(wsPrefix)) {
    p = p.slice(wsPrefix.length);
  } else if (/^[A-Za-z]:\//.test(p)) {
    p = p.replace(/^[A-Za-z]:\//, "");
  }

  p = p.replace(/^\/+/, "");

  return p;
}

// ─────────────────────────────────────────────
// Read file helper — CRLF normalized
// GB-9 FIX: Resolve canonical path to actual filesystem path for case-sensitive systems
// ─────────────────────────────────────────────

function readFileLines(filePath) {
  try {
    // GB-9: Resolve canonical (lowercased) path back to actual filesystem path
    const actualPath = resolvePathCase(filePath);
    return fs.readFileSync(actualPath, "utf-8").replace(/\r\n/g, "\n").split("\n");
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Find call line from already-loaded lines array
// ─────────────────────────────────────────────

function findCallLineInFileFromLines(lines, functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const callRegex = new RegExp(`\\b${escaped}\\s*\\(`);
  for (let i = 0; i < lines.length; i++) {
    if (callRegex.test(lines[i])) return i + 1; // 1-indexed
  }
  return null;
}

// ─────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────

let _toolDef = null;

export function getGraphToolDefinition() {
  if (_toolDef) return _toolDef;

  _toolDef = {
    type: "function",
    function: {
      name: GRAPH_TOOL_NAME,
      description:
        "Query the pre-built code knowledge graph. " +
        "Returns function bodies, call chains, exports, and route definitions " +
        "without reading files from disk. Results are pre-indexed.\n\n" +
        "## CRITICAL RULES\n" +
        "1. target must be a FUNCTION or METHOD name — never a class name, " +
        "never an error message string, never a file path (except for file queries).\n" +
        "   ✅ find_symbol('getFileById')  — function name\n" +
        "   ✅ find_symbol('renameFile')   — function name\n" +
        "   ❌ find_symbol('File not found') — this is a string literal, not a symbol\n" +
        "   ❌ find_symbol('FileController') — this is a class name, not a function\n" +
        "   To find code that contains a specific error message: use find_symbol on " +
        "the FUNCTION that owns it, not on the message itself.\n\n" +
        "2. If graph returns not_found for a function you know exists:\n" +
        "   → Call what_does_this_export('path/to/file.js') to list all symbols in that file\n" +
        "   → Then call find_symbol or read_function on a symbol from that list\n" +
        "   → Do NOT call find_symbol with error message strings as the target\n\n" +
        "## CHOOSE YOUR WORKFLOW\n\n" +
        "### I know the function name I want to edit:\n" +
        "  Step 1: find_symbol('functionName') → get file path + line numbers\n" +
        "  Step 2: read_function('functionName') → get full body\n" +
        "  Step 3: contextforge_patch_ast → apply edit\n\n" +
        "### I don't know what's in a file:\n" +
        "  Step 1: what_does_this_export('controllers/file.controller.js') → list all exports\n" +
        "  Step 2: read_function('exportedFunctionName') → get full body\n" +
        "  Step 3: contextforge_patch_ast → apply edit\n\n" +
        "### I need to understand impact before editing:\n" +
        "  Step 1: analyze_impact('functionName') → see all callers (2 hops)\n" +
        "  Step 2: read_function('functionName') → get full body\n" +
        "  Step 3: contextforge_patch_ast → apply edit\n\n" +
        "### I need to find an HTTP route handler:\n" +
        "  find_route('/api/files') → returns handler function name + file + line\n\n" +
        "## QUERY REFERENCE\n" +
        "  find_symbol          — locate a function/variable/const by exact name → returns file + line numbers\n" +
        "  read_function        — get the complete body of a function by name\n" +
        "  what_does_this_export — list all exported symbols from a file path\n" +
        "  what_does_this_import — list all imports in a file path\n" +
        "  who_imports_this     — find all files that import a given symbol\n" +
        "  who_depends_on_file  — find all files that depend on a given file path\n" +
        "  show_callers         — find all functions that call function X\n" +
        "  show_dependencies    — find all functions that X calls\n" +
        "  analyze_impact       — 2-hop call chain analysis for safe refactoring\n" +
        "  find_route           — find HTTP route handler by path fragment (e.g. '/v1/chat')\n" +
        "  find                 — broad search across symbols, literals, routes, env vars\n\n" +
        "Always prefer graph queries over reading files — graph results are precise and targeted.",

      parameters: {
        type: "object",
        properties: {
          query_type: {
            type: "string",
            enum: [
              "find_symbol",
              "read_function",
              "what_does_this_export",
              "what_does_this_import",
              "who_imports_this",
              "who_depends_on_file",
              "show_callers",
              "show_dependencies",
              "analyze_impact",
              "find_route",
              "find",
            ],
            description:
              "find_symbol: locate a function/const/variable by exact name. " +
              "Target MUST be a function or variable name — never a class name, " +
              "never an error message string, never a file path.\n" +
              "read_function: get the complete implementation of a named function.\n" +
              "what_does_this_export: list all exports from a file — target is a file path.\n" +
              "what_does_this_import: list all imports in a file — target is a file path.\n" +
              "who_imports_this: find files that import a symbol — target is a symbol name.\n" +
              "who_depends_on_file: find files that depend on a file — target is a file path.\n" +
              "show_callers: find all functions that call X — target is a function name.\n" +
              "show_dependencies: find all functions X calls — target is a function name.\n" +
              "analyze_impact: 2-hop call chain for refactoring safety — target is a function name.\n" +
              "find_route: find HTTP handler by route path fragment — target is a path like '/api/files'.\n" +
              "find: broad search across all symbol types, literals, config values, routes.",
          },
          target: {
            type: "string",
            description:
              "What to search for. Type depends on query_type:\n" +
              "  Symbol queries (find_symbol, read_function, show_callers, show_dependencies, " +
              "analyze_impact, who_imports_this): " +
              "exact function or variable name ONLY. Examples: 'getFileById', 'renameFile', 'uploadFile'.\n" +
              "  File queries (what_does_this_export, what_does_this_import, who_depends_on_file): " +
              "relative file path. Examples: 'controllers/file.controller.js', 'utils/helper.js'.\n" +
              "  Route queries (find_route): URL path fragment. Examples: '/api/files', '/v1/upload'. " +
              "Use empty string '' to list all routes.\n" +
              "  Broad search (find): any term — symbol name, string literal, env var, config key.",
          },
        },
        required: ["query_type", "target"],
        additionalProperties: false,
      },
    },
  };

  return _toolDef;
}

// ─────────────────────────────────────────────
// Shared function-body reader
//
// GT-12: Both find_symbol (conditionally, for small functions) and
// read_function (always) need to resolve a symbol row to its source file
// and slice out the body lines. This was previously duplicated inline
// inside the read_function case only; extracted here so find_symbol can
// reuse the EXACT same path-resolution + slicing logic instead of
// reimplementing it (and risking drift between the two).
//
// sym.start_line/end_line follow the codebase-wide convention: 0-indexed,
// inclusive (see GT-4/symbolExtractor.js/patchEngine.js). Returns
// { bodyLines: string[] } on success or { error, message } on failure —
// callers check for `.error` before using `.bodyLines`.
// ─────────────────────────────────────────────

function readSymbolBody(sym) {
  // GB-9 FIX: Resolve canonical path to actual filesystem path for case-sensitive systems
  let resolvedPath = resolvePathCase(sym.file_path);
  resolvedPath = normalizeTargetPath(resolvedPath);
  if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.resolve(getWorkspaceRoot(), resolvedPath);
  }

  try {
    const content = fs.readFileSync(resolvedPath, "utf-8");
    const allLines = content.replace(/\r\n/g, "\n").split("\n");
    const bodyLines = allLines.slice(sym.start_line, sym.end_line + 1);
    return { bodyLines };
  } catch (e) {
    return { error: "Failed to read file", message: e.message };
  }
}

// ─────────────────────────────────────────────
// Query executor
// ─────────────────────────────────────────────

// GT-10: Maximum routes returned when no filter is applied
const MAX_UNFILTERED_ROUTES = 50;

// GT-12: find_symbol body-inlining thresholds.
//
// Motivation (real session evidence): the "find_symbol → read_function"
// two-hop pattern is the single most common extra round-trip observed in
// real proxy logs (e.g. find_symbol("createSession") in one hop, nothing
// else; a small helper's body could have been returned immediately).
// Inlining is deliberately conservative — it must never turn find_symbol
// into a second read_function-sized response:
//   - MAX_INLINE_BODY_LINES: only inline a definition's body when it is
//     small. 40 lines covers real small helpers/middleware in the user's
//     project (checkAuth: 13 lines, validateID default export: 5 lines)
//     while excluding the actual refactor targets in the reference task
//     (loginUser: 59 lines, loginWithGoogle: larger) — those still need
//     an explicit read_function call, which is correct: inlining a large
//     body into every find_symbol hit (including fuzzy multi-matches)
//     would bloat responses for no benefit and defeat the point of
//     find_symbol staying lean for locate-only queries.
//   - MAX_INLINE_DEFINITIONS: only inline when the query resolved to a
//     small number of definitions. A fuzzy/ambiguous match against many
//     rows should not multiply body-sized payloads across all of them.
const MAX_INLINE_BODY_LINES = 40;
const MAX_INLINE_DEFINITIONS = 3;

export async function executeGraphQuery(queryType, target, args = {}) {
  if (target === undefined || target === null) {
    return JSON.stringify({ error: "target is required" });
  }

  const cleanTarget = normalizeTargetPath(String(target).trim());

  try {
    let result;

    switch (queryType) {
      case "who_imports_this": {
        const rows = queryWhoImportsThis(cleanTarget);
        if (rows.length === 0) {
          result = JSON.stringify({
            symbol: cleanTarget,
            result: "not_found",
            message: `No files import '${cleanTarget}'. It may be internal-only or not yet indexed.`,
          });
          break;
        }
        result = JSON.stringify(
          {
            symbol: cleanTarget,
            imported_by: rows.map((r) => ({
              file: r.source_file,
              symbol: r.source_symbol || "(file-level import)",
            })),
            count: rows.length,
          },
          null,
          2
        );
        break;
      }

      case "what_does_this_export": {
        const rows = queryWhatDoesThisExport(cleanTarget);
        if (rows.length === 0) {
          result = JSON.stringify({
            file: cleanTarget,
            result: "not_found",
            message:
              `No exports found for '${cleanTarget}'. Check the file path or run a graph re-index. ` +
              `If you know the file exists but it might be unindexed or a procedural script, ` +
              `use read_file_chunk(file_path: '${cleanTarget}', start_line: 1, end_line: 99999) to read the full file.`,
          });
          break;
        }
        result = JSON.stringify(
          {
            file: cleanTarget,
            exports: rows.map((r) => ({
              name: r.name,
              kind: r.kind,
              line: r.start_line,
              async: r.is_async === 1,
              complexity: r.complexity,
            })),
            count: rows.length,
            next_step:
              "Use find_symbol with one of the exported names above to get the body and line numbers.",
          },
          null,
          2
        );
        break;
      }

      case "find_symbol": {
        let rows = queryFindSymbol(cleanTarget);
        let isFuzzy = false;

        if (rows.length === 0) {
          rows = queryFindSymbolFuzzy(cleanTarget);
          isFuzzy = rows.length > 0;
        }

        if (rows.length === 0) {
          result = JSON.stringify({
            symbol: cleanTarget,
            result: "not_found",
            message:
              `Symbol '${cleanTarget}' not found in the graph index. ` +
              `Try who_imports_this or what_does_this_export on the file you expect it to live in. ` +
              `If you know the file it lives in, but it lacks named declarations, ` +
              `use read_file_chunk with start_line=1 and end_line=99999 to read the full file directly.`,
          });
          break;
        }

        // GT-12: Inline the body when this is a small, unambiguous match —
        // eliminates the find_symbol → read_function follow-up hop for the
        // common case (locating and reading a small helper/middleware in
        // one call). Only attempted when there are few enough definitions
        // that inlining all of them stays cheap; each candidate is checked
        // individually against MAX_INLINE_BODY_LINES so a mix of small and
        // large matches doesn't inline the large ones.
        const attemptInline = !isFuzzy && rows.length <= MAX_INLINE_DEFINITIONS;

        const definitions = rows.map((r) => {
          const def = {
            file: r.file_path,
            kind: r.kind,
            start_line: r.start_line,
            end_line: r.end_line,
            complexity: r.complexity,
          };

          if (attemptInline) {
            const lineCount = r.end_line - r.start_line + 1;
            if (lineCount > 0 && lineCount <= MAX_INLINE_BODY_LINES) {
              const bodyResult = readSymbolBody(r);
              if (!bodyResult.error) {
                def.body = bodyResult.bodyLines.join("\n");
              }
              // On read failure, silently omit `body` — find_symbol's
              // location data is still valid and useful even if the file
              // couldn't be read for inlining; read_function will
              // surface the same error explicitly if the model retries.
            }
          }

          return def;
        });

        const anyInlined = definitions.some((d) => d.body !== undefined);

        result = JSON.stringify(
          {
            symbol: cleanTarget,
            fuzzy_match: isFuzzy,
            ...(isFuzzy && {
              fuzzy_note:
                `Exact match not found. Showing ${rows.length} partial match(es) for '${cleanTarget}'. ` +
                `Use the exact name from the results for subsequent queries.`,
            }),
            definitions,
            count: rows.length,
            next_step: anyInlined
              ? "Body included above for small definition(s) — no read_function call needed unless you need a definition without an inlined body."
              : "Call read_function('" +
                cleanTarget +
                "') to get the full implementation body and line numbers.",
          },
          null,
          2
        );
        break;
      }

      case "what_does_this_import": {
        const rows = queryWhatDoesThisImport(cleanTarget);
        if (rows.length === 0) {
          result = JSON.stringify({
            file: cleanTarget,
            result: "not_found",
            message: `No imports found for '${cleanTarget}'.`,
          });
          break;
        }
        result = JSON.stringify(
          {
            file: cleanTarget,
            imports: rows.map((r) => ({
              symbol: r.target_symbol,
              from: r.target_file || "(external package)",
            })),
            count: rows.length,
          },
          null,
          2
        );
        break;
      }

      case "who_depends_on_file": {
        const rows = queryWhoDependsOnFile(cleanTarget);
        if (rows.length === 0) {
          result = JSON.stringify({
            file: cleanTarget,
            result: "no_dependents",
            message: `No files import from '${cleanTarget}'.`,
          });
          break;
        }
        result = JSON.stringify(
          {
            file: cleanTarget,
            dependents: rows.map((r) => r.source_file),
            count: rows.length,
          },
          null,
          2
        );
        break;
      }

      case "show_callers": {
        const rows = queryWhoCallsThis(cleanTarget);

        if (rows.length === 0) {
          result = JSON.stringify({
            symbol: cleanTarget,
            result: "no_callers",
            message:
              `No indexed callers found for '${cleanTarget}'. ` +
              `This does NOT mean the function is never called — ` +
              `top-level scripts and anonymous callbacks may not appear as callers in the graph. ` +
              `NEXT STEP: Use who_imports_this('${cleanTarget}') to find which files import this symbol, ` +
              `then read those files directly to locate the call site. ` +
              `Do NOT retry show_callers with variations of the name.`,
          });
          break;
        }

        // GT-2: Read each file once, reuse lines for all operations
        const callers = rows.map((r) => {
          let callLine = r.source_line ?? null;
          const rawFileName = r.source_file;
          let fileName = normalizeTargetPath(rawFileName);
          if (!path.isAbsolute(fileName)) {
            fileName = path.resolve(getWorkspaceRoot(), fileName);
          }
          const lines = readFileLines(fileName);

          if (!callLine && lines) {
            callLine = findCallLineInFileFromLines(lines, cleanTarget);
          }

          let snippet = null;
          let callText = null;

          if (callLine && lines) {
            // GT-3 FIX: callLine is 1-indexed, lines is 0-indexed.
            // Convert to 0-indexed: lines[callLine - 1] is the call line.
            // Take 3 lines before and 3 lines after for 7-line context window.
            const zeroIdx = callLine - 1;
            const start = Math.max(0, zeroIdx - 3);
            const end = Math.min(lines.length, zeroIdx + 4); // +4 = line + 3 after
            snippet = lines.slice(start, end).join("\n");

            const raw = lines[zeroIdx]?.trim() ?? "";
            callText = raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
          }

          return {
            file: fileName,
            caller: r.source_symbol || "(module scope — top-level script)",
            call_line: callLine,
            call_text: callText,
            code_snippet: snippet,
          };
        });

        result = JSON.stringify(
          {
            symbol: cleanTarget,
            callers,
            count: rows.length,
            hint:
              "Use 'call_line' and 'call_text' to locate the exact call site. " +
              "Use 'code_snippet' (7 lines of context) to see how the function is called " +
              "and to build search_string values for patches.",
          },
          null,
          2
        );
        break;
      }

      case "show_dependencies": {
        const rows = querySymbolDependencies(cleanTarget);
        if (rows.length === 0) {
          result = JSON.stringify({
            symbol: cleanTarget,
            result: "no_dependencies",
            message: `'${cleanTarget}' makes no indexed function calls, or is not yet indexed.`,
          });
          break;
        }
        result = JSON.stringify(
          {
            symbol: cleanTarget,
            dependencies: rows.map((r) => ({
              calls: r.target_symbol,
              file: r.target_file || "(same file)",
              kind: r.kind || "unknown",
              line: r.start_line || null,
            })),
            count: rows.length,
          },
          null,
          2
        );
        break;
      }

      case "analyze_impact": {
        const rows = querySymbolImpact(cleanTarget);
        if (rows.length === 0) {
          result = JSON.stringify({
            symbol: cleanTarget,
            result: "no_impact",
            message: `No callers found for '${cleanTarget}'. Safe to modify without cascading changes.`,
          });
          break;
        }

        const direct = rows.filter((r) => r.depth === 1);
        const transitive = rows.filter((r) => r.depth === 2);

        result = JSON.stringify(
          {
            symbol: cleanTarget,
            analysis: "call_chain_impact",
            summary:
              `${rows.length} affected symbol(s): ` +
              `${direct.length} direct caller(s), ${transitive.length} transitive caller(s).`,
            direct_callers: direct.map((r) => ({
              file: r.source_file,
              caller: r.source_symbol || "(file-level)",
            })),
            transitive_callers: transitive.map((r) => ({
              file: r.source_file,
              caller: r.source_symbol || "(file-level)",
            })),
            recommendation:
              rows.length > 10
                ? "High-impact change. Review all callers before modifying."
                : rows.length > 0
                  ? "Moderate impact. Update callers as needed."
                  : "Low impact. No cascading changes required.",
          },
          null,
          2
        );
        break;
      }

      case "retrieve": {
        const intent = args.intent ?? "location";
        const validIntents = ["location", "implementation", "architecture", "debug"];

        if (!validIntents.includes(intent)) {
          result = JSON.stringify({
            error: "invalid_intent",
            valid: validIntents,
            message: `intent must be one of: ${validIntents.join(", ")}`,
          });
          break;
        }

        const plan = await planRetrieval(cleanTarget, intent);

        result = JSON.stringify(
          {
            query: cleanTarget,
            intent,
            confidence: plan.confidence,
            strategy: plan.strategy,
            tiers_used: plan.tiersUsed,
            answer: plan.answer,
          },
          null,
          2
        );
        break;
      }

      case "find": {
        clearLineCache(); // F6: files may have changed since the last query
        // GT-6 FIX: Fast path — try direct symbol lookup before routing through
        // planRetrieval. queryFindSymbol is a synchronous O(1) index lookup that
        // returns in <1ms. planRetrieval involves async embedding + multiple graph
        // queries. Skipping it on direct matches saves 50-200ms per find call.
        const directRows = queryFindSymbol(cleanTarget);
        if (directRows.length > 0) {
          const formatted = directRows.map((r) => ({
            type: "symbol",
            name: cleanTarget,
            kind: r.kind,
            file: r.file_path,
            startLine: r.start_line,
            endLine: r.end_line,
            complexity: r.complexity,
          }));
          result = JSON.stringify(
            {
              query: cleanTarget,
              confidence: 1.0,
              strategy_used: "direct_symbol_match",
              results: formatted,
              count: formatted.length,
              hint: "Call read_function('" + cleanTarget + "') to get full implementation.",
            },
            null,
            2
          );
          break;
        }

        // Slow path: retrieval planner for fuzzy/semantic/route/literal search
        const plan = await planRetrieval(cleanTarget, "implementation");

        if (!plan.evidence.length) {
          result = JSON.stringify({
            query: cleanTarget,
            result: "not_found",
            strategy_used: plan.strategy,
            message: `'${cleanTarget}' not found. Try a different search term.`,
          });
          break;
        }

        const formatted = formatEvidence(plan.evidence);

        result = JSON.stringify(
          {
            query: cleanTarget,
            confidence: plan.confidence,
            strategy_used: plan.strategy,
            results: formatted,
            count: formatted.length,
            hint: "Call read_function('name') to get full implementation.",
          },
          null,
          2
        );
        break;
      }

      case "read_function": {
        let rows = queryFindSymbol(cleanTarget);
        if (rows.length === 0) {
          result = JSON.stringify({
            symbol: cleanTarget,
            result: "not_found",
            message: `Symbol '${cleanTarget}' not found. Try find('${cleanTarget}') first.`,
          });
          break;
        }

        const sym = rows[0];

        // GT-4 FIX (now routed through the shared readSymbolBody helper,
        // see GT-12): resolves cross-platform paths (graph DB built on
        // Windows, server running on Linux) via normalizeTargetPath before
        // falling back to workspace-root resolution, then slices the
        // 0-indexed, inclusive body range. find_symbol now reuses this
        // exact same logic when inlining small-function bodies.
        const bodyReadResult = readSymbolBody(sym);
        if (bodyReadResult.error) {
          result = JSON.stringify({
            error: bodyReadResult.error,
            message: bodyReadResult.message,
          });
          break;
        }
        const bodyLines = bodyReadResult.bodyLines;

        // GT-11 FIX: literalExtractor.js's findContainingFunction stores
        // containing_fn as the FULL stable ID ("filePath:startLine:name") —
        // the same convention used everywhere else a function is identified
        // by containing_fn (buildNodeSummaries, buildRetrievalDocument both
        // compare against nodeId in that exact format). Passing the bare
        // symbol name here meant `WHERE containing_fn = ?` could never
        // match — read_function's "Environment Variables:"/"Literals:"
        // relatedContext section was silently empty for every symbol, in
        // every project, regardless of what the function actually referenced.
        const containingFnStableId = `${sym.file_path}:${sym.start_line}:${cleanTarget}`;
        const literals = queryFindLiteralsByFn(containingFnStableId, sym.file_path);
        const configs = queryFindConfigByFn(containingFnStableId, sym.file_path);

        const relatedContext = [];
        if (configs.length > 0) {
          relatedContext.push("Environment Variables:");
          configs.forEach((c) => relatedContext.push(`  - ${c.key} (${c.raw_text})`));
        }
        if (literals.length > 0) {
          relatedContext.push("Literals:");
          literals.forEach((l) => relatedContext.push(`  - "${l.value}" (${l.kind})`));
        }

        const readFnResponse = {
          symbol: cleanTarget,
          file: sym.file_path,
          startLine: sym.start_line,
          endLine: sym.end_line,
          relatedContext: relatedContext.length > 0 ? relatedContext.join("\n") : "None",
          body: bodyLines.join("\n"),
        };

        if (rows.length > 1) {
          readFnResponse.note =
            `${rows.length} definitions found — showing the exported/most complex one. ` +
            `Use find('${cleanTarget}') to see all.`;
        }

        result = JSON.stringify(readFnResponse, null, 2);
        break;
      }

      case "find_route": {
        const filter = cleanTarget.length > 0 ? cleanTarget : null;
        const rows = queryFindRoutes(filter);

        if (rows.length === 0) {
          result = JSON.stringify({
            filter: filter || "(all routes)",
            result: "no_routes",
            message: filter
              ? `No HTTP routes matching '${filter}' found.`
              : "No HTTP routes found. Routes are detected from Express/Fastify/Hono patterns.",
          });
          break;
        }

        // GT-10 FIX: Cap unfiltered route lists to prevent massive responses.
        // A 50+ route application would send 3000+ tokens for all routes.
        // Use a filter to narrow results for large applications.
        const truncated = !filter && rows.length > MAX_UNFILTERED_ROUTES;
        const displayRows = truncated ? rows.slice(0, MAX_UNFILTERED_ROUTES) : rows;

        result = JSON.stringify(
          {
            filter: filter || "(all routes)",
            routes: displayRows.map((r) => ({
              route: r.route_path,
              file: r.source_file,
              start_line: r.source_line ?? null,
              handler: r.handler || "(inline)",
              patch_hint: r.handler
                ? `Use find_symbol('${r.handler}') to get the handler body and line numbers.`
                : r.source_line
                  ? `Route is inline at line ${r.source_line} — use insert_at_line with insert_line=${r.source_line} or read_file_chunk to get surrounding context.`
                  : `Route is inline — use contextforge_retrieve on ${r.source_file} to get surrounding context.`,
            })),
            count: rows.length,
            ...(truncated
              ? {
                  truncated: true,
                  note: `Showing first ${MAX_UNFILTERED_ROUTES} of ${rows.length} routes. Pass a route fragment as 'target' to narrow results.`,
                }
              : {}),
          },
          null,
          2
        );
        break;
      }

      default:
        result = JSON.stringify({
          error: "unknown_query_type",
          query_type: queryType,
          valid_types: [
            "find",
            "read_function",
            "who_imports_this",
            "what_does_this_export",
            "find_symbol",
            "what_does_this_import",
            "who_depends_on_file",
            "show_callers",
            "show_dependencies",
            "analyze_impact",
            "find_route",
          ],
        });
    }

    statsEmitter.recordGraphQuery(queryType, cleanTarget);
    return result;
  } catch (err) {
    console.error(`[GraphQuery] ❌ Query failed: ${err.message}`);
    return JSON.stringify({
      error: "query_failed",
      message: err.message,
    });
  }
}

// ─────────────────────────────────────────────
// Ghost Interceptor helpers
// ─────────────────────────────────────────────

export function isGraphToolCall(toolName) {
  return GRAPH_TOOL_ALIASES.has(toolName) || normalizeGraphToolName(toolName) === GRAPH_TOOL_NAME;
}

let _graphInjectedOnce = false;

export function injectGraphTool(tools) {
  const currentTools = tools || [];

  // RQ-7 FIX: was comparing tool.name/tool.function?.name against the bare
  // GRAPH_TOOL_NAME only. A request that already carries the MCP-discovered
  // alias (`mcp__contextforge__contextforge_query_graph`) never matched this
  // check, so calling injectGraphTool() on an MCP-registered session would
  // push a SECOND, bare-named "contextforge_query_graph" tool alongside the
  // one Claude Code already has via MCP — true double-injection. Use
  // isGraphToolCall(), which already checks GRAPH_TOOL_ALIASES (bare name +
  // both MCP prefix forms), so any alias already present is recognized.
  for (const tool of currentTools) {
    const name = tool.name || tool.function?.name;
    if (isGraphToolCall(name)) return currentTools;
  }

  if (!_graphInjectedOnce) {
    try {
      const stats = getGraphStats();
      const nodeCount = stats?.node_count ?? 0;
      console.log(`[GraphInject] ✅ Graph tool active — ${nodeCount} nodes indexed`);
    } catch (err) {
      console.log(`[GraphInject] ⚠️  graphDb not ready (${err.message})`);
    }
    _graphInjectedOnce = true;
  }

  return [...currentTools, getGraphToolDefinition()];
}

// ─────────────────────────────────────────────
// read_file_chunk
// ─────────────────────────────────────────────

export const READ_FILE_CHUNK_TOOL_NAME = "read_file_chunk";

export function isReadFileChunkTool(toolName) {
  if (!toolName) return false;
  return toolName === READ_FILE_CHUNK_TOOL_NAME || toolName.includes(READ_FILE_CHUNK_TOOL_NAME);
}

export function executeReadFileChunk(filePath, startLine, endLine) {
  if (!filePath || typeof filePath !== "string") {
    return JSON.stringify({ error: "file_path is required" });
  }

  const start = parseInt(startLine, 10);
  const end = parseInt(endLine, 10);

  if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
    return JSON.stringify({
      error: "Invalid line range",
      message:
        `start_line and end_line must be positive integers with end_line >= start_line. ` +
        `Got start=${startLine}, end=${endLine}.`,
    });
  }

  let resolvedPath = filePath.replace(/\\/g, "/");
  if (!path.isAbsolute(resolvedPath) && !/^[A-Za-z]:\//.test(resolvedPath)) {
    const workspaceRoot = getWorkspaceRoot();
    resolvedPath = path.resolve(workspaceRoot, filePath);

    if (!fs.existsSync(resolvedPath)) {
      const allIndexedFiles = getAllIndexedFiles();
      const queryPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
      const matches = allIndexedFiles.filter((f) => {
        const indexedPath = f.file_path.replace(/\\/g, "/");
        return indexedPath === queryPath || indexedPath.endsWith("/" + queryPath);
      });

      if (matches.length === 1) {
        // GB-9: Resolve canonical path back to actual filesystem path for case-sensitive systems
        resolvedPath = resolvePathCase(matches[0].file_path);
      } else if (matches.length > 1) {
        return JSON.stringify({
          error: "Ambiguous file path",
          message:
            `Found multiple files matching '${filePath}'. ` +
            `Please provide the full path relative to workspace root. ` +
            `Matches: ${matches.map((m) => m.file_path).join(", ")}`,
        });
      } else {
        return JSON.stringify({
          error: "File not found",
          message:
            `'${filePath}' does not exist relative to workspace root '${workspaceRoot}'. ` +
            `If this is a newly created file, wait for the graph to re-index or provide the full absolute path.`,
        });
      }
    }
  }

  try {
    const content = fs.readFileSync(resolvedPath, "utf-8");
    const normalized = content.replace(/\r\n/g, "\n");
    const allLines = normalized.split("\n");

    if (start > allLines.length) {
      return JSON.stringify({
        error: "start_line beyond file end",
        message: `File '${filePath}' has ${allLines.length} lines. Requested start_line=${start}.`,
      });
    }

    const actualEnd = Math.min(end, allLines.length);
    const chunk = allLines.slice(start - 1, actualEnd);

    const searchHint = chunk.length > 0 && chunk[0].trim() ? chunk[0].trim().substring(0, 40) : "";

    let outText = chunk.join("\n");
    if (outText.length > 0) {
      outText += `\n\n[CF_HINT] To patch this file: use contextforge_patch_ast with search_string set to an exact line from above and file_path="${filePath}".`;
    }
    return outText;
  } catch (err) {
    if (err.code === "ENOENT") {
      return JSON.stringify({
        error: "File not found",
        message: `'${filePath}' does not exist. Check the path — graph tools use paths relative to the workspace root.`,
      });
    }
    console.error(`[read_file_chunk] ❌ Failed: ${err.message}`);
    return JSON.stringify({
      error: "Read failed",
      message: err.message,
    });
  }
}

export function getReadFileChunkToolDefinition() {
  return {
    type: "function",
    function: {
      name: READ_FILE_CHUNK_TOOL_NAME,
      description:
        "Read a range of lines from a file on disk. " +
        "Use start_line=1, end_line=99999 to read the entire file. " +
        "Combine with find_symbol to get exact start_line/end_line for specific functions. " +
        "Returns raw, exact text that matches the file on disk — " +
        "perfect for building search_string values for editing tools.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "File path relative to workspace root (e.g., 'src/proxy/upstreamRequest.js')",
          },
          start_line: {
            type: "integer",
            description:
              "First line to read (1-indexed, inclusive). Use the start_line from find_symbol results.",
          },
          end_line: {
            type: "integer",
            description:
              "Last line to read (1-indexed, inclusive). Use 99999 to read to end of file.",
          },
        },
        required: ["file_path", "start_line", "end_line"],
        additionalProperties: false,
      },
    },
  };
}

let _readFileChunkInjectedOnce = false;

export function injectReadFileChunkTool(tools) {
  const currentTools = tools || [];

  // RQ-7 FIX: same class of bug as injectGraphTool — bare-name-only
  // comparison missed an MCP-discovered alias already present. isReadFileChunkTool()
  // already checks both the bare name and any name containing it (covers
  // the mcp__contextforge__read_file_chunk form).
  for (const tool of currentTools) {
    const name = tool.name || tool.function?.name;
    if (isReadFileChunkTool(name)) return currentTools;
  }

  if (!_readFileChunkInjectedOnce) {
    _readFileChunkInjectedOnce = true;
  }

  return [...currentTools, getReadFileChunkToolDefinition()];
}

// ─────────────────────────────────────────────
// Evidence formatter for find/retrieve results
//
// GT-8 FIX: Empty arrays (calls, literalRefs, envRefs) are omitted from
// output. Each empty array adds ~20 chars of JSON per result entry.
// For a find query returning 20 symbols, this saves ~1200 chars (~300 tokens).
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// F6: include the actual matching source line in find results.
//
// Session evidence (S3-refactor run 2): find("BUCKET_NAME") and
// find("AWS_BUCKET_NAME") returned indistinguishable results — file+line
// but no text — so the model re-read three files to tell refactored call
// sites (`Bucket: BUCKET_NAME`) from unrefactored ones
// (`Bucket: process.env.AWS_BUCKET_NAME`). One line of text per hit
// (~15 tokens) eliminates those re-reads.
// ─────────────────────────────────────────────

const _lineCache = new Map(); // filePath -> string[] (per-call cache, cleared each query)

function readSourceLine(filePath, lineNumber, valueHint = null) {
  if (filePath == null || lineNumber == null) return null;
  try {
    let lines = _lineCache.get(filePath);
    if (!lines) {
      // GB-9: Resolve canonical path to actual filesystem path for case-sensitive systems
      let resolved = resolvePathCase(filePath);
      resolved = normalizeTargetPath(resolved);
      if (!path.isAbsolute(resolved)) resolved = path.resolve(getWorkspaceRoot(), resolved);
      lines = fs.readFileSync(resolved, "utf-8").replace(/\r\n/g, "\n").split("\n");
      _lineCache.set(filePath, lines);
    }

    // Index conventions differ across extractor paths (tree-sitter rows are
    // 0-based; some DB writers store 1-based). When we know the value we're
    // looking for, snap to the candidate line that actually CONTAINS it —
    // robust regardless of convention, and tolerant of ±1 drift after edits.
    const candidates = [lineNumber, lineNumber - 1, lineNumber + 1];
    let raw = null;
    if (valueHint) {
      for (const idx of candidates) {
        const l = lines[idx];
        if (typeof l === "string" && l.includes(valueHint)) {
          raw = l;
          break;
        }
      }
    }
    if (raw === null) raw = lines[lineNumber] ?? lines[lineNumber - 1];
    if (typeof raw !== "string") return null;

    const trimmed = raw.trim();
    return trimmed.length > 160 ? trimmed.slice(0, 157) + "…" : trimmed;
  } catch {
    return null;
  }
}

function clearLineCache() {
  _lineCache.clear();
}

function formatEvidence(evidence) {
  const output = [];
  for (const e of evidence) {
    for (const item of e.items) {
      if (item.type === "symbol") {
        const entry = {
          type: "symbol",
          name: item.name,
          kind: item.kind,
          file: item.file,
          startLine: item.startLine,
          endLine: item.endLine,
          complexity: item.complexity,
          signature: item.signature,
        };

        // GT-8 FIX: Only include non-empty arrays — omit empty ones to save tokens
        if (item.calls?.length) entry.calls = item.calls;
        if (item.literalRefs?.length) entry.literalRefs = item.literalRefs;
        if (item.envRefs?.length) entry.envRefs = item.envRefs;

        output.push(entry);
      } else if (item.type === "route") {
        const routeLineText = readSourceLine(item.file, item.line, item.route || null);
        output.push({
          type: "route",
          route: item.route,
          file: item.file,
          line: item.line,
          ...(routeLineText ? { line_text: routeLineText } : {}),
          handler: item.handler,
        });
      } else if (item.type === "literal" || item.type === "env_var") {
        // F6: the actual source line — lets the model distinguish
        // `Bucket: BUCKET_NAME` from `Bucket: process.env.AWS_BUCKET_NAME`
        // without a follow-up read.
        const lineText = readSourceLine(item.file, item.line, item.value || item.key || null);
        output.push({
          type: item.type,
          value: item.value || item.key,
          file: item.file,
          line: item.line,
          ...(lineText ? { line_text: lineText } : {}),
          usedIn: item.usedIn,
          ...(item.containing_function ? { containing_function: item.containing_function } : {}),
        });
      }
    }
  }
  return output;
}
