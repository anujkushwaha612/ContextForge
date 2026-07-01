import crypto from "node:crypto";

// ========================================================
// 1. INBOUND TRANSLATION: Anthropic JSON -> OpenAI JSON
// ========================================================

// ─────────────────────────────────────────────
// Tool array cache
//
// TR-3 FIX: _toolArrayKey now hashes full schema CONTENT, not just
// schema string length. Previously two tools with identical names and
// schema lengths but different schema content produced the same key,
// causing stale minimized schemas to be served.
// ─────────────────────────────────────────────

const _toolArrayCache = new Map();
const _TOOL_ARRAY_CACHE_MAX = 20;

function _toolArrayKey(tools) {
  // Two independent FNV-1a 32-bit lanes over full content
  // (same implementation as fixed fnv1a64 in semanticDedup.js)
  let h1 = 0x811c9dc5;
  let h2 = 0x4b9ace2f;

  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const name = t.name || t.function?.name || "";
    // TR-3 FIX: Hash full schema content, not just length
    const schemaStr = JSON.stringify(t.input_schema || t.parameters || {});
    const combined = `${i}:${name}:${schemaStr}`;

    for (let j = 0; j < combined.length; j++) {
      const c = combined.charCodeAt(j);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= c;
      h2 = Math.imul(h2, 0x01000193) >>> 0;
    }
  }

  return `${h1.toString(16).padStart(8, "0")}_${h2.toString(16).padStart(8, "0")}`;
}

function _sanitizeToolArray(tools) {
  const key = _toolArrayKey(tools);
  if (_toolArrayCache.has(key)) return _toolArrayCache.get(key);

  const sanitized = tools.map(_sanitizeTool);

  if (_toolArrayCache.size >= _TOOL_ARRAY_CACHE_MAX) {
    _toolArrayCache.delete(_toolArrayCache.keys().next().value);
  }
  _toolArrayCache.set(key, sanitized);
  return sanitized;
}

// ─────────────────────────────────────────────
// Per-message cache
// ─────────────────────────────────────────────

const _msgCache = new Map();
const _MSG_CACHE_MAX = 500;

function _msgKey(msg) {
  const first = msg.content[0];
  const last = msg.content[msg.content.length - 1];
  const firstStr = first
    ? (first.type || "") +
      (first.text?.slice(0, 40) || first.id || first.tool_use_id || first.tool_call_id || "")
    : "";
  const lastStr = last
    ? (last.type || "") +
      (last.text?.slice(0, 40) || last.id || last.tool_use_id || last.tool_call_id || "")
    : "";
  return msg.role + "|" + msg.content.length + "|" + firstStr + "|" + lastStr;
}

function _cacheGet(msg) {
  if (!Array.isArray(msg.content)) return null;
  return _msgCache.get(_msgKey(msg)) ?? null;
}

function _cacheSet(msg, translated) {
  if (!Array.isArray(msg.content)) return;
  if (_msgCache.size >= _MSG_CACHE_MAX) {
    _msgCache.delete(_msgCache.keys().next().value);
  }
  _msgCache.set(_msgKey(msg), translated);
}

// ─────────────────────────────────────────────
// Per-request prefix cache
// ─────────────────────────────────────────────

function _countOutputMessages(inputSlice) {
  let count = 0;
  for (const msg of inputSlice) {
    if (
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      msg.content.some((b) => b.type === "tool_result")
    ) {
      const toolCount = msg.content.filter((b) => b.type === "tool_result").length;
      const hasText = msg.content.some((b) => b.type === "text" && b.text?.trim());
      count += toolCount + (hasText ? 1 : 0);
    } else {
      count += 1;
    }
  }
  return count;
}

export function createTranslationContext() {
  return {
    prevInputMessages: null,
    prevOutputMessages: null,
  };
}

function _translateMessages(messages, ctx) {
  const stableCount = _findStablePrefix(messages, ctx);

  let translated;

  if (stableCount === 0) {
    translated = messages.map(_translateMessage).flat();
  } else if (stableCount === messages.length) {
    translated = ctx.prevOutputMessages;
  } else {
    const stableOutputCount = _countOutputMessages(ctx.prevInputMessages.slice(0, stableCount));
    const stableOutputPrefix = ctx.prevOutputMessages.slice(0, stableOutputCount);
    const newSuffix = messages.slice(stableCount).map(_translateMessage).flat();
    translated = [...stableOutputPrefix, ...newSuffix];
  }

  ctx.prevInputMessages = messages;
  ctx.prevOutputMessages = translated;

  return translated;
}

// ─────────────────────────────────────────────
// Structural equality for array content
//
// TR-2 FIX: Tool result equality check now includes content length
// verification. Previously assumed same tool_use_id = same content,
// which could cause false stable-prefix matches when the ghost interceptor
// reuses tool call IDs across hops with different result content.
// ─────────────────────────────────────────────

function _contentArrayEqual(cur, prev) {
  const len = cur.length;
  if (len === 0) return true;

  const first_c = cur[0];
  const first_p = prev[0];
  const last_c = cur[len - 1];
  const last_p = prev[len - 1];

  if (first_c?.type !== first_p?.type) return false;
  if (last_c?.type !== last_p?.type) return false;

  if (first_c?.type === "tool_result") {
    if (first_c.tool_use_id !== first_p.tool_use_id) return false;
    if (last_c.tool_use_id !== last_p.tool_use_id) return false;

    // TR-2 FIX: Also verify content length. Same tool_use_id with different
    // content length means the result changed (e.g. ghost interceptor reuse).
    const getLen = (block) =>
      typeof block.content === "string"
        ? block.content.length
        : JSON.stringify(block.content ?? "").length;

    if (getLen(first_c) !== getLen(first_p)) return false;
    if (getLen(last_c) !== getLen(last_p)) return false;

    if (len <= 4) {
      for (let i = 1; i < len - 1; i++) {
        if (cur[i]?.tool_use_id !== prev[i]?.tool_use_id) return false;
        if (getLen(cur[i]) !== getLen(prev[i])) return false;
      }
    }
    return true;
  }

  if (first_c?.type === "text") {
    if (first_c.text?.length !== first_p.text?.length) return false;
    if (last_c.text?.length !== last_p.text?.length) return false;
    if (first_c.text?.slice(0, 80) !== first_p.text?.slice(0, 80)) return false;
    if (last_c.text?.slice(0, 80) !== last_p.text?.slice(0, 80)) return false;
    return true;
  }

  if (JSON.stringify(first_c) !== JSON.stringify(first_p)) return false;
  if (JSON.stringify(last_c) !== JSON.stringify(last_p)) return false;
  return true;
}

function _findStablePrefix(currentMsgs, ctx) {
  if (!ctx.prevInputMessages || !ctx.prevOutputMessages) return 0;

  const maxCheck = Math.min(currentMsgs.length, ctx.prevInputMessages.length);
  let i = 0;

  for (; i < maxCheck; i++) {
    const cur = currentMsgs[i];
    const prev = ctx.prevInputMessages[i];

    if (cur === prev) continue;
    if (cur.role !== prev.role) break;

    if (typeof cur.content === "string" && typeof prev.content === "string") {
      if (cur.content !== prev.content) break;
      continue;
    }

    if (Array.isArray(cur.content) && Array.isArray(prev.content)) {
      if (cur.content.length !== prev.content.length) break;
      if (!_contentArrayEqual(cur.content, prev.content)) break;
      continue;
    }

    break;
  }

  return i;
}

// ─────────────────────────────────────────────
// Tool schema sanitization
// ─────────────────────────────────────────────

const _toolCache = new Map();

function _sanitizeTool(tool) {
  const schemaStr = JSON.stringify(tool.input_schema || tool.parameters || {});
  const cacheKey =
    (tool.name || tool.function?.name || "") +
    "|" +
    schemaStr.length +
    "|" +
    schemaStr.slice(0, 64);

  if (_toolCache.has(cacheKey)) return _toolCache.get(cacheKey);

  const params = JSON.parse(schemaStr);
  _stripJsonSchemaMeta(params);

  const sanitized = {
    type: "function",
    function: {
      name: tool.name || tool.function?.name,
      description: tool.description || tool.function?.description,
      parameters: params,
    },
  };

  _toolCache.set(cacheKey, sanitized);
  return sanitized;
}

function _stripJsonSchemaMeta(obj) {
  if (!obj || typeof obj !== "object") return;

  delete obj.$schema;
  delete obj.$defs;
  delete obj.$id;
  delete obj.$comment;

  if (obj.properties && typeof obj.properties === "object") {
    for (const prop of Object.values(obj.properties)) {
      _stripJsonSchemaMeta(prop);
    }
  }

  if (obj.items && typeof obj.items === "object") {
    _stripJsonSchemaMeta(obj.items);
  }

  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(obj[key])) {
      for (const entry of obj[key]) _stripJsonSchemaMeta(entry);
    }
  }
}

// ─────────────────────────────────────────────
// Per-message translation
// ─────────────────────────────────────────────

function _translateMessage(msg) {
  if (msg.role === "tool") return msg;
  if (msg.role === "system") return msg;
  if (!Array.isArray(msg.content)) return msg;

  const cached = _cacheGet(msg);
  if (cached) return cached;

  let result;

  if (msg.role === "user" && msg.content.some((b) => b.type === "tool_result")) {
    const toolMessages = [];
    const textParts = [];

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        const content = Array.isArray(block.content)
          ? block.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n")
          : block.content || "";

        toolMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          ...(block.name ? { name: block.name } : {}),
          content,
        });
      } else if (block.type === "text" && block.text?.trim()) {
        textParts.push(block.text);
      }
    }

    if (textParts.length > 0) {
      toolMessages.push({ role: "user", content: textParts.join("\n") });
    }

    result = toolMessages;
    _cacheSet(msg, result);
    return result;
  }

  if (msg.role === "assistant" && msg.content.some((b) => b.type === "tool_use")) {
    const textParts = [];
    const tool_calls = [];

    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "thinking" && block.thinking) {
        textParts.push(`<thinking>\n${block.thinking}\n</thinking>`);
      } else if (block.type === "tool_use") {
        tool_calls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments:
              typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}),
          },
        });
      }
    }

    result = {
      role: "assistant",
      content: textParts.join("\n") || null,
      tool_calls,
    };
    _cacheSet(msg, result);
    return result;
  }

  const hasImages = msg.content.some((b) => b.type === "image");
  if (hasImages) {
    const formattedContent = msg.content.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "thinking")
        return {
          type: "text",
          text: `<thinking>\n${b.thinking}\n</thinking>`,
        };
      if (b.type === "image") {
        return {
          type: "image_url",
          image_url: {
            url: `data:${b.source.media_type};base64,${b.source.data}`,
          },
        };
      }
      return b;
    });
    result = { ...msg, content: formattedContent };
    _cacheSet(msg, result);
    return result;
  }

  const textContent = msg.content
    .filter((b) => b.type === "text" || b.type === "thinking")
    .map((b) => (b.type === "thinking" ? `<thinking>\n${b.thinking}\n</thinking>` : b.text))
    .join("\n");

  result = { ...msg, content: textContent };
  _cacheSet(msg, result);
  return result;
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

export function translateAnthropicToOpenAI(payload, ctx = null) {
  const out = { ...payload };

  let systemMessage = null;
  if (out.system) {
    const sysContent = Array.isArray(out.system)
      ? out.system
          .filter((s) => s.type === "text")
          .map((s) => s.text)
          .join("\n")
      : out.system;
    systemMessage = { role: "system", content: sysContent };
    delete out.system;
  }

  if (out.messages) {
    const translatedMsgs = ctx
      ? _translateMessages(out.messages, ctx)
      : out.messages.map(_translateMessage).flat();

    out.messages = systemMessage ? [systemMessage, ...translatedMsgs] : translatedMsgs;
  } else if (systemMessage) {
    out.messages = [systemMessage];
  }

  if (Array.isArray(out.tools)) {
    out.tools = _sanitizeToolArray(out.tools);
  }

  return out;
}

// ========================================================
// 2. STRIP ANTHROPIC NON-STANDARD ROOT PARAMETERS
// ========================================================

export function stripAnthropicSpecificFields(payload) {
  const {
    anthropic_version,
    context_management,
    metadata,
    stop_sequences,
    output_config,
    thinking,
    prompt_cache_key,
    ...cleaned
  } = payload;
  return cleaned;
}

// ─────────────────────────────────────────────
// minimizeToolSchemas
//
// TR-4 FIX: ContextForge tool descriptions are never truncated.
// These descriptions contain usage instructions referenced by compression
// stubs injected into tool results (e.g. "use contextforge_retrieve with
// vault_id=..."). Truncating them to 80 chars cuts the instructions the
// LLM needs to follow vault retrieval correctly.
//
// TR-6 NOTE: The prefix cache (createTranslationContext / _translateMessages)
// is implemented and correct but requires the adapter to pass a ctx object
// through toInternal(). Without ctx, translation falls back to per-message
// cache only. Activating the prefix cache requires adapter-level changes
// outside this file — documented here for the next audit pass.
// ─────────────────────────────────────────────

const _toolSchemaCacheMap = new Map();

// ─────────────────────────────────────────────
// Tools whose descriptions must be fully preserved.
//
// AskUserQuestion: truncating changes when the LLM decides
//   to ask vs proceed — behavioral regression risk.
// Agent: complex orchestration instructions, truncating breaks
//   sub-agent delegation behavior.
// All CF tools: contain vault retrieval instructions that
//   compression stubs reference by exact wording (TR-4).
// ─────────────────────────────────────────────
const PRESERVE_FULL_DESCRIPTION = new Set(["AskUserQuestion", "Agent"]);

const MAX_TOOL_DESCRIPTION_CHARS = 200;
const MAX_PARAM_DESCRIPTION_CHARS = 80;

export function minimizeToolSchemas(payload) {
  if (!payload.tools || payload.tools.length === 0) return payload;

  const toolsJson = JSON.stringify(payload.tools);
  const hash = crypto.createHash("sha256").update(toolsJson).digest("hex").slice(0, 16);

  if (_toolSchemaCacheMap.has(hash)) {
    const cachedTools = _toolSchemaCacheMap.get(hash);

    const originalSize = toolsJson.length;
    const cachedSize = JSON.stringify(cachedTools).length;
    const savedTokens = Math.floor((originalSize - cachedSize) / 4);
    if (savedTokens > 0) {
      payload._cf_minimizeTokensSaved = savedTokens;
    }

    payload.tools = cachedTools;
    return payload;
  }

  const originalSize = toolsJson.length;

  payload.tools = payload.tools.map((tool) => {
    const fn = tool.function || tool;
    const toolName = fn.name || tool.name || "";

    // Determine if this tool's descriptions should be fully preserved
    const isCFTool =
      toolName.includes("contextforge") ||
      toolName.includes("mcp__contextforge") ||
      toolName.startsWith("cf_");

    // isProtected = never truncate description or params
    const isProtected = isCFTool || PRESERVE_FULL_DESCRIPTION.has(toolName);

    const newFn = JSON.parse(JSON.stringify(fn));

    // ── Top-level tool description ──────────────────────────────────────
    // Protected tools: keep in full.
    // All others: truncate to MAX_TOOL_DESCRIPTION_CHARS.
    // The LLM knows how to use Bash, Glob, Grep etc from training —
    // it does not need the full description on every request.
    if (!isProtected && typeof newFn.description === "string") {
      if (newFn.description.length > MAX_TOOL_DESCRIPTION_CHARS) {
        newFn.description = newFn.description.slice(0, MAX_TOOL_DESCRIPTION_CHARS) + "…";
      }
    }

    // ── Parameter schema minimization ───────────────────────────────────
    function minimizeSchema(schema) {
      if (!schema || typeof schema !== "object") return;

      // Truncate parameter descriptions for non-protected tools.
      // LLM infers parameter meaning from name + type + required list.
      if (!isProtected && typeof schema.description === "string") {
        if (schema.description.length > MAX_PARAM_DESCRIPTION_CHARS) {
          schema.description = schema.description.slice(0, MAX_PARAM_DESCRIPTION_CHARS) + "…";
        }
      }

      // Strip large enum arrays for non-protected tools.
      // Keep enums with < 5 values — cheap and provide validation hints.
      // Keep enums for CF tools — query_type enum is how LLM knows
      // which graph operations are available.
      if (!isProtected && Array.isArray(schema.enum) && schema.enum.length >= 5) {
        delete schema.enum;
      }

      // Recurse into nested properties
      if (schema.properties) {
        for (const key of Object.keys(schema.properties)) {
          minimizeSchema(schema.properties[key]);
        }
      }

      // Recurse into array items
      if (schema.items) {
        minimizeSchema(schema.items);
      }
    }

    if (newFn.parameters) {
      minimizeSchema(newFn.parameters);
    }

    return {
      type: "function",
      function: newFn,
    };
  });

  const newSize = JSON.stringify(payload.tools).length;
  const savedChars = originalSize - newSize;
  const savedTokens = Math.floor(savedChars / 4);

  _toolSchemaCacheMap.set(hash, payload.tools);

  if (savedTokens > 0) {
    payload._cf_minimizeTokensSaved = savedTokens;
  }

  return payload;
}

// ========================================================
// 3. STREAM TRANSLATOR: OpenAI Server Deltas -> Anthropic SSE
// ========================================================

export function translateOpenAISSEToAnthropic(openAIData, messageId, isFirst, toolState) {
  const events = [];

  if (toolState.nextBlockIndex === undefined) {
    toolState.nextBlockIndex = 0;
    toolState.textBlockIndex = -1;
    toolState.currentToolIndex = -1;
  }

  if (openAIData.trim() === "[DONE]") {
    if (toolState.inToolCall && toolState.currentToolIndex >= 0) {
      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: toolState.currentToolIndex,
        })}\n\n`
      );
      events.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 0 },
        })}\n\n`
      );
    } else {
      if (toolState.inTextBlock && toolState.textBlockIndex >= 0) {
        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: toolState.textBlockIndex,
          })}\n\n`
        );
      }
      let finalStopReason = "end_turn";
      if (toolState.finishReason === "length") finalStopReason = "max_tokens";

      events.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: finalStopReason, stop_sequence: null },
          usage: { output_tokens: 0 },
        })}\n\n`
      );
    }
    events.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    return events;
  }

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
      })}\n\n`
    );
    events.push(`event: ping\ndata: {"type":"ping"}\n\n`);
  }

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
        })}\n\n`
      );
    }

    if (toolState.inTextBlock && toolState.textBlockIndex >= 0) {
      events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: toolState.textBlockIndex,
          delta: { type: "text_delta", text: combinedText },
        })}\n\n`
      );
    }
  }

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (toolState.inTextBlock && !toolState.inToolCall) {
        toolState.inTextBlock = false;
        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: toolState.textBlockIndex,
          })}\n\n`
        );
      }

      if (tc.id && tc.function?.name) {
        if (toolState.inToolCall && toolState.currentToolIndex >= 0) {
          events.push(
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: toolState.currentToolIndex,
            })}\n\n`
          );
        }

        toolState.inToolCall = true;
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
          })}\n\n`
        );
      }

      if (tc.function?.arguments && toolState.currentToolIndex >= 0) {
        events.push(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: toolState.currentToolIndex,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments,
            },
          })}\n\n`
        );
      }
    }
  }

  if (finishReason && finishReason !== "null") {
    toolState.finishReason = finishReason;
    if (toolState.inTextBlock && toolState.textBlockIndex >= 0) {
      toolState.inTextBlock = false;
      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: toolState.textBlockIndex,
        })}\n\n`
      );
    }
  }

  return events;
}
