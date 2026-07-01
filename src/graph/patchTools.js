/**
 * patchTools.js
 *
 * Fixes applied:
 *   PT-1: Verification reads now use result.file (the resolved absolute path
 *         returned by executePatch) instead of raw args.file_path. Previously
 *         the LLM-provided relative/absolute path was passed to executeReadFileChunk
 *         which could resolve to a different location than where the patch was written.
 *
 *   PT-2: successDetail guard added — was undefined on failure path causing
 *         "[PatchTool] ❌ operation failed: undefined" in logs.
 *
 *   GT-4: Verification snippet is now parsed and checked for error before
 *         embedding in verified_state.content. Previously an error JSON string
 *         like {"error":"File not found"} was sent to the LLM as the "verified
 *         current file state", causing wrong decisions on next turn.
 */

import { executePatch, PATCH_OPERATIONS } from "./patchEngine.js";
import { statsEmitter } from "../proxy/statsEmitter.js";

export const PATCH_TOOL_NAME = "contextforge_patch_ast";

const PATCH_TOOL_ALIASES = new Set([
  PATCH_TOOL_NAME,
  `mcp__contextforge__${PATCH_TOOL_NAME}`,
  `contextforge__${PATCH_TOOL_NAME}`,
]);

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
            ],
            description:
              "replace_body: replaces entire symbol — requires reading complete body first via read_function. " +
              "insert_after: adds code after symbol — safe WITHOUT reading body first. " +
              "insert_before: adds code before symbol — safe WITHOUT reading body first. " +
              "delete: removes symbol entirely — safe WITHOUT reading body first. " +
              "replace_string: surgical find-and-replace INSIDE a symbol (or globally if target_symbol omitted). " +
              "insert_at_line: inserts new_body at a specific 1-based line number — " +
              "use this when find_route gives you a line number for an anonymous handler. " +
              "No target_symbol needed.",
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
    file_path:          args.file_path,
    target_symbol:      args.target_symbol || null,
    new_body:           args.new_body || "",
    operation:          args.operation,
    search_string:      args.search_string      ?? null,
    replacement_string: args.replacement_string ?? null,
    insert_line:        args.insert_line        ?? null,
    semanticCache,
  });

  statsEmitter.recordPatchOperation?.({
    file:      args.file_path,
    symbol:    args.target_symbol || "GLOBAL",
    operation: args.operation,
    success:   result.success,
  });

  // PT-2: Guard successDetail so failures don't log "undefined"
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
      ? `[PatchTool] ✅ ${args.operation}('${args.target_symbol || "GLOBAL"}') in ${args.file_path} — ${successDetail}`
      : `[PatchTool] ❌ ${args.operation}('${args.target_symbol || "GLOBAL"}') failed: ${result.error?.slice(0, 120)}`,
  );

  // ── Automatic verification snapshot ──────────────────────────────────────
  // On success, read back the patched region and embed it in the response.
  // This prevents the LLM from issuing a second patch on already-modified
  // content because it can SEE the current file state without another read.
  if (result.success) {
    const verifyLine =
      result.patch_start_line ??
      result.insert_line      ??
      result.lines_before     ??
      null;

    if (verifyLine != null) {
      try {
        // PT-1: Use result.file (resolved absolute path from executePatch)
        // NOT args.file_path (raw LLM-provided path, may be relative or
        // point to a different location than where the write actually happened).
        const { executeReadFileChunk } = await import("./graphTools.js");

        const verifyStart = Math.max(1, verifyLine - 2);
        const verifyEnd   =
          (result.patch_end_line ?? result.lines_after ?? verifyLine) + 4;

        const snippetRaw = executeReadFileChunk(result.file, verifyStart, verifyEnd);

        // GT-4: Parse the snippet and check for error before embedding.
        // executeReadFileChunk returns a JSON string — if it contains an error
        // (file not found, bad range) that error JSON would be sent to the LLM
        // as the "verified current state", causing wrong decisions.
        let snippetContent = null;
        try {
          const snippetParsed = JSON.parse(snippetRaw);
          if (snippetParsed.error) {
            // Read failed — don't embed error as file content
            snippetContent = null;
          } else {
            // Use the content field (joined lines) not the raw JSON
            snippetContent = snippetParsed.content ?? null;
          }
        } catch {
          // JSON parse failed — use raw string as fallback
          snippetContent = snippetRaw;
        }

        if (snippetContent !== null) {
          result.verified_state = {
            message: "Patch applied and verified. File now contains:",
            lines:   `${verifyStart}-${verifyEnd}`,
            content: snippetContent,
            WARNING:
              "The original search_string no longer exists in this form. " +
              "Do NOT retry this patch. If further edits are needed, " +
              "use the content above as your new reference.",
          };
        } else {
          result.verified_state = {
            message: "Patch applied successfully.",
            WARNING:
              "Do NOT retry this patch. Use read_file_chunk to verify current state.",
          };
        }
      } catch {
        result.verified_state = {
          message: "Patch applied successfully.",
          WARNING:
            "Do NOT retry this patch. Use read_file_chunk to verify current state.",
        };
      }
    } else {
      result.verified_state = {
        message: "Patch applied successfully.",
        WARNING:
          "Do NOT retry this patch. Use read_file_chunk to verify current state.",
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