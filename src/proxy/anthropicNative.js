/**
 * anthropicNative.js
 *
 * PC-3 (provider-cache audit): native Anthropic /v1/messages egress.
 *
 * WHY THIS EXISTS
 * ---------------
 * Anthropic's prompt caching is explicit: the client (Claude Code) marks
 * stable prefix blocks with `cache_control: { type: "ephemeral" }` (up to
 * 4 breakpoints). The provider then byte-matches the prefix up to each
 * breakpoint; reads bill at 0.1× input, writes at 1.25× (5-min TTL).
 *
 * The pre-existing anthropic provider sent our OpenAI-format body to
 * Anthropic's OpenAI-compat endpoint — which does NOT support prompt
 * caching (documented in providers/anthropic.js). Consequence: a Claude
 * Code session behind ContextForge got ZERO cache hits on the real
 * Anthropic API while paying full input price every turn — ContextForge
 * was literally destroying the provider's caching for the user.
 *
 * This module provides the native egress (opt-in, CF_ANTHROPIC_NATIVE=1,
 * provider=anthropic, client=anthropic):
 *
 *   1. REQUEST — the client's original `system` blocks and `tools` are
 *      forwarded BYTE-VERBATIM (including every client cache_control
 *      marker and tool-level marker). ContextForge's own additions are
 *      APPENDED AFTER the client's content:
 *        - the CF rule as a new trailing system block (no marker — the
 *          client's up-to-4 markers are untouched; our block sits outside
 *          the marked prefix, so it costs 1.0× input, never a cache
 *          write, and never invalidates the client's breakpoint),
 *        - the ContextForge tools after the client's tools (same order
 *          every turn — see stableTools.js — so the appended region is
 *          byte-stable too).
 *      Messages come from the (compressed) internal pipeline output,
 *      converted back to native blocks. Conversation-level fields the
 *      client sent (metadata, thinking, max_tokens, temperature,
 *      stop_sequences, service_tier, anthropic-beta) are passed through
 *      untouched — `metadata.user_id` matters because Anthropic keys
 *      some cache routing on it.
 *
 *   2. RESPONSE (streaming) — native SSE is forwarded to the client
 *      EVENT-VERBATIM (the client speaks native; no re-translation, no
 *      reformatting, no re-serialization). Events are simultaneously fed
 *      to NativeSSEAssembler so the Ghost Interceptor can detect
 *      background tool_use blocks (contextforge_query_graph /
 *      contextforge_patch_ast / contextforge_retrieve / memory_*):
 *        - no background tool_use  → the held events are flushed to the
 *          client verbatim (pure passthrough, including real usage and
 *          real Anthropic response headers);
 *        - background tool_use     → events are dropped, the tool call is
 *          executed locally, appended to the internal payload, and the
 *          NEXT hop is re-serialized natively by the same builder
 *          (byte-stable prefix again).
 *      Text blocks forward immediately (streaming UX); once a tool_use
 *      block starts, everything is held until message_stop (the same
 *      hold-until-classification design the OpenAI path uses).
 *
 *   3. RESPONSE (non-streaming) — passthrough JSON unless it contains a
 *      background tool_use, in which case it is parsed to internal
 *      messages and the ghost hop runs.
 *
 *   4. USAGE — native usage carries cache_read_input_tokens /
 *      cache_creation_input_tokens natively; the acc accounting in
 *      upstreamRequest.js consumes the same shape normalizeUsage
 *      produces, so cache-read tokens now actually land in the
 *      savings/dashboard metrics for Anthropic sessions.
 *
 * ECONOMICS NOTE (why compressing history is still right here):
 * our compression rewrites history messages — a one-time prefix change
 * per content change, after which the wire is byte-stable and the
 * provider re-caches. Write premium 1.25× vs the 0.9×/turn saved on the
 * compressed tokens breaks even after ~1-2 turns of a live session.
 * What this module guarantees is that ContextForge adds NO OTHER
 * instability: the client's marked prefix bytes are never touched.
 */

import { getContextForgeRule } from "./systemMessages.js";

// ─────────────────────────────────────────────
// Mode gate
// ─────────────────────────────────────────────

/**
 * Native egress is an explicit opt-in (compat endpoint users are not
 * broken by default) and only applies when BOTH sides speak native
 * Anthropic: the upstream provider is anthropic AND the client speaks
 * the Anthropic Messages format.
 */
export function isNativeAnthropicEgress({ providerName, clientAdapterName }) {
  if (process.env.CF_ANTHROPIC_NATIVE !== "1") return false;
  return providerName === "anthropic" && clientAdapterName === "anthropic";
}

// ─────────────────────────────────────────────
// Message conversion (internal OpenAI-style → native Anthropic)
// ─────────────────────────────────────────────

function looksLikeError(content) {
  if (typeof content !== "string") return false;
  if (content.startsWith("SYSTEM_ERROR:")) return true;
  if (content.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(content);
      return Boolean(j?.error);
    } catch {
      return false;
    }
  }
  return false;
}

/** Native tool_result content: string, or array of {type:"text"} blocks. */
function toToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const blocks = [];
    for (const b of content) {
      if (b?.type === "text" && typeof b.text === "string")
        blocks.push({ type: "text", text: b.text });
    }
    return blocks.length ? blocks : "";
  }
  return "";
}

function parseToolInput(argumentsStr) {
  if (typeof argumentsStr === "string" && argumentsStr.trim()) {
    try {
      return JSON.parse(argumentsStr);
    } catch {
      return {};
    }
  }
  return argumentsStr && typeof argumentsStr === "object" ? argumentsStr : {};
}

/**
 * Convert internal (OpenAI-style) messages to native Anthropic messages,
 * MERGING consecutive same-role messages (Anthropic requires strict
 * user/assistant alternation; our internal format can hold several
 * consecutive role:"tool" messages after one assistant tool_calls turn).
 * System messages are dropped here (the system FIELD is built separately
 * from the client's original blocks).
 */
export function internalToAnthropicMessages(messages) {
  const out = [];

  const pushUserBlock = (block) => {
    const last = out[out.length - 1];
    if (last && last.role === "user") {
      if (typeof last.content === "string") {
        last.content = [{ type: "text", text: last.content }, block];
      } else {
        last.content.push(block);
      }
      return;
    }
    out.push({ role: "user", content: [block] });
  };

  const pushAssistantContent = (blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === "assistant") {
      if (typeof last.content === "string") {
        last.content = blocks.length
          ? [{ type: "text", text: last.content }, ...blocks]
          : [{ type: "text", text: last.content }];
      } else {
        last.content.push(...blocks);
      }
      return;
    }
    out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
  };

  for (const m of messages) {
    if (!m || m.role === "system") continue;

    if (m.role === "tool") {
      pushUserBlock({
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: toToolResultContent(m.content),
        ...(looksLikeError(m.content) ? { is_error: true } : {}),
      });
      continue;
    }

    if (m.role === "assistant") {
      const blocks = [];
      if (typeof m.content === "string" && m.content)
        blocks.push({ type: "text", text: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name,
            input: parseToolInput(tc.function?.arguments),
          });
        }
      }
      pushAssistantContent(blocks);
      continue;
    }

    if (m.role === "user") {
      if (typeof m.content === "string") {
        // String fidelity: a standalone user text message stays a string on
        // the wire (byte-identical to what the client sent — the Anthropic
        // API accepts string content and a byte-changed prefix would bust
        // the cache). Converting to a block array only happens when it must
        // merge with a previous same-role message (pushUserBlock).
        const last = out[out.length - 1];
        if (last && last.role === "user") {
          if (typeof last.content === "string") {
            last.content += "\n" + m.content;
          } else {
            last.content.push({ type: "text", text: m.content });
          }
        } else {
          out.push({ role: "user", content: m.content });
        }
        continue;
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === "tool_result") {
            pushUserBlock({
              type: "tool_result",
              tool_use_id: b.tool_use_id,
              content: toToolResultContent(b.content),
              ...(looksLikeError(b.content) ? { is_error: true } : {}),
            });
          } else if (b?.type === "text") {
            pushUserBlock({ type: "text", text: b.text ?? "" });
          } else if (b?.type === "image") {
            pushUserBlock({ type: "image", source: b.source });
          }
        }
        continue;
      }
      pushUserBlock({ type: "text", text: "" });
    }
  }

  return out;
}

// ─────────────────────────────────────────────
// Native request builder
// ─────────────────────────────────────────────

function systemToBlocks(system) {
  if (system == null) return [];
  if (typeof system === "string") return system ? [{ type: "text", text: system }] : [];
  if (Array.isArray(system)) {
    // VERBATIM: spread each client block so cache_control (and any other
    // block-level field) survives byte-for-byte — this is the whole point
    // of the native egress (the client's cache breakpoints must reach the
    // provider untouched).
    return system
      .filter((b) => b && (b.type === "text" || b.type === "image"))
      .map((b) => (b.type === "text" ? { ...b, text: b.text ?? "" } : { ...b }));
  }
  return [];
}

function toolNameOf(t) {
  return t?.function?.name || t?.name || "";
}

function clientContextForgeToolPrefix(tools) {
  const CF_BARE_NAMES = new Set([
    "contextforge_query_graph",
    "contextforge_patch_ast",
    "read_file_chunk",
    "contextforge_retrieve",
    "memory_save",
    "memory_search",
    "memory_update",
    "memory_delete",
    "memory_list",
  ]);
  for (const tool of tools || []) {
    const name = toolNameOf(tool);
    if (!name || !name.includes("__")) continue;
    const bare = name.slice(name.lastIndexOf("__") + 2);
    if (!CF_BARE_NAMES.has(bare)) continue;
    const prefix = name.slice(0, name.length - bare.length);
    if (prefix === "contextforge__" || prefix.startsWith("mcp__")) return prefix;
  }
  return "";
}

/**
 * Convert a ContextForge (internal OpenAI-shape) tool definition to the
 * Anthropic wire shape. Client tools are forwarded verbatim in their
 * original shape; only OUR appended tools need this conversion.
 */
function toAnthropicTool(t) {
  const fn = t?.function ?? t;
  return {
    name: fn?.name ?? t?.name,
    description: fn?.description ?? t?.description ?? "",
    input_schema: fn?.parameters ?? t?.input_schema ?? { type: "object", properties: {} },
  };
}

/**
 * Build the native /v1/messages request body.
 *
 * @param {object} clientOriginal  the client's RAW body (pre-translation) —
 *   source of the verbatim system/tools/metadata (with cache_control).
 * @param {object} internalPayload the pipeline-processed internal payload —
 *   source of messages and the ContextForge tool additions (its tools array
 *   is the client's tools plus ContextForge's stable additions, in stable
 *   order; we re-derive "ours" as the tools not present in the client's).
 */
export function buildNativeBody({ clientOriginal, internalPayload }) {
  const clientSystem = systemToBlocks(clientOriginal?.system);
  const clientTools = Array.isArray(clientOriginal?.tools) ? clientOriginal.tools : [];
  const clientToolNames = new Set(clientTools.map(toolNameOf));
  const toolPrefix = clientContextForgeToolPrefix(clientTools);
  const mcpSession = toolPrefix.startsWith("mcp__");

  // ContextForge's own tools: everything in the internal payload's tools
  // that the client did not send (stable set + CCR retrieve + memory tools),
  // in the stable order the pipeline produced.
  const cfTools = (internalPayload.tools ?? []).filter((t) => !clientToolNames.has(toolNameOf(t)));

  const body = {
    model: internalPayload.model || clientOriginal?.model,
    // Native API requires max_tokens; honor the client's, else a sane default.
    max_tokens: clientOriginal?.max_tokens || internalPayload.max_tokens || 4096,
    stream: Boolean(clientOriginal?.stream ?? internalPayload.stream),
    // Client system blocks VERBATIM (cache_control markers included), then
    // our rule appended AFTER them — outside the client's marked prefix.
    system: [
      ...clientSystem,
      {
        type: "text",
        text: getContextForgeRule({ mcpSession, toolPrefix: toolPrefix || undefined }),
      },
    ],
    // Client tools VERBATIM (tool-level cache_control included), then ours
    // (converted to Anthropic wire shape — ours are internal OpenAI shape).
    tools: [...clientTools, ...cfTools.map(toAnthropicTool)],
    messages: internalToAnthropicMessages(internalPayload.messages ?? []),
  };

  // Pass through conversation-level fields the client sent, untouched.
  for (const k of [
    "metadata", // user_id — Anthropic uses it for cache routing
    "thinking", // extended thinking config
    "temperature",
    "top_p",
    "top_k",
    "stop_sequences",
    "service_tier",
    "mcp_servers",
    "container",
  ]) {
    if (clientOriginal?.[k] !== undefined) body[k] = clientOriginal[k];
  }

  return body;
}

/** Native egress headers (x-api-key + anthropic-version are REQUIRED). */
export function buildNativeHeaders(incomingHeaders) {
  const out = { ...incomingHeaders };
  const key =
    process.env.ANTHROPIC_API_KEY ||
    incomingHeaders["x-api-key"] ||
    (incomingHeaders["authorization"]
      ? incomingHeaders["authorization"].replace(/^Bearer\s+/i, "")
      : null);
  if (key) out["x-api-key"] = key;
  // Bearer is also accepted natively; keep both for gateway compatibility.
  if (key) out["authorization"] = `Bearer ${key}`;
  if (!out["anthropic-version"]) out["anthropic-version"] = "2023-06-01";
  // Keep anthropic-beta (e.g. extended-cache-ttl beta headers) if the
  // client sent it — that is how the 1h cache TTL is opted into.
  delete out["content-length"];
  delete out["accept-encoding"];
  delete out["connection"];
  for (const h of Object.keys(out)) {
    if (h.startsWith("x-cf-") || h.startsWith("x-contextforge-")) delete out[h];
  }
  return out;
}

export const NATIVE_PATH = "/v1/messages";

// ─────────────────────────────────────────────
// Native SSE assembler (for the Ghost Interceptor)
// ─────────────────────────────────────────────

/**
 * Feeds raw native SSE event lines; on message_stop (or error) exposes the
 * assembled assistant turn as internal shape:
 *   { text, toolCalls: [{id, name, arguments}], usage: {input, cacheRead, output}, error }
 */
export class NativeSSEAssembler {
  constructor() {
    this.blocks = new Map(); // index → {type, id, name, text, inputJson}
    this.inputTokens = 0;
    this.cacheRead = 0;
    this.cacheCreation = 0;
    this.outputTokens = 0;
    this.stopReason = null;
    this.error = null;
    this.done = false;
    this.sawAnyBlock = false;
    this.toolBlocksSeen = 0;
    this.hadBackgroundTool = false;
    this.backgroundChecker = (name) => false; // set by caller
  }

  /** Process one raw SSE line (data: ... / event: ... / blank). */
  processLine(line) {
    if (this.done) return;
    if (typeof line !== "string" || !line.startsWith("data: ")) return;
    const data = line.substring(6).trim();
    if (!data) return;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return; // ignore malformed
    }

    switch (evt.type) {
      case "message_start": {
        const u = evt.message?.usage || {};
        this.inputTokens = u.input_tokens || 0;
        this.cacheRead += u.cache_read_input_tokens || 0;
        this.cacheCreation += u.cache_creation_input_tokens || 0;
        break;
      }
      case "content_block_start": {
        const cb = evt.content_block || {};
        this.sawAnyBlock = true;
        this.blocks.set(evt.index, {
          type: cb.type,
          id: cb.id,
          name: cb.name,
          text: cb.type === "text" ? cb.text || "" : "",
          inputJson: cb.type === "tool_use" ? "" : null,
        });
        if (cb.type === "tool_use") {
          this.toolBlocksSeen++;
          if (cb.name && this.backgroundChecker(cb.name)) this.hadBackgroundTool = true;
        }
        break;
      }
      case "content_block_delta": {
        const b = this.blocks.get(evt.index);
        if (!b) break;
        const d = evt.delta || {};
        if (d.type === "text_delta" && typeof d.text === "string") b.text += d.text;
        else if (d.type === "input_json_delta" && typeof d.partial_json === "string")
          b.inputJson += d.partial_json;
        // thinking_delta / signature_delta: deliberately dropped — replaying
        // extended-thinking blocks natively requires the original signature,
        // which we do not preserve; they are not needed for interception.
        break;
      }
      case "message_delta": {
        const u = evt.usage || {};
        this.outputTokens = u.output_tokens || this.outputTokens;
        this.cacheRead += u.cache_read_input_tokens || 0;
        if (evt.delta?.stop_reason) this.stopReason = evt.delta.stop_reason;
        break;
      }
      case "message_stop": {
        this.done = true;
        break;
      }
      case "error": {
        this.error = evt.error?.message || "upstream error";
        this.done = true;
        break;
      }
      default:
        break;
    }
  }

  /** Assemble the finished turn (call after done). */
  result() {
    const textParts = [];
    const toolCalls = [];
    for (const b of this.blocks.values()) {
      if (b.type === "text" && b.text) textParts.push(b.text);
      else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id || `toolu_cf_${Math.random().toString(36).slice(2, 10)}`,
          name: b.name,
          arguments: b.inputJson || "{}",
        });
      }
    }
    return {
      text: textParts.join(""),
      toolCalls,
      usage: {
        input: this.inputTokens,
        cacheRead: this.cacheRead,
        cacheCreation: this.cacheCreation,
        output: this.outputTokens,
      },
      stopReason: this.stopReason,
      error: this.error,
    };
  }
}

/** Convert a native NON-streaming message object to internal shape. */
export function nativeMessageToInternal(message) {
  const textParts = [];
  const toolCalls = [];
  for (const b of message?.content ?? []) {
    if (b?.type === "text" && b.text) textParts.push(b.text);
    else if (b?.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: {
          name: b.name,
          arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}),
        },
      });
    }
  }
  const usage = message?.usage || {};
  return {
    content: textParts.join("") || null,
    toolCalls,
    usage: {
      input: usage.input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheCreation: usage.cache_creation_input_tokens || 0,
      output: usage.output_tokens || 0,
    },
    stopReason: message?.stop_reason ?? null,
  };
}
