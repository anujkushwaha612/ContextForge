/**
 * graphTools.js
 *
 * Tool definition and query handler for contextforge_query_graph.
 *
 * Injected into the tools[] array alongside memory tools.
 * Intercepted by the Ghost Interceptor in server.js.
 *
 * Query types:
 *   who_imports_this    → which files import symbol X
 *   what_does_this_export → what symbols does file X export
 *   find_symbol         → where is symbol X defined
 *   what_does_this_import → what does file X import
 *   who_depends_on_file → which files depend on file X
 */

import {
  queryWhoImportsThis,
  queryWhatDoesThisExport,
  queryFindSymbol,
  queryWhatDoesThisImport,
  queryWhoDependsOnFile,
  getGraphStats,
} from "./graphDb.js";
import { statsEmitter } from "../proxy/statsEmitter.js";

export const GRAPH_TOOL_NAME = "contextforge_query_graph";

// MCP protocol prefixes the tool name — normalize before matching
const GRAPH_TOOL_ALIASES = new Set([
  GRAPH_TOOL_NAME,
  `mcp__contextforge__${GRAPH_TOOL_NAME}`,
  `contextforge__${GRAPH_TOOL_NAME}`,
]);

/**
 * Normalize any variant of the graph tool name back to the canonical name.
 * Handles MCP namespace prefixes transparently.
 */
export function normalizeGraphToolName(name) {
  if (!name) return name;
  // Strip any mcp__ or namespace__ prefix patterns
  // e.g. mcp__contextforge__contextforge_query_graph → contextforge_query_graph
  const match = name.match(
    /(?:mcp__\w+__|[\w]+__)?(contextforge_query_graph)$/,
  );
  return match ? match[1] : name;
}

// ─────────────────────────────────────────────
// Tool definition (OpenAI format — post-translation)
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
        "ALWAYS use this tool INSTEAD of grep, find, bash search, or reading files " +
        "when you need to locate a symbol, find imports, or check exports. " +
        "This is pre-indexed and returns results instantly at zero token cost. " +
        "Use find_symbol to locate any function, class, or variable by name. " +
        "Use who_imports_this to find all files that use a symbol. " +
        "Use what_does_this_export to list a file's exports without reading it. " +
        "Always try this before reading any file.",
      parameters: {
        type: "object",
        properties: {
          query_type: {
            type: "string",
            enum: [
              "who_imports_this",
              "what_does_this_export",
              "find_symbol",
              "what_does_this_import",
              "who_depends_on_file",
            ],
            description:
              "who_imports_this: find all files that import a symbol. " +
              "what_does_this_export: list all exports from a file. " +
              "find_symbol: locate where a symbol is defined. " +
              "what_does_this_import: list all imports in a file. " +
              "who_depends_on_file: find files that import from a specific file.",
          },
          target: {
            type: "string",
            description:
              "The symbol name (e.g. 'sliceJsonOutput') or file path " +
              "(e.g. 'src/helper.js') depending on query_type.",
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
// Query executor — called by Ghost Interceptor
// ─────────────────────────────────────────────

/**
 * Execute a graph query and return a formatted string result.
 * The string is injected as the tool result content.
 *
 * @param {string} queryType
 * @param {string} target
 * @returns {string} JSON result formatted for LLM consumption
 */
export function executeGraphQuery(queryType, target) {
  if (!target || typeof target !== "string") {
    return JSON.stringify({ error: "target is required" });
  }

  const cleanTarget = target.trim();

  try {
    let result;

    switch (queryType) {
      case "who_imports_this": {
        const rows = queryWhoImportsThis(cleanTarget);
        if (rows.length === 0) {
          result = JSON.stringify({
            symbol: cleanTarget,
            result: "not_found",
            message:
              `No files import '${cleanTarget}'. ` +
              `It may be internal-only or not yet indexed.`,
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
          2,
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
              `No exports found for '${cleanTarget}'. ` +
              `Check the file path or run a graph re-index.`,
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
          },
          null,
          2,
        );
        break;
      }

      case "find_symbol": {
        const rows = queryFindSymbol(cleanTarget);
        if (rows.length === 0) {
          result = JSON.stringify({
            symbol: cleanTarget,
            result: "not_found",
            message: `Symbol '${cleanTarget}' not found in the graph index.`,
          });
          break;
        }
        result = JSON.stringify(
          {
            symbol: cleanTarget,
            definitions: rows.map((r) => ({
              file: r.file_path,
              kind: r.kind,
              start_line: r.start_line,
              end_line: r.end_line,
              complexity: r.complexity,
              body: r.body_text || null,
            })),
            count: rows.length,
          },
          null,
          2,
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
          2,
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
          2,
        );
        break;
      }

      default:
        result = JSON.stringify({
          error: "unknown_query_type",
          query_type: queryType,
          valid_types: [
            "who_imports_this",
            "what_does_this_export",
            "find_symbol",
            "what_does_this_import",
            "who_depends_on_file",
          ],
        });
    }

    // ── Dashboard hook — fires after every successful query ──
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

/**
 * Check if a tool call is a graph query.
 * Used by the Ghost Interceptor to route the call.
 */
export function isGraphToolCall(toolName) {
  return (
    GRAPH_TOOL_ALIASES.has(toolName) ||
    normalizeGraphToolName(toolName) === GRAPH_TOOL_NAME
  );
}

/**
 * Inject the graph tool into a tools array.
 * Injects unconditionally if graph has been initialized,
 * even if indexing is still in progress.
 */
export function injectGraphTool(tools) {
  const currentTools = tools || [];

  // Check if already present
  for (const tool of currentTools) {
    const name = tool.name || tool.function?.name;
    if (name === GRAPH_TOOL_NAME) {
      console.log(`[GraphInject] Already present — skipping`);
      return currentTools;
    }
  }

  // Inject regardless of node count — indexing may still be in progress
  // The LLM will get a "not yet indexed" response from executeGraphQuery
  // if it calls before indexing completes, which is better than no tool at all
  try {
    const stats = getGraphStats();
    const nodeCount = stats?.node_count ?? 0;
    console.log(
      `[GraphInject] ✅ Injecting graph tool (nodes: ${nodeCount}, ` +
        `indexing: ${nodeCount === 0 ? "in progress" : "complete"})`,
    );
  } catch (err) {
    // graphDb not initialized yet — inject anyway, queries will return
    // friendly "not indexed" messages rather than crashing
    console.log(
      `[GraphInject] ⚠️  graphDb not ready (${err.message}) — injecting with warning`,
    );
  }

  return [...currentTools, getGraphToolDefinition()];
}
