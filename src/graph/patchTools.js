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
        "Never call replace_body without the complete current body confirmed in hand. " +
        "\n\nRESULTS ARE SELF-VERIFYING: every successful patch returns a `diff` field " +
        "showing the exact change applied to disk. Trust the diff — do NOT re-read " +
        "the file just to confirm a patch worked. Only read again if you need " +
        "surrounding context for a further edit.",
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
              // PT-5 FIX: was "delete_node" — patchEngine.js's PATCH_OPERATIONS.DELETE
              // is the string "delete". Any LLM that read this enum and passed
              // "delete_node" (exactly as instructed) was rejected outright by
              // patchEngine's `Object.values(PATCH_OPERATIONS).includes(operation)`
              // validation gate before the delete logic ever ran — the delete
              // capability was unreachable end-to-end for schema-honoring callers.
              "delete",
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

// ─────────────────────────────────────────────
// F5: self-verifying patch results.
//
// Session evidence (S3-refactor runs): the model spent 3-6 requests
// re-reading files after every successful patch because the result was an
// assertion ("3 line(s) changed") with no evidence. A ~60-token unified
// diff in the result replaces a 500-2000 token read_file_chunk round-trip.
// ─────────────────────────────────────────────

const MAX_DIFF_LINES = 40;

/**
 * Compact unified diff between the old and new text of the patched region.
 * Trims common prefix/suffix lines so only the true change (plus one line
 * of context each side) is shown. Exact for contiguous patch regions
 * (replace_string / replace_body / insert), which is all we produce.
 */
function buildUnifiedDiff(oldText, newText, { filePath, startLine }) {
  if (typeof oldText !== "string" || typeof newText !== "string") return null;
  // "" means "nothing" (pure insert/delete) — not a single empty line
  const oldLines = oldText === "" ? [] : oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines = newText === "" ? [] : newText.replace(/\r\n/g, "\n").split("\n");

  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let sufOld = oldLines.length - 1;
  let sufNew = newLines.length - 1;
  while (sufOld >= pre && sufNew >= pre && oldLines[sufOld] === newLines[sufNew]) {
    sufOld--;
    sufNew--;
  }

  const removed = oldLines.slice(pre, sufOld + 1);
  const added = newLines.slice(pre, sufNew + 1);
  if (removed.length === 0 && added.length === 0) return null; // no-op

  const ctxBefore = pre > 0 ? [` ${oldLines[pre - 1]}`] : [];
  const ctxAfter = sufOld + 1 < oldLines.length ? [` ${oldLines[sufOld + 1]}`] : [];

  const hunkStart = (startLine ?? 0) + pre;
  const lines = [
    `@@ ${filePath} line ~${hunkStart + 1} @@`,
    ...ctxBefore,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...ctxAfter,
  ];

  if (lines.length > MAX_DIFF_LINES) {
    const kept = lines.slice(0, MAX_DIFF_LINES);
    kept.push(`… diff truncated (${lines.length - MAX_DIFF_LINES} more lines)`);
    return kept.join("\n");
  }
  return lines.join("\n");
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

  // ── F5: embed a unified diff — the evidence that makes re-reads redundant ─
  if (result.success) {
    let oldText = null;
    let newText = null;
    if (args.operation === "replace_string") {
      oldText = args.search_string ?? "";
      newText = args.replacement_string ?? "";
    } else if (
      args.operation === "insert_after" ||
      args.operation === "insert_before" ||
      args.operation === "insert_at_line" ||
      args.operation === "create_file"
    ) {
      oldText = "";
      newText = args.new_body ?? "";
    } else if (args.operation === PATCH_OPERATIONS.DELETE) {
      // PT-5 FIX: was checking "delete_symbol" / "delete_string" — neither
      // ever matched the engine's real operation name ("delete"), so this
      // branch was dead code; successful deletes never got a diff, only
      // the (much larger) verified_state fallback snippet below.
      oldText = args.search_string ?? args.new_body ?? "";
      newText = "";
    }
    // replace_body intentionally skipped: old body unknown here; the
    // verified_state snippet below already shows the resulting file state.

    if (oldText !== null) {
      const diff = buildUnifiedDiff(oldText, newText, {
        filePath: result.file ?? args.file_path,
        startLine: result.patch_start_line ?? null,
      });
      if (diff) {
        result.diff = diff;
        result.diff_note =
          "This diff is what was applied to the file on disk. " +
          "It is authoritative — no re-read is needed to verify this change.";
      }
    }
  }

  // ── Automatic verification snapshot ──────────────────────────────────────
  // F5: when a diff is present it already proves the change — the snippet
  // would repeat the same lines and double the token cost. Snapshot only
  // runs for operations without a diff (e.g. replace_body).
  if (result.success && result.diff) {
    result.verified_state = {
      message: "Patch applied. See `diff` above for the exact change.",
      WARNING:
        "PATCH ALREADY APPLIED — do NOT retry this patch and do NOT re-read " +
        "the file to verify; the diff is authoritative. Only read again if " +
        "you need context beyond the changed lines.",
    };
  } else if (result.success) {
    let verifyLine = null;
    let patchEnd = null;

    if (result.patch_start_line != null) {
      verifyLine = result.patch_start_line + 1;
      patchEnd = (result.patch_end_line ?? result.patch_start_line) + 1;
    } else if (result.lines_before != null) {
      verifyLine = result.lines_before + 1;
      patchEnd = (result.lines_after ?? result.lines_before) + 1;
    } else if (result.insert_line != null) {
      verifyLine = result.insert_line;
      patchEnd = result.insert_line;
    }

    if (verifyLine != null) {
      try {
        const verifyStart = Math.max(1, verifyLine - 2);
        const rawVerifyEnd = patchEnd + 4;

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

  // RQ-7 FIX: same class of bug as injectGraphTool in graphTools.js —
  // bare-name-only comparison missed an MCP-discovered alias already
  // present (mcp__contextforge__contextforge_patch_ast). isPatchToolCall()
  // already checks PATCH_TOOL_ALIASES (bare name + both MCP prefix forms).
  for (const tool of currentTools) {
    const name = tool.name || tool.function?.name;
    if (isPatchToolCall(name)) return currentTools;
  }

  if (!_patchInjectedOnce) {
    console.log(`[PatchInject] ✅ Patch tool active`);
    _patchInjectedOnce = true;
  }

  return [...currentTools, getPatchToolDefinition()];
}
