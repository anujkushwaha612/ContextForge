import { get_encoding } from "tiktoken";
const enc = get_encoding("cl100k_base");

// Token overhead constants (approximate, based on OpenAI/Anthropic wire format)
const MESSAGE_OVERHEAD = 4; // role + framing per message

/**
 * Counts tokens in a complete payload (messages + tools).
 * Handles both OpenAI and Anthropic shapes.
 */
export function countTokens(payload) {
  let tokens = 0;

  // System prompt (if separate)
  if (payload.system) {
    tokens += enc.encode(
      typeof payload.system === "string"
        ? payload.system
        : JSON.stringify(payload.system),
    ).length;
    tokens += MESSAGE_OVERHEAD;
  }

  // Messages
  if (payload.messages) {
    for (const msg of payload.messages) {
      tokens += countMessageTokens(msg);
    }
  }

  // Tool definitions (if present)
  if (payload.tools) {
    tokens += enc.encode(JSON.stringify(payload.tools)).length;
  }

  return tokens;
}

/**
 * Counts tokens for a single message, handling string/array content,
 * tool calls, and tool results.
 */
export function countMessageTokens(msg) {
  if (!msg) return 0;

  let tokens = 4; // role + framing overhead

  if (typeof msg.content === "string") {
    tokens += enc.encode(msg.content).length;
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          tokens += enc.encode(block.text || "").length;
          break;
        case "tool_use":
          tokens += enc.encode(block.name || "").length;
          tokens += enc.encode(JSON.stringify(block.input || {})).length;
          tokens += 6;
          break;
        case "tool_result":
          tokens += enc.encode(block.tool_use_id || "").length;
          if (typeof block.content === "string") {
            tokens += enc.encode(block.content).length;
          } else if (Array.isArray(block.content)) {
            for (const c of block.content) {
              tokens += enc.encode(c.text || "").length;
            }
          }
          break;
        default:
          tokens += enc.encode(JSON.stringify(block)).length;
      }
    }
  }

  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      tokens += enc.encode(tc.function?.name || "").length;
      tokens += enc.encode(tc.function?.arguments || "").length;
      tokens += 8;
    }
  }

  return tokens;
}
