/**
 * graphTools.js
 *
 * G3 fix: find_symbol caps body_text at 1,500 chars in the response.
 * G4 fix: find_symbol falls back to LIKE fuzzy match on exact miss.
 * G5 fix: show_callers "no_callers" guides LLM to who_imports_this.
 * W-CRLF fix: show_callers code_snippet normalizes line endings.
 * Log fix: GraphInject only logs on first injection per process.
 * find_route fix: adds start_line + patch hint to route results.
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
} from "./graphDb.js";
import { statsEmitter } from "../proxy/statsEmitter.js";
import fs from "node:fs";
import path from "node:path";
import { planRetrieval } from "./retrievalPlanner.js";

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
// G3 helper: cap body text in find_symbol responses
// ─────────────────────────────────────────────

const BODY_CHAR_LIMIT = 1500;

// ADD after it:
// Configurable confidence threshold for semantic fallback.
// Below this value, resolveWithEmbeddings() is invoked.
// Override via CF_GRAPH_CONFIDENCE env var.
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CF_GRAPH_CONFIDENCE ?? "0.4");

function capBodyText(bodyText, symbolName) {
  if (!bodyText) return null;

  // Normalize CRLF → LF so the body returned matches what
  // the LLM sees in the actual file (on Windows).
  const normalized = bodyText.replace(/\r\n/g, "\n");

  if (normalized.length <= BODY_CHAR_LIMIT) return normalized;

  const lines = normalized.split("\n");
  let charCount = 0;
  let cutLine = 0;

  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i].length + 1;
    if (charCount > BODY_CHAR_LIMIT) {
      cutLine = i;
      break;
    }
  }

  const truncated = lines.slice(0, cutLine).join("\n");
  const remaining = lines.length - cutLine;
  const truncNote =
    `\n// ... ${remaining} more lines truncated ` +
    `(${normalized.length} chars total). ` +
    `Use read_file_chunk with the line numbers above to get the full raw text.`;

  return truncated + truncNote;
}

// ─────────────────────────────────────────────
// Read file helper — CRLF normalized
// Used by show_callers to build code_snippet
// ─────────────────────────────────────────────

function readFileLines(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf-8")
      .replace(/\r\n/g, "\n") // normalize Windows CRLF → LF
      .split("\n");
  } catch {
    return null;
  }
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
        "Query the ContextForge code knowledge graph. " +
        "Use this tool INSTEAD of grep, find, or bash search " +
        "when you need to locate a symbol, find imports, trace call chains, or check exports. " +
        "Results are pre-indexed and return instantly at zero token cost. " +
        "\n\nWORKFLOW:" +
        "\n  1. what_does_this_export('src/path/to/file.js') — list all exported symbols" +
        "\n  2. find('specificFunctionName') — returns metadata and signature only — call read_function(name) if you need the implementation" +
        "\n  3. read_function('specificFunctionName') — get the exact full function body and related context" +
        "\n  4. Use read_file_chunk if you need more surrounding code." +
        "\n  NEVER search for class names — always search for function or method names (e.g. 'decide', not 'CompressionDecision')." +
        "\n\nSpatial queries:" +
        "\n  find                  — locate any function, class, variable, literal, config, or route" +
        "\n  read_function         — read the full body of a function/symbol" +
        "\n  who_imports_this      — find all files that import a symbol" +
        "\n  what_does_this_export — list a file's exports without reading it" +
        "\n  what_does_this_import — list everything a file imports" +
        "\n  who_depends_on_file   — find files that depend on a specific file" +
        "\n\nRelational queries:" +
        "\n  show_callers      — find all functions that call function X" +
        "\n  show_dependencies — find all functions that X calls" +
        "\n  analyze_impact    — full call-chain impact analysis (2 hops) for safe refactoring" +
        "\n  find_route        — find HTTP route handlers by path fragment (e.g. '/v1/chat')" +
        "\n\nAlways try this before reading any file.",
      parameters: {
        type: "object",
        properties: {
          query_type: {
            type: "string",
            enum: [
              "retrieve",
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
            description:
              "\n  retrieve — unified retrieval with automatic source selection. " +
              "Pass query + intent (location|implementation|architecture|debug). " +
              "ContextForge decides whether to use graph, function body, call graph, or file. " +
              "USE THIS FIRST before any other query type.\n" +
              "\n  find — unified search across symbols, literals, routes, env vars, and config. Returns metadata only." +
              "\n  read_function — read the exact full body of a symbol by name, plus related context." +
              "\n  Spatial: who_imports_this, what_does_this_export, find_symbol, " +
              "what_does_this_import, who_depends_on_file. " +
              "Relational: show_callers (who calls X), show_dependencies (what X calls), " +
              "analyze_impact (full 2-hop call chain for refactoring safety), " +
              "find_route (HTTP route by path fragment). " +
              "For file analysis: start with what_does_this_export to get symbol names, " +
              "then find_symbol for specific functions. Never search by class name.",
          },
          target: {
            type: "string",
            description:
              "Function or method name (e.g. 'decide', 'sliceJsonOutput') for symbol queries — " +
              "NOT class names. " +
              "File path (e.g. 'src/helper.js') for file queries. " +
              "Route fragment (e.g. '/v1/chat') for find_route. " +
              "Pass empty string to find_route to list all routes.",
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
// Query executor
// ─────────────────────────────────────────────

export async function executeGraphQuery(queryType, target, args = {}) {
  if (target === undefined || target === null) {
    return JSON.stringify({ error: "target is required" });
  }

  let cleanTarget = String(target).trim();

  // Normalize absolute paths to relative
  const cwdNormalized = process.cwd().replace(/\\/g, "/").toLowerCase();
  const targetNormalized = cleanTarget.replace(/\\/g, "/");
  const targetLower = targetNormalized.toLowerCase();
  if (targetLower.startsWith(cwdNormalized + "/")) {
    cleanTarget = targetNormalized.slice(cwdNormalized.length + 1);
  } else {
    cleanTarget = targetNormalized.replace(/^[A-Za-z]:\//, "");
  }

  try {
    let result;

    switch (queryType) {
      // ── Spatial queries ──

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
            message: `No exports found for '${cleanTarget}'. Check the file path or run a graph re-index. If you know the file exists but it might be unindexed or a procedural script, use read_file_chunk(file_path: '${cleanTarget}', start_line: 1, end_line: 99999) to read the full file.`,
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
              `If you know the file it lives in, but it lacks named declarations, use read_file_chunk with start_line=1 and end_line=99999 to read the full file directly.`,
          });
          break;
        }

        const definitions = rows.map((r) => ({
          file: r.file_path,
          kind: r.kind,
          start_line: r.start_line,
          end_line: r.end_line,
          complexity: r.complexity,
          body: capBodyText(r.body_text, r.name),
        }));

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
            tip: "If body shows truncation ('... N more lines'), use read_file_chunk with the start_line/end_line above to get the complete raw text.",
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

      // ── Relational queries ──

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

        const callers = rows.map((r) => {
          let snippet = null;
          let callLine = r.source_line ?? null;
          const fileName = r.source_file;

          // source_line not yet populated for this edge (indexed before migration).
          // Grep the source file to find the call site.
          if (!callLine) {
            callLine = findCallLineInFile(fileName, cleanTarget);
          }

          if (callLine) {
            const lines = readFileLines(fileName);
            if (lines) {
              const start = Math.max(0, callLine - 4);
              const end = Math.min(lines.length, callLine + 3);
              snippet = lines.slice(start, end).join("\n");
            }
          }

          // Extract just the call line text for exact search_string values
          let callText = null;
          if (callLine) {
            const lines = readFileLines(fileName);
            if (lines && callLine > 0 && callLine <= lines.length) {
              const raw = lines[callLine - 1].trim();
              callText = raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
            }
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

      // ADD before the "find" case:
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

      // In executeGraphQuery, add new case:

      case "find": {
        // Use the evidence planner for all find queries
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

        // Take the first definition
        const sym = rows[0];

        // More robust resolution matching executeReadFileChunk's pattern:
        let resolvedPath = sym.file_path;
        // Handle both relative and absolute (including Windows D:/ after normalization)
        if (!path.isAbsolute(resolvedPath) && !resolvedPath.match(/^[A-Za-z]:\//)) {
          resolvedPath = path.resolve(getWorkspaceRoot(), resolvedPath);
        } else {
          // Convert forward slashes back to OS path separators on Windows
          resolvedPath = resolvedPath.replace(/\//g, path.sep);
        }

        let bodyLines = [];
        try {
          const content = fs.readFileSync(resolvedPath, "utf-8");
          const allLines = content.replace(/\r\n/g, "\n").split("\n");
          bodyLines = allLines.slice(sym.start_line - 1, sym.end_line);
        } catch (e) {
          result = JSON.stringify({ error: "Failed to read file", message: e.message });
          break;
        }

        // Fetch literals and configs
        const literals = queryFindLiteralsByFn(cleanTarget, sym.file_path);
        const configs = queryFindConfigByFn(cleanTarget, sym.file_path);

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
          readFnResponse.note = `${rows.length} definitions found — showing the exported/most complex one. Use find('${cleanTarget}') to see all.`;
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
        result = JSON.stringify(
          {
            filter: filter || "(all routes)",
            routes: rows.map((r) => ({
              route: r.route_path,
              file: r.source_file,
              start_line: r.source_line ?? null, // ← ADD THIS
              handler: r.handler || "(inline)",
              patch_hint: r.handler
                ? `Use find_symbol('${r.handler}') to get the handler body and line numbers.`
                : r.source_line
                  ? `Route is inline at line ${r.source_line} — use insert_at_line with insert_line=${r.source_line} or read_file_chunk to get surrounding context.`
                  : `Route is inline — use contextforge_retrieve on ${r.source_file} to get surrounding context.`,
            })),
            count: rows.length,
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

  for (const tool of currentTools) {
    const name = tool.name || tool.function?.name;
    if (name === GRAPH_TOOL_NAME) {
      return currentTools;
    }
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

// ─────────────────────────────────────────────────────────────
// read_file_chunk — surgical file reading (supports full files)
// ─────────────────────────────────────────────────────────────

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
      message: `start_line and end_line must be positive integers with end_line >= start_line. Got start=${startLine}, end=${endLine}.`,
    });
  }

  let resolvedPath = filePath;
  if (!path.isAbsolute(resolvedPath)) {
    // Try workspace root first (from the graph mapper), then fall back to cwd
    const workspaceRoot = getWorkspaceRoot();
    resolvedPath = path.resolve(workspaceRoot, resolvedPath);
    if (!fs.existsSync(resolvedPath)) {
      resolvedPath = path.resolve(process.cwd(), filePath);
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

    const result = {
      file: filePath,
      start_line: start,
      end_line: actualEnd,
      total_lines: allLines.length,
      lines: chunk,
      content: chunk.join("\n"),
      hint:
        `To patch this file: use contextforge_patch_ast with ` +
        `search_string set to one of these lines and file_path="${filePath}". ` +
        `To retrieve from vault: contextforge_retrieve with search_query="${searchHint}".`,
    };

    return JSON.stringify(result, null, 2);
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

  for (const tool of currentTools) {
    const name = tool.name || tool.function?.name;
    if (name === READ_FILE_CHUNK_TOOL_NAME) {
      return currentTools;
    }
  }

  if (!_readFileChunkInjectedOnce) {
//     console.log(`[ReadFileChunk] ✅ Tool injected`);
    _readFileChunkInjectedOnce = true;
  }

  return [...currentTools, getReadFileChunkToolDefinition()];
}

// ─────────────────────────────────────────────
// Grep a source file for function call sites.
// Used as fallback when source_line is not yet
// populated in the edges table (files indexed
// before the source_line migration).
// ─────────────────────────────────────────────

function findCallLineInFile(filePath, functionName) {
  const lines = readFileLines(filePath);
  if (!lines) return null;

  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const callRegex = new RegExp(`\\b${escaped}\\s*\\(`);

  for (let i = 0; i < lines.length; i++) {
    if (callRegex.test(lines[i])) {
      return i + 1; // 1-indexed line number
    }
  }
  return null;
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
          calls: item.calls || [],
          literalRefs: item.literalRefs || [],
          envRefs: item.envRefs || [],
        };
        // Cap body if present
        if (item.body) entry.body = capBodyText(item.body, item.name);
        output.push(entry);
      } else if (item.type === "route") {
        output.push({
          type: "route",
          route: item.route,
          file: item.file,
          line: item.line,
          handler: item.handler,
        });
      } else if (item.type === "literal" || item.type === "env_var") {
        output.push({
          type: item.type,
          value: item.value || item.key,
          file: item.file,
          line: item.line,
          usedIn: item.usedIn,
          containing_function: item.containing_function || undefined,
        });
      } else if (item.body) {
        // function_body items
        output.push({
          type: "function_body",
          name: item.name,
          file: item.file,
          startLine: item.startLine,
          endLine: item.endLine,
          body: capBodyText(item.body, item.name),
        });
      }
    }
  }
  return output;
}
