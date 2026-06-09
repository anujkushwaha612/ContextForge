import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import crypto from "node:crypto";
import { saveToVault } from "./logging/cacheDb.js"; // Assume this maps to your SQLite writing layer
import { classifyContent } from "./compression/contentDetector.js";
import { computeOptimalK } from "./compression/adaptiveSizer.js";

export function detectMutation(payloadStr) {
  const fileOpMatch = payloadStr.match(
    /"operation"\s*:\s*"(create|append)"[^}]*"filename"\s*:\s*"([^"]+)"/,
  );
  if (fileOpMatch) return { isMutation: true, mutatedFile: fileOpMatch[2] };

  const redirectMatch = payloadStr.match(
    /"command"\s*:\s*"[^"]*>\s*([^\s"\\]+)"/,
  );
  if (redirectMatch) return { isMutation: true, mutatedFile: redirectMatch[1] };

  const destructiveMatch = payloadStr.match(
    /"command"\s*:\s*"(?:rm|mv|cp|touch|truncate|sed|awk)[^"]*\s([^\s"\\]+)"/i,
  );
  if (destructiveMatch)
    return { isMutation: true, mutatedFile: destructiveMatch[1] };

  return { isMutation: false, mutatedFile: null };
}

export function hashFile(filePath) {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      return createHash("sha256").update(content).digest("hex").slice(0, 16);
    }
  } catch {
    /* Ignore read errors */
  }
  return null;
}

// ========================================================
// 1. INBOUND TRANSLATION: Anthropic JSON -> OpenAI JSON
// ========================================================
export function translateAnthropicToOpenAI(payload) {
  const openAiPayload = JSON.parse(JSON.stringify(payload));

  // Translate System Prompt
  if (openAiPayload.system) {
    let sysContent = openAiPayload.system;
    if (Array.isArray(openAiPayload.system)) {
      sysContent = openAiPayload.system
        .filter((s) => s.type === "text")
        .map((s) => s.text)
        .join("\n");
    }
    openAiPayload.messages = [
      { role: "system", content: sysContent },
      ...(openAiPayload.messages || []),
    ];
    delete openAiPayload.system;
  }

  // Translate Message History Content Blocks
  if (openAiPayload.messages) {
    openAiPayload.messages = openAiPayload.messages.map((msg) => {
      if (Array.isArray(msg.content)) {
        // Translate tool execution results back from Claude Code
        if (
          msg.role === "user" &&
          msg.content.some((b) => b.type === "tool_result")
        ) {
          const toolResults = msg.content.filter(
            (b) => b.type === "tool_result",
          );
          return toolResults.map((tr) => ({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: Array.isArray(tr.content)
              ? tr.content.map((c) => c.text).join("\n")
              : tr.content || "",
          }));
        }

        // Translate historical tool calls emitted by the assistant
        if (
          msg.role === "assistant" &&
          msg.content.some((b) => b.type === "tool_use")
        ) {
          const textBlocks = msg.content.filter((b) => b.type === "text");
          const toolUseBlocks = msg.content.filter(
            (b) => b.type === "tool_use",
          );
          return {
            ...msg,
            content: textBlocks.map((b) => b.text).join("\n") || null,
            tool_calls: toolUseBlocks.map((tu) => ({
              id: tu.id,
              type: "function",
              function: {
                name: tu.name,
                arguments: JSON.stringify(tu.input || {}),
              },
            })),
          };
        }

        // Standard text block flattening
        const textContent = msg.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        return { ...msg, content: textContent };
      }
      return msg;
    });

    openAiPayload.messages = openAiPayload.messages.flat();
  }

  // Natively translate Anthropic Tool Schemas to OpenAI Parameters
  if (openAiPayload.tools && Array.isArray(openAiPayload.tools)) {
    openAiPayload.tools = openAiPayload.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ||
          tool.parameters || { type: "object", properties: {} },
      },
    }));
    console.log(
      `[Tool Translator] 🛠️ Natively mapped ${openAiPayload.tools.length} schemas to OpenAI parameters.`,
    );
  }

  return openAiPayload;
}

// ========================================================
// 2. STRIP ANTHROPIC NON-STANDARD ROOT PARAMETERS
// ========================================================
export function stripAnthropicSpecificFields(payload) {
  const cleaned = JSON.parse(JSON.stringify(payload));
  delete cleaned.anthropic_version;
  delete cleaned.context_management;
  delete cleaned.metadata;
  delete cleaned.stop_sequences;
  delete cleaned.output_config;
  delete cleaned.thinking;
  delete cleaned.prompt_cache_key;
  return cleaned;
}

// ========================================================
// 3. STREAM TRANSLATOR: OpenAI Server Deltas -> Anthropic SSE
// ========================================================
// Add at module level in helper.js:
const _toolSchemaCacheMap = new Map();

// Wrap minimizeToolSchemas:
export function minimizeToolSchemas(payload) {
  if (!payload.tools || payload.tools.length === 0) return payload;

  // Hash the current tools array
  const toolsJson = JSON.stringify(payload.tools);
  const hash = crypto
    .createHash("sha256")
    .update(toolsJson)
    .digest("hex")
    .slice(0, 16);

  if (_toolSchemaCacheMap.has(hash)) {
    payload.tools = _toolSchemaCacheMap.get(hash);
    console.log(
      `[Tool Minimizer] ✅ Cache hit (${hash}) — skipped minimization`,
    );
    return payload;
  }

  // ... existing minimization logic unchanged ...
  const originalSize = toolsJson.length;

  payload.tools = payload.tools.map((tool) => {
    const fn = tool.function || tool;
    const params = fn.parameters || {};
    const properties = params.properties || {};
    const required = params.required || [];

    const keptProps = {};
    const keptRequired = [];

    for (const key of required) {
      if (properties[key]) {
        keptProps[key] = {
          type: properties[key].type || "string",
          description: (properties[key].description || "").slice(0, 60),
        };
        keptRequired.push(key);
      }
    }

    let optionalCount = 0;
    for (const [key, val] of Object.entries(properties)) {
      if (!required.includes(key) && optionalCount < 2) {
        keptProps[key] = {
          type: val.type || "string",
          description: (val.description || "").slice(0, 40),
        };
        optionalCount++;
      }
    }

    return {
      type: "function",
      function: {
        name: fn.name,
        description: (fn.description || "").slice(0, 80),
        parameters: {
          type: "object",
          properties: keptProps,
          required: keptRequired,
        },
      },
    };
  });

  const newSize = JSON.stringify(payload.tools).length;
  const savedChars = originalSize - newSize;
  const savedTokens = Math.floor(savedChars / 4);

  // Cache the result
  _toolSchemaCacheMap.set(hash, payload.tools);

  console.log(
    `[Tool Minimizer] ${originalSize} → ${newSize} chars ` +
      `(saved ~${savedTokens} tokens across ${payload.tools.length} tools) [cached as ${hash}]`,
  );

  return payload;
}

// ========================================================
// 3. STREAM TRANSLATOR: OpenAI Server Deltas -> Anthropic SSE
// ========================================================
export function translateOpenAISSEToAnthropic(
  openAIData,
  messageId,
  isFirst,
  toolState,
) {
  const events = [];

  // Initialize sequential block index counter — persists across chunks
  // This guarantees Anthropic never sees two blocks with the same index
  if (toolState.nextBlockIndex === undefined) {
    toolState.nextBlockIndex = 0;
    toolState.textBlockIndex = -1; // -1 = not yet opened
    toolState.currentToolIndex = -1;
  }

  // ── Stream Terminus Processing ──
  if (openAIData.trim() === "[DONE]") {
    if (toolState.inToolCall && toolState.currentToolIndex >= 0) {
      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: toolState.currentToolIndex,
        })}\n\n`,
      );
      events.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 0 },
        })}\n\n`,
      );
    } else {
      if (toolState.inTextBlock && toolState.textBlockIndex >= 0) {
        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: toolState.textBlockIndex,
          })}\n\n`,
        );
      }
      events.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        })}\n\n`,
      );
    }
    events.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    return events;
  }

  // ── Parse incoming chunk ──
  let parsed;
  try {
    parsed = JSON.parse(openAIData);
  } catch (e) {
    return events;
  }

  const choice = parsed.choices?.[0];
  if (!choice) return events;

  const delta = choice.delta;
  const finishReason = choice.finish_reason;

  // ── Initial Transaction Framing ──
  if (isFirst) {
    events.push(
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: "contextforge",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 1 },
        },
      })}\n\n`,
    );
    events.push(`event: ping\ndata: {"type":"ping"}\n\n`);
  }

  // ── Text & Reasoning Streaming ──
  // Nemotron/DeepSeek-R1 stream chain-of-thought in delta.reasoning
  // before outputting content or tool calls.
  // Combining both preserves the full reasoning in conversation history,
  // which prevents agent amnesia on the next turn.
  const reasoningContent = delta?.reasoning || "";
  const textContent = delta?.content || "";
  const combinedText = reasoningContent + textContent;

  if (combinedText) {
    if (!toolState.inTextBlock && !toolState.inToolCall) {
      toolState.inTextBlock = true;
      toolState.textBlockIndex = toolState.nextBlockIndex++;

      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: toolState.textBlockIndex,
          content_block: { type: "text", text: "" },
        })}\n\n`,
      );
    }

    // Only emit delta if text block is actually open
    // Guards against reasoning arriving after a tool call started
    if (toolState.inTextBlock && toolState.textBlockIndex >= 0) {
      events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: toolState.textBlockIndex,
          delta: { type: "text_delta", text: combinedText },
        })}\n\n`,
      );
    }
  }

  // ── Tool Call Streaming ──
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      // Close open text block before first tool block opens
      if (toolState.inTextBlock && !toolState.inToolCall) {
        toolState.inTextBlock = false;
        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: toolState.textBlockIndex,
          })}\n\n`,
        );
      }

      // First chunk for this tool carries id + name → open the block
      if (tc.id && tc.function?.name) {
        // Close previous tool block if we're opening a new parallel one
        if (toolState.inToolCall && toolState.currentToolIndex >= 0) {
          events.push(
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: toolState.currentToolIndex,
            })}\n\n`,
          );
        }

        toolState.inToolCall = true;
        // KEY FIX: auto-increment so tool block never shares index with text block
        toolState.currentToolIndex = toolState.nextBlockIndex++;

        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: toolState.currentToolIndex,
            content_block: {
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: {},
            },
          })}\n\n`,
        );
      }

      // Argument fragments — only emit if tool block is open
      if (tc.function?.arguments && toolState.currentToolIndex >= 0) {
        events.push(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: toolState.currentToolIndex,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments,
            },
          })}\n\n`,
        );
      }
    }
  }

  // ── Finish Reason Handling ──
  // Close text block on finish_reason — tool blocks close at [DONE]
  if (finishReason && finishReason !== "null") {
    if (toolState.inTextBlock && toolState.textBlockIndex >= 0) {
      toolState.inTextBlock = false;
      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: toolState.textBlockIndex,
        })}\n\n`,
      );
    }
  }

  return events;
}

export function interceptAndVaultMassiveToolResults(
  payload,
  charThreshold = 15000, // ← default preserved; server.js now passes policy value
) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  payload.messages = payload.messages.map((msg) => {
    if (msg.role === "tool" && typeof msg.content === "string") {
      if (msg.content.length > charThreshold) {
        const originalLength = msg.content.length;
        const vaultId = saveToVault(msg.content);

        console.log(
          `[Fat Catch] 🕸️ Intercepted massive tool result (${originalLength} chars) -> Offloaded to ${vaultId}` +
            ` [threshold=${charThreshold}]`, // ← now shows which policy threshold fired
        );

        return {
          ...msg,
          content:
            `[CF_VAULT:${vaultId}] ${Math.round(originalLength / 4)} tokens compressed. ` +
            `Call contextforge_retrieve(vault_id:"${vaultId}") to expand.`,
        };
      }
    }
    return msg;
  });

  return payload;
}

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
export function tagToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  let typesReport = { json: 0, code: 0, log: 0, diff: 0, text: 0 };

  // Build a lookup of tool_call_id → tool name from assistant messages
  // so we can attach the filename hint from tool args
  const toolCallMeta = new Map();
  for (const msg of payload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        try {
          const args = JSON.parse(tc.function?.arguments || "{}");
          toolCallMeta.set(tc.id, {
            toolName: tc.function?.name || "",
            // Claude Code file tools use "path" or "file_path" or "filename"
            filePath: args.path || args.file_path || args.filename || null,
            command: args.command || null,
          });
        } catch (_) {}
      }
    }
  }

  payload.messages = payload.messages.map((msg) => {
    if (msg.role === "tool" && typeof msg.content === "string") {
      const meta = toolCallMeta.get(msg.tool_call_id);

      // Attach filename if we can infer it
      if (meta?.filePath && !msg._filename) {
        msg._filename = meta.filePath;
      }

      // Attach tool name for deduplication key construction
      if (meta?.toolName && !msg._toolName) {
        msg._toolName = meta.toolName;
      }

      msg._cf_type = classifyContent(msg.content);
      typesReport[msg._cf_type]++;
    }

    if (msg.role === "user" && Array.isArray(msg.content)) {
      msg.content = msg.content.map((block) => {
        if (block.type === "tool_result" && typeof block.content === "string") {
          block._cf_type = classifyContent(block.content);
          typesReport[block._cf_type]++;
        }
        return block;
      });
    }

    return msg;
  });

  console.log(
    `[ContentRouter] 🏷️  Tagged tool results: ` +
      Object.entries(typesReport)
        .filter(([_, count]) => count > 0)
        .map(([type, count]) => `${count}x ${type}`)
        .join(", "),
  );

  return payload;
}

// ============================================================
// PHASE 2, FEATURE 5: TARGETED LOG & DIFF PRUNER
// ============================================================

/**
 * Important patterns that must be kept in log output.
 * Lines matching these patterns AND lines near them are retained.
 */
const LOG_KEEP_PATTERNS = [
  /\bERROR\b/i,
  /\bFAIL(?:ED|URE)?\b/i,
  /\bCRITICAL\b/i,
  /\bFATAL\b/i,
  /\bPANIC\b/i,
  /\bEXCEPTION\b/i,
  /\bTRACE\b/i,
  /\bABORT\b/i,
  /\bKILLED\b/i,
  /\bSEGV\b/i, // segfault
  /\bSIGNAL\b/i,
  /\bUNEXPECTED\b/i,
  /\bTIMEOUT\b/i,
  /\bDENIED\b/i,
  /\bFORBIDDEN\b/i,
  /\bERR_\w+/i, // node error codes
  /^\s+at\s/, // stack trace line (e.g., "    at Module._compile (...)")
  /^\s+[a-zA-Z0-9._]+\(.+:\d+:\d+\)/, // another stack trace style
  /\brefused\b/i,
  /\bnot found\b/i,
  /\bmissing\b/i,
  /\bundefined\b/i,
  /\bnull\b/i,
  /\bNaN\b/i,
];

const CONTEXT_BEFORE = 2; // lines to keep before an important line
const CONTEXT_AFTER = 3; // lines to keep after an important line
const HEAD_LINES = 5; // always keep first N lines
const TAIL_LINES = 3; // always keep last N lines

export function pruneLogOutput(text) {
  if (typeof text !== "string" || text.length === 0)
    return { kept: text, vaulted: false };

  const lines = text.split(/\r?\n/);
  if (lines.length < HEAD_LINES + TAIL_LINES + 5) {
    // Too short to prune meaningfully
    return { kept: text, vaulted: false };
  }

  // Mark lines to keep
  const keep = new Array(lines.length).fill(false);

  // Always keep head and tail
  for (let i = 0; i < Math.min(HEAD_LINES, lines.length); i++) keep[i] = true;
  for (let i = Math.max(0, lines.length - TAIL_LINES); i < lines.length; i++)
    keep[i] = true;

  // Mark important lines based on patterns
  const importantIndices = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (LOG_KEEP_PATTERNS.some((re) => re.test(line))) {
      importantIndices.push(i);
      keep[i] = true;
    }
  }

  // Expand context around important lines (without overlapping head/tail too much)
  for (const idx of importantIndices) {
    for (let c = 1; c <= CONTEXT_BEFORE; c++) {
      const before = idx - c;
      if (before >= 0 && !keep[before]) keep[before] = true;
    }
    for (let c = 1; c <= CONTEXT_AFTER; c++) {
      const after = idx + c;
      if (after < lines.length && !keep[after]) keep[after] = true;
    }
  }

  // Build pruned result
  const keptLines = [];
  let removedCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      keptLines.push(lines[i]);
    } else {
      removedCount++;
    }
  }

  const totalRemovedChars = lines
    .filter((_, i) => !keep[i])
    .reduce((sum, l) => sum + l.length + 1, 0); // +1 for newline

  // If we removed less than 30% of lines, just return original (no meaningful savings)
  if (removedCount < lines.length * 0.3) {
    return { kept: text, vaulted: false };
  }

  // Build compressed output with indicators where lines were pruned
  const resultLines = [];
  let inGap = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (inGap) {
        resultLines.push(`  [... ${removedCount} verbose lines pruned ...]`);
        inGap = false;
      }
      resultLines.push(lines[i]);
    } else {
      inGap = true;
    }
  }
  if (inGap) {
    resultLines.push(`  [... ${removedCount} verbose lines pruned ...]`);
  }

  const keptText = resultLines.join("\n");
  return {
    kept: keptText,
    vaulted: true,
    originalText: text,
    removedLines: removedCount,
    removedChars: totalRemovedChars,
  };
}

/**
 * Prunes a unified diff by collapsing large sections of unchanged
 * context lines that have no nearby changes.
 *
 * Strategy:
 * - Keep all hunk headers (@@ ... @@)
 * - Keep all added (+) and removed (-) lines
 * - Keep unchanged lines if they are within CONTEXT_RANGE of any change
 * - Replace long runs of completely unchanged context with [... N lines omitted ...]
 */
const DIFF_CONTEXT_RANGE = 3; // lines of unchanged context to keep around changes

export function pruneDiffOutput(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { kept: text, vaulted: false };
  }

  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;

  // Track which lines are "important" (headers, changes)
  const important = new Array(totalLines).fill(false);

  // Mark all hunk headers and +/- lines as important
  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    if (line.startsWith("@@") || line.startsWith("+") || line.startsWith("-")) {
      important[i] = true;
    }
  }

  // Expand around important lines: mark unchanged context lines within range
  const keep = [...important];
  for (let i = 0; i < totalLines; i++) {
    if (important[i]) {
      for (let d = 1; d <= DIFF_CONTEXT_RANGE; d++) {
        if (i - d >= 0 && lines[i - d].startsWith(" ") && !keep[i - d]) {
          keep[i - d] = true;
        }
        if (
          i + d < totalLines &&
          lines[i + d].startsWith(" ") &&
          !keep[i + d]
        ) {
          keep[i + d] = true;
        }
      }
    }
  }

  // Build pruned output
  const resultLines = [];
  let inOmittedBlock = false;
  let omittedCount = 0;

  for (let i = 0; i < totalLines; i++) {
    if (keep[i]) {
      if (inOmittedBlock && omittedCount > 0) {
        resultLines.push(`[... ${omittedCount} unchanged lines omitted ...]`);
        inOmittedBlock = false;
        omittedCount = 0;
      }
      resultLines.push(lines[i]);
    } else {
      inOmittedBlock = true;
      omittedCount++;
    }
  }

  if (inOmittedBlock && omittedCount > 0) {
    resultLines.push(`[... ${omittedCount} unchanged lines omitted ...]`);
  }

  const keptText = resultLines.join("\n");

  // Only vault if we actually saved significant space
  const removedLines = totalLines - keep.filter(Boolean).length;
  if (removedLines < totalLines * 0.2) {
    // Not worth vaulting – diff is already tight
    return { kept: text, vaulted: false };
  }

  return {
    kept: keptText,
    vaulted: true,
    originalText: text,
    removedLines,
    removedChars: lines
      .filter((_, i) => !keep[i])
      .reduce((sum, l) => sum + l.length + 1, 0),
  };
}
/**
 * Processes all tool results in the payload that have a _cf_type tag,
 * applying the appropriate pruner.
 */
export function pruneToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  let pruneStats = {
    log: 0,
    diff: 0,
    charsSaved: 0,
    linesRemoved: 0,
    vaultsCreated: 0,
  };

  payload.messages = payload.messages.map((msg) => {
    if (
      msg.role === "tool" &&
      typeof msg.content === "string" &&
      msg._cf_type
    ) {
      const beforeLen = msg.content.length;
      let result;

      switch (msg._cf_type) {
        case "log":
          result = pruneLogOutput(msg.content);
          pruneStats.log++;
          break;
        case "diff":
          result = pruneDiffOutput(msg.content);
          pruneStats.diff++;
          break;
        default:
          return msg; // no pruning for json, code, text in this feature
      }

      if (result.vaulted && result.originalText) {
        // Store the full original in the vault
        const vaultId = saveToVault(result.originalText);
        pruneStats.vaultsCreated++;
        pruneStats.charsSaved += beforeLen - result.kept.length;
        pruneStats.linesRemoved += result.removedLines || 0;

        console.log(
          `[Log Pruner] ${msg._cf_type.toUpperCase()} pruned: ` +
            `removed ${result.removedLines} lines (~${Math.floor((result.removedChars || 0) / 4)} tokens) → Vault ${vaultId}`,
        );

        return {
          ...msg,
          content: result.kept,
          _prunedVaultId: vaultId,
        };
      }

      // Non-vaulted case: just replace content with pruned version
      msg.content = result.kept;
      return msg;
    }

    // For user content blocks (Anthropic pre-translation)
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((block) => {
          if (
            block.type === "tool_result" &&
            typeof block.content === "string" &&
            block._cf_type
          ) {
            const beforeLen = block.content.length;
            let result;
            switch (block._cf_type) {
              case "log":
                result = pruneLogOutput(block.content);
                break;
              case "diff":
                result = pruneDiffOutput(block.content);
                break;
              default:
                return block;
            }
            if (result.vaulted && result.originalText) {
              const vaultId = saveToVault(result.originalText);
              console.log(
                `[Log Pruner] ${block._cf_type.toUpperCase()} pruned (Anthropic block): ` +
                  `removed ${result.removedLines} lines (~${Math.floor((result.removedChars || 0) / 4)} tokens) → Vault ${vaultId}`,
              );
              return {
                ...block,
                content: result.kept,
                _prunedVaultId: vaultId,
              };
            }
            return { ...block, content: result.kept };
          }
          return block;
        }),
      };
    }

    return msg;
  });

  if (pruneStats.log + pruneStats.diff > 0) {
    console.log(
      `[Pruner Summary] Processed ${pruneStats.log} logs, ${pruneStats.diff} diffs | ` +
        `Lines removed: ${pruneStats.linesRemoved} | ` +
        `Chars saved: ${pruneStats.charsSaved} (~${Math.floor(pruneStats.charsSaved / 4)} tokens) | ` +
        `Vaults: ${pruneStats.vaultsCreated}`,
    );
  }

  return payload;
}

// ============================================================
// PHASE 2, FEATURE 4: VECTOR-GUIDED JSON SLICER
// ============================================================

/**
 * Walks a parsed JSON value and extracts all "meaningful" leaf nodes
 * with their key paths. A leaf is a primitive value (string, number, bool, null)
 * or an empty object/array.
 */
function extractJsonNodes(obj, prefix = "$") {
  const nodes = [];

  if (obj === null || obj === undefined) {
    nodes.push({ path: prefix, value: null, leaf: true });
    return nodes;
  }

  if (typeof obj !== "object") {
    // Primitive leaf
    nodes.push({ path: prefix, value: obj, leaf: true });
    return nodes;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      nodes.push({ path: prefix, value: [], leaf: true });
    } else {
      for (let i = 0; i < obj.length; i++) {
        const childPath = `${prefix}[${i}]`;
        const childNodes = extractJsonNodes(obj[i], childPath);
        nodes.push(...childNodes);
      }
    }
    return nodes;
  }

  // Object
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    nodes.push({ path: prefix, value: {}, leaf: true });
  } else {
    for (const key of keys) {
      const childPath = `${prefix}.${key}`;
      const childNodes = extractJsonNodes(obj[key], childPath);
      nodes.push(...childNodes);
    }
  }

  return nodes;
}

/**
 * Scores a JSON node against query keywords.
 * Higher score = more relevant to what the user is asking.
 */
function scoreJsonNode(nodePath, nodeValue, queryKeywords) {
  if (!queryKeywords || queryKeywords.length === 0) return 0;

  const pathLower = nodePath.toLowerCase();
  const valueStr = String(nodeValue ?? "").toLowerCase();
  const combined = pathLower + " " + valueStr;

  let score = 0;
  for (const kw of queryKeywords) {
    const kwLower = kw.toLowerCase();
    // Exact match in path is strongest signal
    if (pathLower.includes(kwLower)) {
      score += 3;
    }
    // Partial word boundary match
    const wordBoundary = new RegExp(`\\b${kwLower}\\b`, "i");
    if (wordBoundary.test(combined)) {
      score += 2;
    }
    // Substring match anywhere
    if (combined.includes(kwLower)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Always keep these paths regardless of relevance score.
 */
const ALWAYS_KEEP_PATTERNS = [
  /\berror\b/i,
  /\bfail(?:ed|ure)?\b/i,
  /\bwarn(?:ing)?\b/i,
  /\bexception\b/i,
  /\bstack\s*trace\b/i,
  /\bstatus\s*code\b/i,
  /\bmessage\b/i,
];

function isAlwaysKeep(path) {
  return ALWAYS_KEEP_PATTERNS.some((re) => re.test(path));
}

/**
 * Extracts query keywords from the conversation context.
 * Looks at the last user message to understand intent.
 */
function extractQueryKeywords(messages) {
  if (!messages || !Array.isArray(messages)) return [];

  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content =
        typeof messages[i].content === "string"
          ? messages[i].content
          : JSON.stringify(messages[i].content);
      // Extract meaningful words (3+ chars, not stopwords)
      const stopwords = new Set([
        "the",
        "and",
        "for",
        "are",
        "but",
        "not",
        "you",
        "all",
        "can",
        "had",
        "her",
        "was",
        "one",
        "our",
        "out",
        "has",
        "have",
        "from",
        "that",
        "this",
        "with",
        "what",
        "when",
        "where",
        "which",
        "will",
        "would",
        "there",
        "their",
        "about",
        "should",
        "could",
        "been",
        "being",
        "does",
        "doing",
        "each",
        "every",
        "they",
        "them",
        "then",
        "just",
        "like",
        "make",
        "more",
        "only",
        "over",
        "such",
        "than",
        "into",
        "also",
        "very",
        "your",
        "some",
        "said",
        "look",
        "here",
      ]);
      return (
        content
          .toLowerCase()
          .match(/\b[a-z]{3,}\b/g)
          ?.filter((w) => !stopwords.has(w))
          ?.slice(0, 20) || []
      );
    }
  }
  return [];
}

/**
 * Builds a compact representation of the kept nodes.
 */
function buildJsonSliceSummary(keptNodes, totalNodes, vaultId) {
  const lines = [
    `[ContextForge JSON Slice - ${keptNodes.length} of ${totalNodes} nodes kept]`,
    `Vault ID: \`${vaultId}\``,
    "",
  ];

  // Group by top-level path prefix
  const byPrefix = {};
  for (const node of keptNodes) {
    const topLevel = node.path.split(".")[0].replace(/\[\d+\]/, "");
    if (!byPrefix[topLevel]) byPrefix[topLevel] = [];
    byPrefix[topLevel].push(node);
  }

  for (const [prefix, nodes] of Object.entries(byPrefix)) {
    if (nodes.length > 5) {
      lines.push(`### ${prefix} (${nodes.length} relevant entries)`);
      for (const n of nodes.slice(0, 5)) {
        const valStr = String(n.value ?? "null").slice(0, 80);
        lines.push(`  ${n.path}: ${valStr}`);
      }
      lines.push(`  ... +${nodes.length - 5} more`);
    } else {
      lines.push(`### ${prefix}`);
      for (const n of nodes) {
        const valStr = String(n.value ?? "null").slice(0, 80);
        lines.push(`  ${n.path}: ${valStr}`);
      }
    }
  }

  lines.push("");
  lines.push(
    `To retrieve the full ${totalNodes}-node JSON, call: ` +
      `\`contextforge_retrieve(vault_id: "${vaultId}")\``,
  );

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// Robust JSON parser — handles NDJSON, truncated JSON,
// JSON with trailing commas, mixed content
// ─────────────────────────────────────────────
function robustJsonParse(text) {
  if (!text || typeof text !== "string") return null;

  // Strategy 1: strict parse
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Strategy 2: extract first complete JSON structure
  // handles "some text before {..." and "...} some text after"
  const structureMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (structureMatch) {
    try {
      return JSON.parse(structureMatch[1]);
    } catch (_) {}
  }

  // Strategy 3: NDJSON — each line is a separate JSON object
  const ndjsonResults = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      ndjsonResults.push(JSON.parse(trimmed));
    } catch (_) {}
  }
  if (ndjsonResults.length > 0) return ndjsonResults;

  // Strategy 4: truncated JSON — try closing it
  // Handles cases where tool output was cut off mid-stream
  const openBraces = (text.match(/\{/g) || []).length;
  const closeBraces = (text.match(/\}/g) || []).length;
  const openBracks = (text.match(/\[/g) || []).length;
  const closeBracks = (text.match(/\]/g) || []).length;

  if (openBraces > closeBraces || openBracks > closeBracks) {
    const padded =
      text +
      "}".repeat(Math.max(0, openBraces - closeBraces)) +
      "]".repeat(Math.max(0, openBracks - closeBracks));
    try {
      return JSON.parse(padded);
    } catch (_) {}
  }

  return null; // genuine failure — not JSON at all
}

/**
 * Core JSON slicing function.
 */
export function sliceJsonOutput(text, messages = []) {
  if (typeof text !== "string" || text.length === 0) {
    return { kept: text, vaulted: false };
  }

  const tokenEstimate = Math.floor(text.length / 4);
  console.log(`[JSON Slicer] 🔍 Analyzing ${tokenEstimate} token JSON...`);

  let parsed = robustJsonParse(text);
  if (parsed === null) {
    console.log(`[JSON Slicer] ❌ All parse strategies failed — skipping`);
    return { kept: text, vaulted: false };
  }

  const nodes = extractJsonNodes(parsed);
  console.log(`[JSON Slicer] Extracted ${nodes.length} leaf nodes`);

  if (nodes.length < 10) {
    console.log(
      `[JSON Slicer] ⏭️  Too small (${nodes.length} nodes < 10 threshold)`,
    );
    return { kept: text, vaulted: false };
  }

  const queryKeywords = extractQueryKeywords(messages);
  console.log(
    `[JSON Slicer] Keywords: [${queryKeywords.slice(0, 5).join(", ")}...]`,
  );

  const scored = nodes.map((node) => ({
    ...node,
    alwaysKeep: isAlwaysKeep(node.path),
    score: scoreJsonNode(node.path, node.value, queryKeywords),
  }));

  const alwaysKeep = scored.filter((n) => n.alwaysKeep);
  const scoredOnly = scored
    .filter((n) => !n.alwaysKeep)
    .sort((a, b) => b.score - a.score);

  const itemStrings = nodes.map((n) => `${n.path} ${String(n.value ?? "")}`);
  const optimalK = computeOptimalK(
    itemStrings,
    policy.adaptiveSizerBias,
    3,
    50,
  );
  const topScored = scoredOnly.slice(0, optimalK);

  const keptSet = new Map();
  for (const n of [...alwaysKeep, ...topScored]) {
    keptSet.set(n.path, n);
  }
  const keptNodes = [...keptSet.values()];

  const removalRatio = 1 - keptNodes.length / nodes.length;
  console.log(
    `[JSON Slicer] Keeping ${keptNodes.length}/${nodes.length} nodes ` +
      `(${(removalRatio * 100).toFixed(1)}% reduction)`,
  );

  if (removalRatio < 0.5) {
    console.log(`[JSON Slicer] ⏭️  Insufficient reduction (need >50%)`);
    return { kept: text, vaulted: false };
  }

  // Vault the original
  const vaultId = saveToVault(text);

  // Build summary
  const summary = buildJsonSliceSummary(keptNodes, nodes.length, vaultId);

  console.log(
    `[JSON Slicer] ✅ Sliced ${nodes.length} → ${keptNodes.length} nodes → Vault ${vaultId}`,
  );

  return {
    kept: summary,
    vaulted: true,
    vaultId,
    originalText: text,
    keptNodeCount: keptNodes.length,
    totalNodeCount: nodes.length,
  };
}

/**
 * Applies JSON slicing to all tool results tagged as "json".
 */
export function sliceJsonToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  let sliceStats = { sliced: 0, nodesKept: 0, nodesTotal: 0, charsSaved: 0 };

  payload.messages = payload.messages.map((msg) => {
    if (
      msg.role === "tool" &&
      typeof msg.content === "string" &&
      msg._cf_type === "json"
    ) {
      const beforeLen = msg.content.length;
      const result = sliceJsonOutput(msg.content, payload.messages);

      if (result.vaulted) {
        sliceStats.sliced++;
        sliceStats.nodesKept += result.keptNodeCount || 0;
        sliceStats.nodesTotal += result.totalNodeCount || 0;
        sliceStats.charsSaved += beforeLen - result.kept.length;

        return {
          ...msg,
          content: result.kept,
          _slicedVaultId: result.vaultId,
        };
      }
      return msg;
    }

    // Anthropic content blocks
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((block) => {
          if (
            block.type === "tool_result" &&
            typeof block.content === "string" &&
            block._cf_type === "json"
          ) {
            const beforeLen = block.content.length;
            const result = sliceJsonOutput(block.content, payload.messages);
            if (result.vaulted) {
              sliceStats.sliced++;
              sliceStats.charsSaved += beforeLen - result.kept.length;
              return {
                ...block,
                content: result.kept,
                _slicedVaultId: result.vaultId,
              };
            }
            return block;
          }
          return block;
        }),
      };
    }

    return msg;
  });

  if (sliceStats.sliced > 0) {
    console.log(
      `[JSON Slicer Summary] Sliced ${sliceStats.sliced} JSON payloads | ` +
        `Nodes: ${sliceStats.nodesKept}/${sliceStats.nodesTotal} kept | ` +
        `Chars saved: ${sliceStats.charsSaved} (~${Math.floor(sliceStats.charsSaved / 4)} tokens)`,
    );
  }

  return payload;
}

// ============================================================
// PHASE 3, FEATURE 7: PREDICTIVE CONTEXT INJECTION
// ============================================================

/**
 * Patterns that indicate a tool result is a failure.
 */
const FAILURE_SIGNALS = [
  /\bcommand not found\b/i,
  /\bno such file or directory\b/i,
  /\bcannot find module\b/i,
  /\bmodule not found\b/i,
  /\bpermission denied\b/i,
  /\berror\b/i, // ✅ FIX: Added /i flag to catch 'Error:', 'ERROR', 'error'
  /\bfailed with exit code\b/i,
  /\bnpm ERR\b/i,
  /\bSyntaxError\b/,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bexited with code [^0]\b/i,
  /\bcannot read propert/i,
  /\bis not defined\b/i,
  /\bEACCES\b/,
  /\bENOENT\b/,
  /\bECONNREFUSED\b/,
  /\bEADDRINUSE\b/,
  /\bEPERM\b/,
];

const TRIVIAL_ERROR_PATTERNS = [
  /no such file or directory/i,
  /command not found/i,
  /not a git repository/i,
  /already exists/i,
  /is not a directory/i,
  /permission denied/i,
  /cannot find module/i, // only trivial if short
];

function isTrivialError(content) {
  if (typeof content !== "string") return false;
  const lineCount = content.split("\n").filter((l) => l.trim()).length;
  // Only trivial if BOTH: matches a trivial pattern AND is short (< 6 lines)
  // A 20-line stack trace with "permission denied" is NOT trivial
  return lineCount < 6 && TRIVIAL_ERROR_PATTERNS.some((p) => p.test(content));
}

/**
 * Detects whether a tool result content looks like a failure.
 */
function isFailedToolResult(content) {
  if (typeof content !== "string") return false;
  return FAILURE_SIGNALS.some((pattern) => pattern.test(content));
}

/**
 * Extracts the most meaningful error snippet for search.
 */
function extractErrorSignal(content) {
  const lines = content.split("\n");
  for (const line of lines) {
    if (FAILURE_SIGNALS.some((p) => p.test(line))) {
      return line.trim().slice(0, 200);
    }
  }
  return content.slice(0, 200);
}

/**
 * Builds the suggestion block appended to the error message.
 */
function buildSuggestionBlock(searchQuery, results) {
  const lines = [
    ``,
    `---`,
    `[ContextForge Predictive Suggestion]`,
    `Detected a command failure. Searched your project vault for relevant context.`,
    `Query used: "${searchQuery.slice(0, 100)}"`,
    ``,
  ];

  for (let i = 0; i < results.length; i++) {
    // ✅ FIX: Safely grab the BM25 sparse score and format it correctly
    const score =
      results[i].sparseScore !== undefined
        ? results[i].sparseScore
        : results[i].combinedScore || 0;

    lines.push(`[Match ${i + 1} | BM25 Relevance: ${score.toFixed(2)}]`);
    lines.push(results[i].breadcrumb || results[i].text?.slice(0, 300) || "");
    lines.push("");
  }

  lines.push(
    `If this context is relevant, use contextforge_retrieve ` +
      `with a specific search_query to load the full section.`,
  );
  lines.push(`---`);

  return lines.join("\n");
}
/**
 * Orchestrator: walks all tool results in the payload,
 * detects failures, and appends predictive suggestions.
 *
 * Requires getStaticEmbedding and hybridRetriever because
 * they live in server.js scope — pass them in here.
 */
export function applyPredictiveInjection(payload, hybridRetriever) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;
  if (!hybridRetriever) return payload;

  let injectCount = 0;

  payload.messages = payload.messages.map((msg) => {
    if (msg.role === "tool" && typeof msg.content === "string") {
      if (!isFailedToolResult(msg.content)) return msg;
      if (isTrivialError(msg.content)) {
        console.log(
          `[Predictive Injection] ⏭️  Skipping trivial error (${msg.content.split("\n").length} lines)`,
        );
        return msg;
      }

      try {
        const errorSignal = extractErrorSignal(msg.content);

        let searchQuery = errorSignal;
        for (let i = payload.messages.length - 1; i >= 0; i--) {
          if (payload.messages[i].role === "user") {
            const userText =
              typeof payload.messages[i].content === "string"
                ? payload.messages[i].content
                : "";
            if (userText.length > 0) {
              searchQuery = `${userText.slice(0, 100)} ${errorSignal}`;
            }
            break;
          }
        }

        console.log(
          `[Predictive Injection] 🔍 Failure detected: "${errorSignal.slice(0, 80)}"`,
        );

        let results = [];
        try {
          // ── BEFORE: wasteful hybrid call ──────────────────────────────
          // const zeroDenseVec = new Float32Array(384).fill(0);
          // results = hybridRetriever.hybridSearch(zeroDenseVec, 5, 0.0, searchQuery);
          //
          // ── AFTER: dedicated sparse search ───────────────────────────
          // - No Float32Array(384) allocation
          // - No 384-float JS→C++ transfer
          // - No HNSW search on a zero vector
          // - O(candidates) instead of O(n²) duplicate check
          // - minScore=1.5 pushed into C++ — no JS filter pass needed
          results = hybridRetriever.sparseSearch(
            searchQuery,
            5, // top k
            1.5, // minScore — replaces the JS .filter() below
          );
        } catch (searchErr) {
          console.warn(
            `[Predictive Injection] Search error: ${searchErr.message}`,
          );
          return msg;
        }

        if (!results || results.length === 0) return msg;

        // ── Score + length filter ─────────────────────────────────────
        // minScore=1.5 already handled in C++
        // Only need length check here
        const meaningful = results.filter((r) => {
          const textLength = (r.breadcrumb || "").length;
          return textLength > 100;
        });

        if (meaningful.length === 0) {
          console.log(
            `[Predictive Injection] Results ignored (breadcrumb too short)`,
          );
          return msg;
        }

        const suggestion = buildSuggestionBlock(searchQuery, meaningful);
        console.log(
          `[Predictive Injection] 💡 Injected ${meaningful.length} high-quality hint(s)`,
        );
        injectCount++;

        return { ...msg, content: msg.content + suggestion };
      } catch (err) {
        console.warn(`[Predictive Injection] ⚠️ Failed: ${err.message}`);
        return msg;
      }
    }
    return msg;
  });

  if (injectCount > 0) {
    console.log(
      `[Predictive Injection] Summary: ${injectCount} result(s) enriched`,
    );
  }

  return payload;
}

// ============================================================
// INLINE SYSTEM MESSAGE DEDUPLICATOR & PRUNER
// ============================================================
export function deduplicateSystemMessages(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  const seenSystemPrompts = new Set();
  let prunedCount = 0;
  let charsSaved = 0;

  const systemMessages = payload.messages.filter((m) => m.role === "system");

  // If there's only ONE system message, never touch it
  // It contains the full behavioral context Nemotron needs
  if (systemMessages.length <= 1) {
    return payload;
  }

  payload.messages = payload.messages.map((msg) => {
    if (msg.role === "system" && typeof msg.content === "string") {
      // 1. Destroy the repetitive "Skills" manual injected by Claude Code
      if (
        msg.content.includes(
          "The following skills are available for use with the Skill tool:",
        )
      ) {
        const parts = msg.content.split(
          "The following skills are available for use with the Skill tool:",
        );
        // Keep whatever was before it (usually important context), but drop the massive list
        const cleanContent =
          parts[0].trim() +
          "\n[ContextForge: Repetitive skills list removed to save tokens]";

        if (cleanContent.length < msg.content.length) {
          charsSaved += msg.content.length - cleanContent.length;
          msg.content = cleanContent;
          prunedCount++;
        }
      }

      // 2. Standard Deduplication: If we've seen this exact system prompt before, drop it
      const promptHash = crypto
        .createHash("sha256")
        .update(msg.content)
        .digest("hex");
      if (seenSystemPrompts.has(promptHash)) {
        charsSaved += msg.content.length;
        msg.content = "[ContextForge: Redundant system prompt removed]";
        prunedCount++;
      } else {
        seenSystemPrompts.add(promptHash);
      }
    }
    return msg;
  });

  if (prunedCount > 0) {
    console.log(
      `[SysPrompt Pruner] ✂️  Removed ${prunedCount} redundant system blocks (saved ~${Math.floor(charsSaved / 4)} tokens)`,
    );
  }

  return payload;
}
