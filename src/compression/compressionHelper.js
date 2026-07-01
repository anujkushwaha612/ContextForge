/**
 * compressionHelper.js
 *
 * Token counting for the ContextForge pipeline.
 *
 * Uses tiktoken cl100k_base as an approximation.
 * Note: Claude uses a different tokenizer — counts are approximate
 * but systematic errors cancel in relative comparisons (before vs after).
 *
 * Fixes applied:
 *   CH-1: Lazy encoder initialization with char/4 fallback if tiktoken
 *         fails to load. Previously crashed the server at import time.
 *
 *   CH-4: Tools token count cached by a lightweight structural key
 *         to avoid repeated JSON.stringify + tiktoken on every countTokens
 *         call within the same request.
 *
 *   CH-7: scrubToolResults must use object spread not direct mutation.
 *         See toolScrubber.js fix below.
 */

import { get_encoding } from "tiktoken";

// ─────────────────────────────────────────────
// CH-1: Lazy encoder with fallback
// ─────────────────────────────────────────────

let _enc = null;

function getEncoder() {
  if (_enc) return _enc;
  try {
    _enc = get_encoding("cl100k_base");
  } catch (err) {
    console.warn(
      `[TokenCounter] ⚠️ tiktoken failed to load: ${err.message}. ` +
      `Using char/4 approximation fallback.`
    );
    // Stub that approximates token count from character count.
    // 4 chars/token is the standard heuristic for English/code text.
    _enc = {
      encode: (text) => ({ length: Math.ceil((text || "").length / 4) }),
    };
  }
  return _enc;
}

// Token overhead constants (approximate, based on OpenAI/Anthropic wire format)
const MESSAGE_OVERHEAD = 4; // role + framing per message

// ─────────────────────────────────────────────
// CH-4: Tools token cache
//
// Tools arrays change only when tools are injected (graph inject, CCR).
// Cache by a structural key: tool count + first tool name + last tool name.
// This is O(1) to compute and correctly detects injection of new tools.
// Cache is bounded and cleared when it grows too large.
// ─────────────────────────────────────────────

const _toolsTokenCache = new Map();
const TOOLS_CACHE_MAX  = 30;

function countToolsTokens(tools) {
  if (!tools || tools.length === 0) return 0;

  // Structural key: count + names of first and last tool
  // Sufficient to detect tool injection without full stringify
  const firstName = tools[0]?.function?.name  || tools[0]?.name  || "";
  const lastName  = tools[tools.length - 1]?.function?.name || tools[tools.length - 1]?.name || "";
  const key       = `${tools.length}:${firstName}:${lastName}`;

  if (_toolsTokenCache.has(key)) return _toolsTokenCache.get(key);

  const count = getEncoder().encode(JSON.stringify(tools)).length;

  if (_toolsTokenCache.size >= TOOLS_CACHE_MAX) {
    // Clear on overflow — tools arrays are small in count so this is rare
    _toolsTokenCache.clear();
  }
  _toolsTokenCache.set(key, count);

  return count;
}

// ─────────────────────────────────────────────
// countTokens — full payload
// ─────────────────────────────────────────────

/**
 * Counts tokens in a complete payload (messages + tools).
 * Handles both OpenAI and Anthropic shapes.
 *
 * @param {object} payload
 * @returns {number}
 */
export function countTokens(payload) {
  if (!payload) return 0;

  let tokens = 0;
  const enc  = getEncoder();

  // System prompt (Anthropic format — separate from messages)
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

  // Tool definitions — CH-4: cached by structural key
  if (payload.tools) {
    tokens += countToolsTokens(payload.tools);
  }

  return tokens;
}

// ─────────────────────────────────────────────
// countMessageTokens — single message
//
// Caches result on the message object as a non-enumerable property.
// Cache is automatically invalidated when a stage creates a new message
// object via spread ({ ...msg, content: newContent }) — non-enumerable
// properties are dropped by object spread.
//
// IMPORTANT: Pipeline stages MUST use object spread to mutate messages.
// Direct property mutation (msg.content = x) bypasses cache invalidation.
// See scrubToolResults fix (CH-7) for the corrected pattern.
// ─────────────────────────────────────────────

/**
 * @param {object} msg
 * @returns {number}
 */
export function countMessageTokens(msg) {
  if (!msg) return 0;

  // Return cached count if this exact message object was already counted
  if (msg._cachedTokens !== undefined) {
    return msg._cachedTokens;
  }

  const enc  = getEncoder();
  let tokens = MESSAGE_OVERHEAD; // role + framing overhead

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
          tokens += 6; // tool_use framing overhead
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

  // OpenAI format tool calls
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      tokens += enc.encode(tc.function?.name      || "").length;
      tokens += enc.encode(tc.function?.arguments || "").length;
      tokens += 8; // tool_call framing overhead
    }
  }

  // Cache on the object as non-enumerable so spread drops it
  Object.defineProperty(msg, "_cachedTokens", {
    value:        tokens,
    enumerable:   false,
    configurable: true,
    writable:     true,
  });

  return tokens;
}