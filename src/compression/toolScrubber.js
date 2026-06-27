import { classifyContentAsync } from "./contentDetector.js";
// ============================================================
// PHASE 1, FEATURE 1: NATIVE TERMINAL SCRUBBER (RTK Replacement)
// ============================================================

/**
 * Standard ANSI escape sequence regex.
 * Matches CSI sequences: ESC [ ... <letter>
 * Matches OSC sequences: ESC ] ... BEL or ST
 * Matches single-character ESC sequences
 */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;
const OSC_PATTERN = /\x1b\][^\x07]*\x07/g;
const SINGLE_ESC = /\x1b[()][0-9a-zA-Z]/g;

/**
 * Lines that are ONLY spinner/loading noise.
 * These lines contain nothing but spinner characters, punctuation,
 * percentages, and box-drawing characters — no actual words.
 */
const SPINNER_LINE_PATTERN = /^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠏⣾⣽⣻⢿⡿⣟⣯⣷#=\-|/\\%.\d(){}\]\[∧>]*$/;

/**
 * npm/yarn install progress lines look like:
 *   [#########........] 45% - some-package@1.2.3
 * We want to keep the final package list but strip intermediate progress lines.
 */
const NPM_PROGRESS_PATTERN = /^\[[#=\-.\s]{8,}\]\s+\d+%.*/;

/**
 * Carriage-return-based progress (single-line overwrite spinners).
 * Detects groups of lines where each line ends with \r and replaces the pattern.
 */
function collapseCarriageReturnProgress(text) {
  // Split on carriage returns to see overwrite groups
  // Lines separated by \r (not \n) overwrite each other in-terminal
  const lines = text.split("\n");

  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check if this line contains \r (carriage return overwrite within the line)
    if (line.includes("\r")) {
      const segments = line.split("\r").filter((s) => s.length > 0);
      if (segments.length > 1) {
        // Multiple \r segments = progress bar overwrite
        // Keep only the LAST segment (final state)
        const lastSegment = segments[segments.length - 1].trim();
        if (lastSegment) {
          result.push(lastSegment);
        }
        i++;
        continue;
      }
    }

    // Check if this looks like a standalone progress bar line
    // and the next few lines ALSO look like progress bars (repeating pattern)
    if (NPM_PROGRESS_PATTERN.test(line) || SPINNER_LINE_PATTERN.test(line)) {
      // Look ahead: how many consecutive progress/spinner lines?
      let j = i + 1;
      while (
        j < lines.length &&
        (NPM_PROGRESS_PATTERN.test(lines[j]) ||
          SPINNER_LINE_PATTERN.test(lines[j]))
      ) {
        j++;
      }

      const consecutiveProgressLines = j - i;
      if (consecutiveProgressLines > 2) {
        // Collapse: keep only the LAST one (final state)
        const lastProgress = lines[j - 1].trim();
        if (lastProgress && !SPINNER_LINE_PATTERN.test(lastProgress)) {
          result.push(
            lastProgress +
              `  [${consecutiveProgressLines - 1} progress lines collapsed]`,
          );
        }
        // Otherwise drop entirely (pure spinner noise)
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

  // 1. Strip ANSI escape codes (colors, cursor movements, etc)
  cleaned = cleaned.replace(ANSI_PATTERN, "");
  cleaned = cleaned.replace(OSC_PATTERN, "");
  cleaned = cleaned.replace(SINGLE_ESC, "");

  // 2. Collapse carriage-return progress bars (npm install, curl, etc)
  cleaned = collapseCarriageReturnProgress(cleaned);

  // 3. Remove npm verbose/silly/timing lines (massive token wasters)
  cleaned = cleaned
    .split("\n")
    .filter((line) => !/^\s*npm\s+(verb|sill|timing|notice\s+http)/i.test(line))
    .join("\n");

  // 4. Collapse vertical whitespace (3+ blank lines → 2)
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  // 5. Collapse horizontal whitespace on each line (2+ spaces → 1)
  cleaned = cleaned
    .split("\n")
    .map((line) => line.replace(/  +/g, " "))
    .join("\n");

  // 6. Trim trailing whitespace per line
  cleaned = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

  // 7. Final trim
  return cleaned.trim();
}

/**
 * Applies the terminal scrubber to all tool results in the payload.
 * This runs on the LIVE payload — the LLM gets clean text but
 * real timestamps and IDs are preserved for reasoning.
 */
export function scrubToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  payload.messages = payload.messages.map((msg) => {
    // Post-translation: tool results are role: "tool"
    if (msg.role === "tool" && typeof msg.content === "string") {
      const beforeLen = msg.content.length;
      msg.content = scrubTerminalOutput(msg.content);
      if (beforeLen !== msg.content.length) {
        // We'll log this at the call site
        msg._scrubbedChars = beforeLen - msg.content.length;
      }
    }

    // Pre-translation: anthropic content blocks
    if (msg.role === "user" && Array.isArray(msg.content)) {
      msg.content = msg.content.map((block) => {
        if (block.type === "tool_result" && typeof block.content === "string") {
          const beforeLen = block.content.length;
          const cleaned = scrubTerminalOutput(block.content);
          if (beforeLen !== cleaned.length) {
            block._scrubbedChars = beforeLen - cleaned.length;
          }
          return { ...block, content: cleaned };
        }
        return block;
      });
    }

    return msg;
  });

  return payload;
}

// ============================================================
// PHASE 1, FEATURE 3: CONTENT ROUTER MIDDLEWARE
// ============================================================

/**
 * Walks the payload and attaches a `_cf_type` tag to each tool result
 * after it has been scrubbed.
 */
export async function tagToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  let typesReport = { json: 0, code: 0, log: 0, diff: 0, text: 0, markdown: 0 };
  let skippedAlreadyTagged = 0;

  // ── Build tool call metadata lookup ──
  // Must run before the classification loop so backfill
  // can apply _filename to already-tagged messages too.
  const toolCallMeta = new Map();
  for (const msg of payload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
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
            // Store full args so semanticDedup can probe them directly
            args,
          });
        } catch (_) {}
      }
    }
  }

  const classifyJobs = [];

  for (const msg of payload.messages) {
    if (msg.role === "tool" && typeof msg.content === "string") {
      // ── ALWAYS backfill metadata regardless of tag status ──
      // Prior fix: already-tagged messages hit `continue` before
      // toolCallMeta.get() — so _filename was only set on turn 1.
      // On turn 2+ the dedup saw _filename=undefined → no-key → skip.
      const meta = toolCallMeta.get(msg.tool_call_id);
      if (meta) {
        if (meta.filePath && !msg._filename) msg._filename = meta.filePath;
        if (meta.toolName && !msg._toolName) msg._toolName = meta.toolName;
        if (meta.command && !msg._command) msg._command = meta.command;
        // Expose full args for downstream consumers (semanticDedup._args)
        if (!msg._args) msg._args = meta.args;
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
        }),
      );
    }

    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && typeof block.content === "string") {
          if (block._cf_type) {
            skippedAlreadyTagged++;
            typesReport[block._cf_type] =
              (typesReport[block._cf_type] || 0) + 1;
            continue;
          }

          classifyJobs.push(
            classifyContentAsync(block.content).then((type) => {
              block._cf_type = type;
              typesReport[type] = (typesReport[type] || 0) + 1;
            }),
          );
        }
      }
    }
  }

  await Promise.all(classifyJobs);

  const newlyClassified = classifyJobs.length;
  // console.log(
  //   `[ContentRouter] 🏷️  Tagged tool results: ` +
  //     Object.entries(typesReport)
  //       .filter(([_, count]) => count > 0)
  //       .map(([type, count]) => `${count}x ${type}`)
  //       .join(", ") +
  //     (skippedAlreadyTagged > 0
  //       ? ` (${skippedAlreadyTagged} cached, ${newlyClassified} new)`
  //       : ""),
  // );

  return payload;
}


