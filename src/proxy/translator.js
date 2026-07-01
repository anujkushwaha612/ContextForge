import crypto from "node:crypto";
// ========================================================
// 1. INBOUND TRANSLATION: Anthropic JSON -> OpenAI JSON
// ========================================================

// ─────────────────────────────────────────────
// Tool array cache
// One entry per unique tool set — keyed by fast integer fingerprint.
// Tools never change mid-session so this is a permanent cache.
// ─────────────────────────────────────────────

const _toolArrayCache = new Map();
const _TOOL_ARRAY_CACHE_MAX = 20;

function _toolArrayKey(tools) {
  let key = tools.length;
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const name = t.name || t.function?.name || "";
    const schemaStr = JSON.stringify(t.input_schema || t.parameters || {});
    // Hash name characters, not just length
    for (let j = 0; j < name.length; j++) {
      key = (key * 31 + name.charCodeAt(j)) | 0;
    }
    key = (key * 31 + schemaStr.length + i) | 0;
  }
  return key;
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
// Only useful for array-content messages (Anthropic format).
// String-content and already-translated messages hit fast paths
// before reaching the cache.
//
// Key: role + block count + first block fingerprint + last block fingerprint
// Avoids full JSON.stringify on the entire content array.
// ─────────────────────────────────────────────

const _msgCache = new Map();
const _MSG_CACHE_MAX = 500;

function _msgKey(msg) {
  const first = msg.content[0];
  const last = msg.content[msg.content.length - 1];
  const firstStr = first
    ? (first.type || "") +
      (first.text?.slice(0, 40) || first.tool_use_id || first.tool_call_id || "")
    : "";
  const lastStr = last
    ? (last.type || "") + (last.text?.slice(0, 40) || last.tool_use_id || last.tool_call_id || "")
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
    // Evict oldest entry
    _msgCache.delete(_msgCache.keys().next().value);
  }
  _msgCache.set(_msgKey(msg), translated);
}

// ─────────────────────────────────────────────
// Per-request prefix cache
//
// Stores the previous request's raw input messages and translated output.
// On each request, find how many messages at the START are identical
// to the previous request (stable prefix), translate only the suffix.
//
// System message is handled OUTSIDE this cache — it's prepended after
// translation so it doesn't interfere with prefix comparison.
//
// LATENCY OPTIMIZATION:
// In a typical agentic conversation, Claude sends the ENTIRE history
// every request. Only the last 1-2 messages are new. This prefix cache
// means we skip re-translating potentially hundreds of old messages —
// we just slice the already-translated output array and append the
// translation of only the new messages at the end.
// ─────────────────────────────────────────────

/**
 * Count how many OUTPUT messages the first N input messages produce.
 * Does NOT re-translate — inspects input shape only.
 *
 * Expansion rules:
 *   user with tool_results → (N tool messages) + (1 user message if has text)
 *   everything else        → 1 output message
 */
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

// Update _translateMessages to accept context:
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

  // Write back to context, not module-level variable
  ctx.prevInputMessages = messages;
  ctx.prevOutputMessages = translated;

  return translated;
}

// ─────────────────────────────────────────────
// Fast structural fingerprint for array content
// Avoids JSON.stringify on large tool result arrays.
// Checks: block count + first block type/id + last block type/id
// If all match, falls back to full stringify only on the
// first and last blocks (not the entire array).
// ─────────────────────────────────────────────
function _contentArrayEqual(cur, prev) {
  // Length already checked before this is called
  const len = cur.length;
  if (len === 0) return true;

  const first_c = cur[0];
  const first_p = prev[0];
  const last_c = cur[len - 1];
  const last_p = prev[len - 1];

  // ── Cheap structural checks ──
  // Type mismatch on first block — almost certainly different
  if (first_c?.type !== first_p?.type) return false;
  if (last_c?.type !== last_p?.type) return false;

  // Tool result blocks — compare by tool_use_id (unique per call)
  // If IDs match, content is the same call — no need to serialize content
  if (first_c?.type === "tool_result") {
    if (first_c.tool_use_id !== first_p.tool_use_id) return false;
    if (last_c.tool_use_id !== last_p.tool_use_id) return false;

    // IDs match on both ends — high confidence same array
    // Only do full check if array is small enough to be cheap
    if (len <= 4) {
      for (let i = 1; i < len - 1; i++) {
        if (cur[i]?.tool_use_id !== prev[i]?.tool_use_id) return false;
      }
    }
    return true;
  }

  // Text blocks — compare by text length + first 80 chars
  if (first_c?.type === "text") {
    if (first_c.text?.length !== first_p.text?.length) return false;
    if (last_c.text?.length !== last_p.text?.length) return false;
    if (first_c.text?.slice(0, 80) !== first_p.text?.slice(0, 80)) return false;
    if (last_c.text?.slice(0, 80) !== last_p.text?.slice(0, 80)) return false;
    return true;
  }

  // Unknown block type — fall back to stringify on first+last only
  // Still avoids serializing the entire middle of the array
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

    // Same object reference — identical (V8 short-circuits immediately)
    if (cur === prev) continue;

    // Role mismatch — stop
    if (cur.role !== prev.role) break;

    // String content — direct compare, no allocation
    if (typeof cur.content === "string" && typeof prev.content === "string") {
      if (cur.content !== prev.content) break;
      continue;
    }

    // Array content — structural fingerprint first, no full stringify
    if (Array.isArray(cur.content) && Array.isArray(prev.content)) {
      if (cur.content.length !== prev.content.length) break;
      if (!_contentArrayEqual(cur.content, prev.content)) break;
      continue;
    }

    // Mixed types — bail
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
  // ── Fast paths — no allocation, no cache lookup ──
  if (msg.role === "tool") return msg; // already OpenAI format
  if (msg.role === "system") return msg; // passthrough
  if (!Array.isArray(msg.content)) return msg; // already flat string content

  // ── Cache check (array-content only) ──
  const cached = _cacheGet(msg);
  if (cached) return cached;

  let result;

  // ── User message with tool_result blocks ──
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

  // ── Assistant message with tool_use blocks ──
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

  // ── Standard formatting (Text + Images) ──
  const hasImages = msg.content.some((b) => b.type === "image");
  if (hasImages) {
    const formattedContent = msg.content.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "thinking") return { type: "text", text: `<thinking>\n${b.thinking}\n</thinking>` };
      if (b.type === "image") {
        return {
          type: "image_url",
          image_url: {
            url: `data:${b.source.media_type};base64,${b.source.data}`,
          },
        };
      }
      return b; // passthrough unknown
    });
    result = { ...msg, content: formattedContent };
    _cacheSet(msg, result);
    return result;
  }

  // ── Text-only flattening ──
  const textContent = msg.content
    .filter((b) => b.type === "text" || b.type === "thinking")
    .map((b) => b.type === "thinking" ? `<thinking>\n${b.thinking}\n</thinking>` : b.text)
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
    // Use per-request context if provided, else no prefix caching
    const translatedMsgs = ctx
      ? _translateMessages(out.messages, ctx)
      : out.messages.map(_translateMessage).flat();

    out.messages = systemMessage ? [systemMessage, ...translatedMsgs] : translatedMsgs;
  } else if (systemMessage) {
    out.messages = [systemMessage];
  }

  if (Array.isArray(out.tools)) {
    out.tools = _sanitizeToolArray(out.tools);
    //     console.log(
    //       `[Tool Translator] 🛠️ Natively mapped ${out.tools.length} schemas`,
    //     );
  }

  return out;
}

/**
 * Validates and repairs OpenAI message sequence.
 * Returns { valid: boolean, issues: string[], messages: Message[] }
 *
 * Repair strategy (in order):
 *  1. Orphaned tool messages   → dropped
 *  2. tool_call_id mismatch    → remapped (1 candidate) or dropped (ambiguous)
 *  3. assistant content=""     → null when tool_calls present
 *  4. consecutive assistant    → merged
 *  5. consecutive user         → merged
 *  6. ends on bare assistant   → flagged only (not mutated)
 */
// export function validateAndRepairMessages(messages) {
//   const issues = [];
//   const fixed = [];

//   for (let i = 0; i < messages.length; i++) {
//     const msg = messages[i];
//     const prev = fixed[fixed.length - 1];

//     // ── Rule 1: tool message must follow assistant with tool_calls ──
//     if (msg.role === "tool") {
//       if (!prev || prev.role !== "assistant" || !prev.tool_calls?.length) {
//         issues.push(
//           `[${i}] orphaned tool message dropped (prev role: ${prev?.role ?? "none"})`,
//         );
//         continue;
//       }

//       // ── Rule 2: tool_call_id must match preceding assistant's tool_calls ──
//       if (msg.tool_call_id) {
//         const ids = prev.tool_calls.map((tc) => tc.id);
//         const exactMatch = ids.includes(msg.tool_call_id);

//         if (!exactMatch) {
//           if (ids.length === 1) {
//             // Only one candidate — unambiguous remap
//             issues.push(
//               `[${i}] tool_call_id remapped: "${msg.tool_call_id}" → "${ids[0]}"`,
//             );
//             fixed.push({ ...msg, tool_call_id: ids[0] });
//             continue;
//           }

//           // Multiple candidates — find best match by name if available
//           const msgName = msg.name;
//           if (msgName) {
//             const nameMatch = prev.tool_calls.find(
//               (tc) => tc.function?.name === msgName,
//             );
//             if (nameMatch) {
//               issues.push(
//                 `[${i}] tool_call_id remapped by name match "${msgName}": ` +
//                   `"${msg.tool_call_id}" → "${nameMatch.id}"`,
//               );
//               fixed.push({ ...msg, tool_call_id: nameMatch.id });
//               continue;
//             }
//           }

//           // Ambiguous — cannot safely remap, drop to prevent model confusion
//           issues.push(
//             `[${i}] tool_call_id "${msg.tool_call_id}" ambiguous across ` +
//               `[${ids.join(", ")}] — dropped`,
//           );
//           continue;
//         }
//       }
//     }

//     // ── Rule 3: assistant content="" → null when tool_calls present ──
//     if (msg.role === "assistant" && msg.tool_calls?.length > 0) {
//       if (msg.content === "" || msg.content === undefined) {
//         if (msg.content === "") {
//           issues.push(`[${i}] assistant content="" → null`);
//         }
//         fixed.push({ ...msg, content: null });
//         continue;
//       }
//     }

//     // ── Rule 4: no two assistant messages in a row ──
//     if (msg.role === "assistant" && prev?.role === "assistant") {
//       issues.push(`[${i}] consecutive assistant messages → merged`);
//       const last = fixed[fixed.length - 1];

//       const mergedContent =
//         [last.content, msg.content]
//           .filter((c) => c != null && c !== "")
//           .join("\n") || null;

//       const seenIds = new Set();
//       const mergedToolCalls = [
//         ...(last.tool_calls || []),
//         ...(msg.tool_calls || []),
//       ].filter((tc) => {
//         // Deduplicate tool_calls by id during merge
//         if (seenIds.has(tc.id)) return false;
//         seenIds.add(tc.id);
//         return true;
//       });

//       fixed[fixed.length - 1] = {
//         ...last,
//         content: mergedContent,
//         ...(mergedToolCalls.length ? { tool_calls: mergedToolCalls } : {}),
//       };
//       continue;
//     }

//     // ── Rule 5: no two user messages in a row ──
//     if (msg.role === "user" && prev?.role === "user") {
//       issues.push(`[${i}] consecutive user messages → merged`);
//       const last = fixed[fixed.length - 1];

//       // Handle both string and array content formats
//       const lastContent = Array.isArray(last.content)
//         ? last.content
//         : [{ type: "text", text: last.content ?? "" }];
//       const msgContent = Array.isArray(msg.content)
//         ? msg.content
//         : [{ type: "text", text: msg.content ?? "" }];

//       fixed[fixed.length - 1] = {
//         ...last,
//         content: [...lastContent, ...msgContent],
//       };
//       continue;
//     }

//     fixed.push(msg);
//   }

//   // ── Rule 6: flag if sequence ends on a bare assistant turn ──
//   const last = fixed[fixed.length - 1];
//   if (
//     last?.role === "assistant" &&
//     (!last.tool_calls || last.tool_calls.length === 0)
//   ) {
//     issues.push(`Sequence ends on bare assistant message — model may loop`);
//   }

//   if (issues.length > 0) {
//     console.warn(`[MsgValidator] ⚠️  Fixed ${issues.length} issue(s):`);
//     for (const issue of issues) console.warn(`  • ${issue}`);
//   }

//   return { valid: issues.length === 0, issues, messages: fixed };
// }

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

const _toolSchemaCacheMap = new Map();

// Wrap minimizeToolSchemas:
export function minimizeToolSchemas(payload) {
  if (!payload.tools || payload.tools.length === 0) return payload;

  // Hash the current tools array
  const toolsJson = JSON.stringify(payload.tools);
  const hash = crypto.createHash("sha256").update(toolsJson).digest("hex").slice(0, 16);

  if (_toolSchemaCacheMap.has(hash)) {
    const cachedTools = _toolSchemaCacheMap.get(hash);

    // ── Stamp savings on cache hit so pipeline reporting is accurate ──
    // Previously cache hits returned silently with no savings stamp.
    // This caused the dashboard to show 0 minimize savings on turn 2+
    // even though the tools ARE being served in minimized form.
    const originalSize = toolsJson.length;
    const cachedSize = JSON.stringify(cachedTools).length;
    const savedTokens = Math.floor((originalSize - cachedSize) / 4);
    if (savedTokens > 0) {
      payload._cf_minimizeTokensSaved = savedTokens;
    }

    payload.tools = cachedTools;
    return payload;
  }

  // ... existing minimization logic unchanged ...
  const originalSize = toolsJson.length;

  payload.tools = payload.tools.map((tool) => {
    const fn = tool.function || tool;

    // Deep clone to safely mutate
    const newFn = JSON.parse(JSON.stringify(fn));

    // Recursive function to minimize descriptions but keep structure intact
    function minimizeSchema(schema) {
      if (!schema) return;
      if (schema.description) {
        schema.description = schema.description.slice(0, 80);
      }
      if (schema.properties) {
        for (const key of Object.keys(schema.properties)) {
          minimizeSchema(schema.properties[key]);
        }
      }
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

  // Cache the result
  _toolSchemaCacheMap.set(hash, payload.tools);

  //   console.log(
  //     `[Tool Minimizer] ${originalSize} → ${newSize} chars ` +
  //       `(saved ~${savedTokens} tokens across ${payload.tools.length} tools) [cached as ${hash}]`,
  //   );

  // FIX F5: Stamp savings for observability and baseline derivation
  payload._cf_minimizeTokensSaved = savedTokens;

  return payload;
}

// ========================================================
// 3. STREAM TRANSLATOR: OpenAI Server Deltas -> Anthropic SSE
// ========================================================
export function translateOpenAISSEToAnthropic(openAIData, messageId, isFirst, toolState) {
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
      })}\n\n`
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
        })}\n\n`
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
        })}\n\n`
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
          })}\n\n`
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
            })}\n\n`
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
          })}\n\n`
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
          })}\n\n`
        );
      }
    }
  }

  // ── Finish Reason Handling ──
  // Close text block on finish_reason — tool blocks close at [DONE]
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
