import { classifyContentAsync } from "./contentDetector.js";

// ============================================================
// PHASE 1, FEATURE 1: NATIVE TERMINAL SCRUBBER (RTK Replacement)
// ============================================================

const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;
const OSC_PATTERN = /\x1b\][^\x07]*\x07/g;
const SINGLE_ESC = /\x1b[()][0-9a-zA-Z]/g;

const SPINNER_LINE_PATTERN = /^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷#=\-|/\\%.\d(){}\]\[∧>]+$/;
const NPM_PROGRESS_PATTERN = /^\[[#=\-.\s]{8,}\]\s+\d+%.*/;

// ─────────────────────────────────────────────
// Shell tool detection
//
// Bash, PowerShell, and other shell tools must never be deduped
// or vaulted. Their results contain directory listings, command
// output, and file trees that must always reach the LLM fresh.
//
// Stale shell output causes the LLM to believe files don't exist
// when they do — leading to not_found cascades and wasted hops.
//
// Uses exact Set lookup instead of .includes() to avoid
// false-positives on MCP tools like "executeGraphQuery" or
// "executePatchToolCall" which contain "execute".
// ─────────────────────────────────────────────

export const SHELL_TOOL_NAMES = new Set([
  "bash",
  "powershell",
  "zsh",
  "sh",
  "terminal",
  "shell",
  "cmd",
  "command",
]);

export function isShellToolResult(msg) {
  // Primary: _toolName set by tagToolResults metadata backfill
  if (msg._toolName && SHELL_TOOL_NAMES.has(msg._toolName.toLowerCase())) {
    return true;
  }
  // Secondary: tool name on the message itself (set by ghost interceptor)
  if (msg.name && SHELL_TOOL_NAMES.has(msg.name.toLowerCase())) {
    return true;
  }
  // Tertiary: explicit flag set during tagging (most reliable on re-runs)
  if (msg._isShellTool === true) {
    return true;
  }
  return false;
}

function collapseCarriageReturnProgress(text) {
  const lines = text.split("\n");
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.includes("\r")) {
      const segments = line.split("\r").filter((s) => s.length > 0);
      if (segments.length > 1) {
        const lastSegment = segments[segments.length - 1].trim();
        if (lastSegment) result.push(lastSegment);
        i++;
        continue;
      }
    }

    if (line.trim().length > 0 && (NPM_PROGRESS_PATTERN.test(line) || SPINNER_LINE_PATTERN.test(line))) {
      let j = i + 1;
      while (
        j < lines.length &&
        lines[j].trim().length > 0 &&
        (NPM_PROGRESS_PATTERN.test(lines[j]) || SPINNER_LINE_PATTERN.test(lines[j]))
      ) {
        j++;
      }

      const consecutiveProgressLines = j - i;
      if (consecutiveProgressLines > 2) {
        const lastProgress = lines[j - 1].trim();
        if (lastProgress && !SPINNER_LINE_PATTERN.test(lastProgress)) {
          result.push(
            lastProgress + `  [${consecutiveProgressLines - 1} progress lines collapsed]`
          );
        }
        i = j;
        continue;
      }
    }

    result.push(line);
    i++;
  }

  return result.join("\n");
}

export function scrubTerminalOutput(text) {
  if (typeof text !== "string" || text.length === 0) return text;

  let cleaned = text;

  cleaned = cleaned.replace(ANSI_PATTERN, "");
  cleaned = cleaned.replace(OSC_PATTERN, "");
  cleaned = cleaned.replace(SINGLE_ESC, "");

  cleaned = collapseCarriageReturnProgress(cleaned);

  cleaned = cleaned
    .split("\n")
    .filter((line) => !/^\s*npm\s+(verb|sill|timing|notice\s+http)/i.test(line))
    .join("\n");

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  cleaned = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

  return cleaned.trim();
}

export function scrubToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  payload.messages = payload.messages.map((msg) => {
    if (msg.role === "tool" && typeof msg.content === "string") {
      const scrubbed = scrubTerminalOutput(msg.content);

      if (scrubbed !== msg.content) {
        const savedChars = msg.content.length - scrubbed.length;
        return {
          ...msg,
          content: scrubbed,
          _scrubbedChars: savedChars,
        };
      }
      return msg;
    }

    if (msg.role === "user" && Array.isArray(msg.content)) {
      let modified = false;
      const newContent = msg.content.map((block) => {
        if (block.type === "tool_result" && typeof block.content === "string") {
          const scrubbed = scrubTerminalOutput(block.content);
          if (scrubbed !== block.content) {
            modified = true;
            return { ...block, content: scrubbed };
          }
        }
        return block;
      });

      if (modified) {
        return { ...msg, content: newContent };
      }
      return msg;
    }

    return msg;
  });

  return payload;
}

// ============================================================
// PHASE 1, FEATURE 3: CONTENT ROUTER MIDDLEWARE
// ============================================================

export async function tagToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  let typesReport = { json: 0, code: 0, log: 0, diff: 0, text: 0, markdown: 0 };
  let skippedAlreadyTagged = 0;

  // ── Build tool call metadata lookup ──
  const toolCallMeta = new Map();
  for (const msg of payload.messages) {
    if (msg.role === "assistant") {
      // OpenAI format
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          try {
            const args = JSON.parse(tc.function?.arguments || "{}");
            toolCallMeta.set(tc.id, {
              toolName: tc.function?.name || "",
              filePath:
                args.path ||
                args.file_path ||
                args.filename ||
                args.filepath ||
                args.input?.path ||
                args.file ||
                null,
              command: args.command || null,
              args,
            });
          } catch (_) {}
        }
      }
      // Anthropic format
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            try {
              const args = block.input || {};
              toolCallMeta.set(block.id, {
                toolName: block.name || "",
                filePath:
                  args.path ||
                  args.file_path ||
                  args.filename ||
                  args.filepath ||
                  args.input?.path ||
                  args.file ||
                  null,
                command: args.command || null,
                args,
              });
            } catch (_) {}
          }
        }
      }
    }
  }

  const classifyJobs = [];

  for (const msg of payload.messages) {
    if (msg.role === "tool" && typeof msg.content === "string") {
      // ── ALWAYS backfill metadata regardless of tag status ──
      const meta = toolCallMeta.get(msg.tool_call_id);
      if (meta) {
        if (meta.filePath && !msg._filename) msg._filename = meta.filePath;
        if (meta.toolName && !msg._toolName)  msg._toolName = meta.toolName;
        if (meta.command && !msg._command)    msg._command = meta.command;
        if (!msg._args) msg._args = meta.args;

        const lowerName = meta.toolName.toLowerCase();

        // ── Shell tool detection ────────────────────────────────────────
        // FIX: Use exact Set lookup — NOT .includes("execute") which would
        // false-positive on MCP tools like "executeGraphQuery".
        //
        // FIX: Remove the !msg._cf_type guard from Gemini's implementation.
        // Without the guard, protection applies on every turn — not just
        // the first time the message is tagged. If a previous run set
        // _cf_type = "text" on a Bash result (before this fix), the
        // guard would prevent correction on subsequent turns.
        //
        // FIX: Set both _cf_type = "log" AND _isShellTool = true.
        //   _cf_type = "log"      → blocks semanticDedup (not in allowed list)
        //   _isShellTool = true   → explicit flag checked by fatCatch to
        //                           block vaulting of large shell outputs
        if (SHELL_TOOL_NAMES.has(lowerName)) {
          msg._cf_type = "log";
          msg._isShellTool = true;
        }

        // ── Read tool editable flag ─────────────────────────────────────
        if (msg._cf_editable === undefined) {
          const isReadTool = /^(?:mcp__\w+__|[\w]+__)?(?:read_file|read_file_chunk|read_function|view_file)$/.test(lowerName);

          if (isReadTool) {
            const args = meta.args || {};
            const startLine = args.start_line ?? args.startLine ?? args.start ?? args.StartLine;
            const endLine   = args.end_line   ?? args.endLine   ?? args.end   ?? args.EndLine;

            if (startLine !== undefined && endLine !== undefined) {
              const linesRequested = Number(endLine) - Number(startLine);
              msg._cf_editable = linesRequested >= 0 && linesRequested <= 800;
            } else {
              msg._cf_editable = false;
            }
          } else {
            msg._cf_editable = false;
          }
        }
      }

      // Already tagged — skip Magika, just count
      if (msg._cf_type) {
        skippedAlreadyTagged++;
        typesReport[msg._cf_type] = (typesReport[msg._cf_type] || 0) + 1;
        continue;
      }

      // New message — classify and tag
      classifyJobs.push(
        classifyContentAsync(msg.content).then((type) => {
          msg._cf_type = type;
          typesReport[type] = (typesReport[type] || 0) + 1;
        })
      );
    }

    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && typeof block.content === "string") {
          const meta = toolCallMeta.get(block.tool_use_id);
          if (meta) {
            if (meta.filePath && !block._filename) block._filename = meta.filePath;
            if (meta.toolName && !block._toolName)  block._toolName = meta.toolName;
            if (meta.command && !block._command)    block._command = meta.command;
            if (!block._args) block._args = meta.args;

            const lowerName = meta.toolName.toLowerCase();

            // ── Shell tool detection (Anthropic format) ─────────────────
            // Same fix as OpenAI path above — exact Set, no !_cf_type guard,
            // dual flag (_cf_type + _isShellTool).
            if (SHELL_TOOL_NAMES.has(lowerName)) {
              block._cf_type = "log";
              block._isShellTool = true;
            }

            if (block._cf_editable === undefined) {
              const isReadTool = /^(?:mcp__\w+__|[\w]+__)?(?:read_file|read_file_chunk|read_function|view_file)$/.test(lowerName);

              if (isReadTool) {
                const args = meta.args || {};
                const startLine = args.start_line ?? args.startLine ?? args.start ?? args.StartLine;
                const endLine   = args.end_line   ?? args.endLine   ?? args.end   ?? args.EndLine;

                if (startLine !== undefined && endLine !== undefined) {
                  const linesRequested = Number(endLine) - Number(startLine);
                  block._cf_editable = linesRequested >= 0 && linesRequested <= 800;
                } else {
                  block._cf_editable = false;
                }
              } else {
                block._cf_editable = false;
              }
            }
          }

          if (block._cf_type) {
            skippedAlreadyTagged++;
            typesReport[block._cf_type] = (typesReport[block._cf_type] || 0) + 1;
            continue;
          }

          classifyJobs.push(
            classifyContentAsync(block.content).then((type) => {
              block._cf_type = type;
              typesReport[type] = (typesReport[type] || 0) + 1;
            })
          );
        }
      }
    }
  }

  await Promise.all(classifyJobs);

  return payload;
}