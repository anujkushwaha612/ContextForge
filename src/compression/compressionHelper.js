/**
 * compressionHelper.js
 *
 * Token counting for the ContextForge pipeline.
 *
 * Uses tiktoken cl100k_base as an approximation.
 *
 * CH-1: Lazy encoder initialization with char/4 fallback if tiktoken fails.
 *
 * CH-2: Tools token cache key now includes second tool name to discriminate
 *       tool sets that share the same count, first, and last tool name but
 *       differ in middle tools (e.g. after CCR inserts a retrieve tool).
 *
 * CH-3: _cachedTokens non-enumerable invalidation documented as latently
 *       fragile — direct mutation bypasses it. Pipeline stages must use
 *       object spread.
 *
 * CH-4: Tools counted as flat JSON — systematic undercount but consistent
 *       before/after so relative savings are valid. Absolute numbers are
 *       estimates; labeled accordingly in display output.
 *
 * NOTE: cl100k_base is GPT-4's tokenizer. Claude uses a different BPE
 * vocabulary. Absolute token counts are estimates (~10-15% off from
 * Claude's actual count). Relative before/after savings ratios are
 * reliable because the systematic error cancels in subtraction.
 * All displayed absolute counts should be treated as approximations.
 */

import { get_encoding } from "tiktoken";

// ─────────────────────────────────────────────
// Lazy encoder with fallback
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
    // 4 chars/token is the standard heuristic for English/code text.
    _enc = {
      encode: (text) => ({ length: Math.ceil((text || "").length / 4) }),
    };
  }
  return _enc;
}

const MESSAGE_OVERHEAD = 4;

// ─────────────────────────────────────────────
// Tools token cache
//
// CH-2 FIX: Key now includes second tool name in addition to first and last.
// Prevents collisions when tool sets share count + endpoint names but differ
// in middle tools (common after CCR inserts a contextforge_retrieve tool).
//
// Key structure: "count:first:second:last"
// Still O(1) to compute. Covers the most common injection pattern where
// new tools are inserted at position 1 (between existing first and rest).
// ─────────────────────────────────────────────

const _toolsTokenCache = new Map();
const TOOLS_CACHE_MAX = 30;

function countToolsTokens(tools) {
  if (!tools || tools.length === 0) return 0;

  const getName = (t) => t?.function?.name || t?.name || "";
  const getDescLen = (t) => {
    const fn = t?.function || t;
    return (
      (fn?.description?.length ?? 0) +
      (fn?.parameters?.properties
        ? Object.values(fn.parameters.properties).reduce(
            (sum, p) => sum + (p?.description?.length ?? 0),
            0
          )
        : 0)
    );
  };

  const firstName = getName(tools[0]);
  const secondName = tools.length > 1 ? getName(tools[1]) : "";
  const lastName = getName(tools[tools.length - 1]);
  
  const toolsJson = JSON.stringify(tools);
  const key = `${tools.length}:${firstName}:${secondName}:${lastName}:${toolsJson.length}`;

  if (_toolsTokenCache.has(key)) return _toolsTokenCache.get(key);

  const count = getEncoder().encode(toolsJson).length;

  if (_toolsTokenCache.size >= TOOLS_CACHE_MAX) {
    _toolsTokenCache.clear();
  }
  _toolsTokenCache.set(key, count);

  return count;
}

// ─────────────────────────────────────────────
// countTokens — full payload
// ─────────────────────────────────────────────

export function countTokens(payload) {
  if (!payload) return 0;

  let tokens = 0;
  const enc = getEncoder();

  if (payload.system) {
    tokens += enc.encode(
      typeof payload.system === "string" ? payload.system : JSON.stringify(payload.system)
    ).length;
    tokens += MESSAGE_OVERHEAD;
  }

  if (payload.messages) {
    for (const msg of payload.messages) {
      tokens += countMessageTokens(msg);
    }
  }

  if (payload.tools) {
    tokens += countToolsTokens(payload.tools);
  }

  return tokens;
}

// ─────────────────────────────────────────────
// countMessageTokens — single message
//
// Caches result on the message object as a non-enumerable property.
// Cache invalidated automatically when pipeline stages use object spread
// ({ ...msg, content: newContent }) — spread drops non-enumerable properties.
//
// INVARIANT: Pipeline stages MUST use object spread to create modified
// messages. Direct mutation (msg.content = x) bypasses cache invalidation
// and will return stale counts on subsequent calls.
// ─────────────────────────────────────────────

export function countMessageTokens(msg) {
  if (!msg) return 0;

  if (msg._cachedTokens !== undefined) {
    return msg._cachedTokens;
  }

  const enc = getEncoder();
  let tokens = MESSAGE_OVERHEAD;

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

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      tokens += enc.encode(tc.function?.name || "").length;
      tokens += enc.encode(tc.function?.arguments || "").length;
      tokens += 8;
    }
  }

  Object.defineProperty(msg, "_cachedTokens", {
    value: tokens,
    enumerable: false,
    configurable: true,
    writable: true,
  });

  return tokens;
}
