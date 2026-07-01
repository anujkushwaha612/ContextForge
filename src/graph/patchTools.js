/**
 * patchTools.js
 *
 * Fixes applied (original):
 *   PT-1: result.file used for verification reads.
 *   PT-2: successDetail guard added.
 *   GT-4: Verification snippet parsed and error-checked.
 *
 * Fixes applied (this pass):
 *   PT-1: executeReadFileChunk converted from dynamic import() to static
 *         import at module top. Dynamic import() in the hot path created
 *         a Promise + microtask overhead on every successful patch even
 *         though the module was already in the cache.
 *
 *   PT-3: Verification snippet capped at 30 lines. Previously unbounded —
 *         a replace_body on a 100-line function embedded the full 100+ line
 *         verified_state in the response, injecting those tokens into every
 *         subsequent turn's conversation history.
 *
 *   PT-4: statsEmitter.recordPatchOperation replaced with
 *         statsEmitter.recordAgentAction("astPatches") — the actual method
 *         that exists on statsEmitter. recordPatchOperation was silently
 *         no-op'd by the ?. operator since the method doesn't exist.
 */

import { executePatch, PATCH_OPERATIONS } from "./patchEngine.js";
import { statsEmitter } from "../proxy/statsEmitter.js";

// PT-1 FIX: Static import instead of dynamic import() inside hot path.
// Module is already loaded by the time any patch succeeds.
// Dynamic import() still hits the cache but creates a Promise and goes
// through the microtask queue on every call — unnecessary overhead.
import { executeReadFileChunk } from "./graphTools.js";

export const PATCH_TOOL_NAME = "contextforge_patch_ast";

const PATCH_TOOL_ALIASES = new Set([
  PATCH_TOOL_NAME,
  `mcp__contextforge__${PATCH_TOOL_NAME}`,
  `contextforge__${PATCH_TOOL_NAME}`,
]);

// PT-3: Maximum lines in the verification snippet embedded in the response.
// Keeps verified_state small so it doesn't inflate subsequent turns.
const MAX_VERIFY_LINES = 30;

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
        "Step 1: call contextforge_query_graph(find_symbol, 'functionName') to get location (file + line numbers). " +
        "Step 2: call contextforge_query_graph(read_function, 'functionName') to get the full body. " +
        "Step 3: call this tool with the complete body from step 2. " +
        "\n\nFor adding a single line (e.g. console.log), use insert_after — no read needed. " +
        "For changing one line INSIDE a function, use replace_string — no full read needed. " +
        "For anonymous handlers (SSE routes, http.createServer blocks) where find_route returns a line number, " +
        "use insert_at_line with the line number — no symbol or read needed. " +
        "Never call replace_body without the complete current body confirmed in hand.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "Relative path to the file to patch (e.g. 'src/helper.js'). " +
              "Must match the path shown by find_symbol or find_route.",
          },
          target_symbol: {
            type: "string",
            description:
              "Optional. Omit for global scope, anonymous callbacks, or when using insert_at_line. " +
              "If provided, the exact declared name of the function, class, or const to target. " +
              "CRITICAL: If modifying a function CALL, do NOT use the callee's name as target_symbol. " +
              "Instead, omit target_symbol so the entire file is searched.",
          },
          new_body: {
            type: "string",
            description:
              "Complete replacement — every line from declaration to closing brace. " +
              "You MUST call read_function first to get the full body before using replace_body. " +
              "Not required for replace_string or delete operations.",
          },
          operation: {
            type: "string",
            enum: [
              "replace_body",
              "insert_after",
              "insert_before",
              "delete_node",
              "replace_string",
              "insert_at_line",
              "create_file",
            ],
            description:
              "replace_body: replaces entire symbol — requires reading complete body first via read_function. " +
              "insert_after: adds code after symbol — safe WITHOUT reading body first. " +
              "insert_before: adds code before symbol — safe WITHOUT reading body first. " +
              "delete: removes symbol entirely — safe WITHOUT reading body first. " +
              "replace_string: surgical find-and-replace INSIDE a symbol (or globally if target_symbol omitted). " +
              "insert_at_line: inserts new_body at a specific 1-based line number — " +
              "use this when find_route gives you a line number for an anonymous handler. " +
              "No target_symbol needed. " +
              "create_file: creates a new file with content from new_body. " +
              "Fails if file already exists. Creates parent directories automatically. " +
              "Use this instead of the native Write tool for new files.",
          },
          search_string: {
            type: "string",
            description:
              "replace_string only. The exact string to find inside target_symbol's body " +
              "(or the entire file if target_symbol is omitted). " +
              "Must be unique. Matched literally, not as a regex. Copy verbatim from source. " +
              "If the proxy returns a 'Did you mean?' error with <exact_match> tags, " +
              "use that exact text as your next search_string.",
          },
          replacement_string: {
            type: "string",
            description:
              "replace_string only. The string to substitute in place of search_string. " +
              'May be empty string "" to delete the matched text.',
          },
          insert_line: {
            type: "integer",
            description:
              "insert_at_line only. The 1-based line number to insert new_body before. " +
              "Line 1 = before the first line. Use the line number from find_route results. " +
              "The new content is inserted BEFORE this line (existing content shifts down).",
          },
        },
        required: ["file_path", "operation"],
        additionalProperties: false,
      },
    },
  };

  return _toolDef;
}

export function isPatchToolCall(toolName) {
  if (!toolName) return false;
  return PATCH_TOOL_ALIASES.has(toolName) || normalizePatchToolName(toolName) === PATCH_TOOL_NAME;
}

export function normalizePatchToolName(name) {
  if (!name) return name;
  const match = name.match(/(?:mcp__\w+__|[\w]+__)?(contextforge_patch_ast)$/);
  return match ? match[1] : name;
}

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

  if (!args.file_path || !args.operation) {
    return JSON.stringify({
      success: false,
      error: "Required fields missing: file_path, operation",
    });
  }

  const result = await executePatch({
    file_path: args.file_path,
    target_symbol: args.target_symbol || null,
    new_body: args.new_body || "",
    operation: args.operation,
    search_string: args.search_string ?? null,
    replacement_string: args.replacement_string ?? null,
    insert_line: args.insert_line ?? null,
    semanticCache,
  });

  // PT-4 FIX: Use recordAgentAction("astPatches") — the actual method that
  // exists on statsEmitter. recordPatchOperation doesn't exist and was
  // silently skipped by the ?. operator, making patch telemetry a no-op.
  if (result.success) {
    statsEmitter.recordAgentAction?.("astPatches");
  }

  // PT-2: Guard successDetail — was undefined on failure path
  let successDetail = "";
  if (result.success) {
    if (args.operation === "replace_string") {
      successDetail = `${result.lines_changed ?? 0} line(s) changed`;
    } else if (args.operation === "insert_at_line") {
      successDetail = `${result.lines_inserted ?? 0} line(s) inserted at line ${args.insert_line}`;
    } else {
      successDetail = result.diff_summary ?? "applied";
    }
  }

  console.log(
    result.success
      ? `[PatchTool] ✅ ${args.operation}('${args.target_symbol || "GLOBAL"}') ` +
          `in ${args.file_path} — ${successDetail}`
      : `[PatchTool] ❌ ${args.operation}('${args.target_symbol || "GLOBAL"}') ` +
          `failed: ${result.error?.slice(0, 120)}`
  );

  // ── Automatic verification snapshot ──────────────────────────────────────
  if (result.success) {
    const verifyLine = result.patch_start_line ?? result.insert_line ?? result.lines_before ?? null;

    if (verifyLine != null) {
      try {
        const verifyStart = Math.max(1, verifyLine - 2);
        const rawVerifyEnd = (result.patch_end_line ?? result.lines_after ?? verifyLine) + 4;

        // PT-3 FIX: Cap verification snippet at MAX_VERIFY_LINES (30).
        // Previously unbounded — replace_body on a 100-line function embedded
        // the full function + 4 lines in verified_state, injecting 100+ tokens
        // into every subsequent turn's conversation history.
        const verifyEnd = Math.min(rawVerifyEnd, verifyStart + MAX_VERIFY_LINES - 1);

        // PT-1 FIX: Static import at module top — no dynamic import() here
        const snippetRaw = executeReadFileChunk(result.file, verifyStart, verifyEnd);

        // GT-4: Parse and error-check before embedding
        let snippetContent = null;
        try {
          const snippetParsed = JSON.parse(snippetRaw);
          if (snippetParsed.error) {
            snippetContent = null;
          } else {
            snippetContent = snippetParsed.content ?? null;
          }
        } catch {
          snippetContent = snippetRaw;
        }

        if (snippetContent !== null) {
          result.verified_state = {
            message: "Patch applied and verified. File now contains:",
            lines: `${verifyStart}-${verifyEnd}`,
            content: snippetContent,
            WARNING:
              "PATCH ALREADY APPLIED. The original search_string no longer exists — " +
              "this is proof the edit succeeded. Do NOT call this tool again with the " +
              "same arguments. If you need to make further changes, call " +
              "read_file_chunk first to get the current file state, then issue " +
              "a new patch based on what you see.",
          };
        } else {
          result.verified_state = {
            message: "Patch applied successfully.",
            WARNING: "Do NOT retry this patch. Use read_file_chunk to verify current state.",
          };
        }
      } catch {
        result.verified_state = {
          message: "Patch applied successfully.",
          WARNING: "Do NOT retry this patch. Use read_file_chunk to verify current state.",
        };
      }
    } else {
      result.verified_state = {
        message: "Patch applied successfully.",
        WARNING: "Do NOT retry this patch. Use read_file_chunk to verify current state.",
      };
    }
  }

  return JSON.stringify(result, null, 2);
}

let _patchInjectedOnce = false;

export function injectPatchTool(tools) {
  const currentTools = tools || [];

  for (const tool of currentTools) {
    const name = tool.name || tool.function?.name;
    if (name === PATCH_TOOL_NAME) return currentTools;
  }

  if (!_patchInjectedOnce) {
    console.log(`[PatchInject] ✅ Patch tool active`);
    _patchInjectedOnce = true;
  }

  return [...currentTools, getPatchToolDefinition()];
}
