/**
 * patchTools.js
 *
 * Tool definition, injection, and dispatch for contextforge_patch_ast.
 * Mirrors the structure of graphTools.js exactly.
 *
 * Intercepted by the Ghost Interceptor in server.js.
 * The LLM calls this instead of outputting an entire file rewrite.
 */

import { executePatch, PATCH_OPERATIONS } from "./patchEngine.js";
import { statsEmitter } from "../proxy/statsEmitter.js";

export const PATCH_TOOL_NAME = "contextforge_patch_ast";

// MCP namespace variants
const PATCH_TOOL_ALIASES = new Set([
  PATCH_TOOL_NAME,
  `mcp__contextforge__${PATCH_TOOL_NAME}`,
  `contextforge__${PATCH_TOOL_NAME}`,
]);

// ─────────────────────────────────────────────
// Tool definition (OpenAI format)
// ─────────────────────────────────────────────

let _toolDef = null;

export function getPatchToolDefinition() {
  if (_toolDef) return _toolDef;

  _toolDef = {
    type: "function",
    function: {
      name: PATCH_TOOL_NAME,
      description:
        "Apply a surgical patch to a source file. " +
        "MANDATORY WORKFLOW — follow this sequence exactly: " +
        "Step 1: call contextforge_query_graph(find_symbol, 'functionName') to get location and first 100 lines. " +
        "Step 2: if body shows '// ... N more lines' truncation note, call contextforge_retrieve(vault_id, search_query:'functionName') to get JUST that function — not the whole file. " +
        "Step 3: call this tool with the complete body from step 1 or 2. " +
        "For adding a single line (e.g. console.log), use insert_after — no retrieve needed. " +
        "Never call replace_body without the complete current body confirmed in hand.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "Relative path to the file to patch (e.g. 'src/helper.js'). " +
              "Must match the path shown by find_symbol.",
          },
          target_symbol: {
            type: "string",
            description:
              "The exact declared name of the function, class, or const to target " +
              "(e.g. 'interceptAndVaultMassiveToolResults'). " +
              "Must match the symbol name exactly as it appears in the source.",
          },
          new_body: {
            type: "string",
            description:
              "Complete replacement — every line from declaration to closing brace. " +
              "If find_symbol showed a truncation note ('// ... N more lines'), " +
              "you MUST call contextforge_retrieve(vault_id, search_query:target_symbol) first " +
              "to get the full body. retrieve returns JUST the function (~400-600 tokens), " +
              "not the whole file. Never write this field from a truncated body.",
          },
          operation: {
            type: "string",
            enum: ["replace_body", "insert_after", "insert_before", "delete"],
            description:
              "replace_body: replaces entire symbol — requires reading complete body first. " +
              "insert_after: adds code after symbol — safe WITHOUT reading body first. " +
              "insert_before: adds code before symbol — safe WITHOUT reading body first. " +
              "delete: removes symbol entirely — safe WITHOUT reading body first. " +
              "For adding a single line like console.log, prefer insert_after.",
          },
        },
        required: ["file_path", "target_symbol", "operation"],
        additionalProperties: false,
      },
    },
  };

  return _toolDef;
}

// ─────────────────────────────────────────────
// Ghost Interceptor helpers
// ─────────────────────────────────────────────

/**
 * Check if a tool call is a patch operation.
 * Used by the Ghost Interceptor to route.
 */
export function isPatchToolCall(toolName) {
  if (!toolName) return false;
  return (
    PATCH_TOOL_ALIASES.has(toolName) ||
    normalizePatchToolName(toolName) === PATCH_TOOL_NAME
  );
}

export function normalizePatchToolName(name) {
  if (!name) return name;
  const match = name.match(/(?:mcp__\w+__|[\w]+__)?(contextforge_patch_ast)$/);
  return match ? match[1] : name;
}

/**
 * Execute a patch tool call.
 * Called by the Ghost Interceptor after parsing detectedToolArgs.
 *
 * @param {string} toolArgsJson    — raw JSON string from LLM tool call
 * @param {object} semanticCache   — passed through for vault invalidation
 * @returns {string}               — result formatted as tool message content
 */
export async function executePatchToolCall(toolArgsJson, semanticCache = null) {
  let args;
  try {
    args = JSON.parse(toolArgsJson);
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Invalid JSON arguments: ${err.message}`,
    });
  }

  if (!args.file_path || !args.target_symbol || !args.operation) {
    return JSON.stringify({
      success: false,
      error: "Required fields missing: file_path, target_symbol, operation",
    });
  }

  const result = await executePatch({
    file_path: args.file_path,
    target_symbol: args.target_symbol,
    new_body: args.new_body || "",
    operation: args.operation,
    semanticCache,
  });

  // Dashboard hook
  statsEmitter.recordPatchOperation?.({
    file: args.file_path,
    symbol: args.target_symbol,
    operation: args.operation,
    success: result.success,
  });

  console.log(
    result.success
      ? `[PatchTool] ✅ ${args.operation}('${args.target_symbol}') in ${args.file_path} — ${result.diff_summary}`
      : `[PatchTool] ❌ ${args.operation}('${args.target_symbol}') failed: ${result.error}`,
  );

  return JSON.stringify(result, null, 2);
}

// ─────────────────────────────────────────────
// Tool injection
// ─────────────────────────────────────────────

/**
 * Inject the patch tool into a tools array.
 * Called in the pipeline alongside injectGraphTool.
 */
export function injectPatchTool(tools) {
  const currentTools = tools || [];

  for (const tool of currentTools) {
    const name = tool.name || tool.function?.name;
    if (name === PATCH_TOOL_NAME) {
      return currentTools; // already present
    }
  }

  return [...currentTools, getPatchToolDefinition()];
}
