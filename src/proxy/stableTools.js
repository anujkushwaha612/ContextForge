/**
 * stableTools.js
 *
 * A2 (headroom analysis): deterministic, flip-free tool set for CF sessions.
 *
 * The provider's prompt cache pins the request PREFIX (system + tools +
 * message history). Anything in that prefix that changes between turns
 * busts the cache for the ENTIRE remainder of the prefix — and the tools
 * array historically toggled per turn:
 *
 *   - planPipeline injected GRAPH/PATCH/READ based on per-turn intent
 *     (a PATCH-classified turn got 1 tool, the next DEBUG turn 3)
 *   - CCR injected/removed contextforge_retrieve as vaults were retrieved
 *   - injectMemoryTools toggled on the LATEST user message's "memory
 *     intent" (a per-turn signal by construction)
 *
 * Every toggle = full prefix miss on the next request: we paid the
 * cache-WRITE rate (1.25× input) on the largest part of the payload
 * (history) precisely on the turns where history is biggest. Headroom's
 * realignment found the identical bugs in themselves (P0-6, P2-25) and
 * their fix is the model here: availability is fixed and deterministic;
 * the planner's intent stops gating what the model CAN do.
 *
 * Determinism rules (pure functions of the payload — no session state):
 *
 *   1. Repo group (query_graph, patch_ast, read_file_chunk): ALWAYS
 *      present in non-MCP sessions, canonical order, byte-identical
 *      schema objects (the definitions are static module-level literals;
 *      JSON.stringify preserves insertion order, so no key-sorting pass
 *      is needed — single-language construction, unlike headroom's
 *      cross-language parity problem).
 *
 *   2. Retrieve tool: present iff the payload carries compression
 *      markers ([CF_VAULT: / [CF_COMPRESSED_FILE). Compression stubs
 *      persist in history (only /compact removes them), so the condition
 *      is STICKY in practice — it turns on once, then stays on for the
 *      rest of the session — without any state to evict.
 *
 *   3. Memory group (memory_save/search/update/delete/list): present iff
 *      the payload shows memory activity — a memory tool result, a mem_*
 *      ID reference, OR memory intent in ANY user message (not just the
 *      latest — history is append-only, so "any" is sticky too). This
 *      keeps first-use coverage ("remember that we use pnpm" on turn 1)
 *      while removing the per-turn latest-message flip.
 *
 *   4. Order: client tools keep their original positions; CF tools are
 *      appended in fixed canonical order. Same payload → same bytes.
 *
 *   5. MCP sessions (request already carries any mcp__ CF alias) are
 *      left exactly as today — the Ghost Interceptor never intercepts
 *      mcp__ calls, and the MCP server owns tool availability there.
 *
 * Note on nudge mode (CF_NUDGE_TOOLS=1): native Edit/Read are stripped,
 * so the CF tools are the model's ONLY edit path. Per-intent injection
 * was a latent bug there (a chat-classified turn stripped Edit AND
 * injected no patch tool → the model could not edit at all). Always-on
 * availability removes that failure mode.
 */

import { getGraphToolDefinition, getReadFileChunkToolDefinition } from "../graph/graphTools.js";
import { getPatchToolDefinition } from "../graph/patchTools.js";
import { createCCRToolDefinition } from "../ccr/toolInjection.js";
import { getMemoryToolDefinitions, MEMORY_TOOL_NAMES } from "../memory/memoryTools.js";

// ─────────────────────────────────────────────
// Canonical availability (fixed order — the ONLY order we ever emit)
// ─────────────────────────────────────────────

const REPO_TOOLS = [
  { name: "contextforge_query_graph", def: getGraphToolDefinition() },
  { name: "contextforge_patch_ast", def: getPatchToolDefinition() },
  { name: "read_file_chunk", def: getReadFileChunkToolDefinition() },
];

const RETRIEVE_TOOL = {
  name: "contextforge_retrieve",
  def: createCCRToolDefinition("openai"),
};

const MEMORY_TOOLS = getMemoryToolDefinitions().map((t) => ({
  name: t.function?.name || t.name,
  def: t,
}));

const CONTEXTFORGE_TOOL_NAMES = new Set([
  "contextforge_query_graph",
  "contextforge_patch_ast",
  "read_file_chunk",
  "contextforge_retrieve",
  ...MEMORY_TOOL_NAMES,
]);

// ─────────────────────────────────────────────
// Payload-derived (sticky) conditions
// ─────────────────────────────────────────────

const VAULT_MARKER = /\[(?:CF_VAULT:|CF_COMPRESSED_FILE)/;

/** True when the payload carries compression stubs — sticky in history. */
export function payloadHasVaultMarker(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    // A2 BUGFIX (found in E2E): system messages are EXCLUDED. The injected
    // CF rule (injectContextForgeRule) documents the stub syntax in its
    // workflow guidance — "will fail on compressed file content
    // ([CF_COMPRESSED_FILE] or [CF_VAULT:...])" — so scanning system
    // content matched on EVERY CF request and made the retrieve tool
    // unconditionally always-on. Stubs only exist in tool results (and,
    // for MCP/gemini synthetic content, user tool_result blocks).
    if (msg?.role === "system") continue;
    const content = msg?.content;
    if (typeof content === "string") {
      if (VAULT_MARKER.test(content)) return true;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const text =
          typeof block?.text === "string"
            ? block.text
            : typeof block?.content === "string"
              ? block.content
              : "";
        if (text && VAULT_MARKER.test(text)) return true;
      }
    }
  }
  return false;
}

/**
 * Memory activity in the payload — sticky (append-only history):
 * a memory tool RESULT, a mem_* ID reference, or memory intent in ANY
 * user message. Replaces injectMemoryTools' latest-user-message intent
 * check (a per-turn flip source) with a payload-wide scan.
 */
const MEMORY_ID_PATTERN = /mem_[0-9a-f]{8,}/;
const MEMORY_INTENT_PATTERN =
  /\b(remember|memoriz|don'?t forget|keep in mind|save (this|that|it) (for|to memory)|note (this|that) down|for (future|next) (reference|session)|from (a )?(previous|past|last) (session|conversation)|what did (we|i) (decide|choose|say)|recall)\b/i;

function userMessageText(msg) {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text")
      .map((b) => b.text || "")
      .join(" ");
  }
  return "";
}

export function payloadHasMemoryActivity(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (msg.role === "tool" && typeof msg.name === "string") {
      const bare = msg.name.slice(msg.name.lastIndexOf("__") + 2);
      if (MEMORY_TOOL_NAMES.has(msg.name) || MEMORY_TOOL_NAMES.has(bare)) {
        return true;
      }
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const name = tc?.function?.name || "";
        const bare = name.slice(name.lastIndexOf("__") + 2);
        if (MEMORY_TOOL_NAMES.has(name) || MEMORY_TOOL_NAMES.has(bare)) {
          return true;
        }
      }
    }
    const text = userMessageText(msg);
    if (!text) continue;
    if (MEMORY_ID_PATTERN.test(text)) return true;
    if (msg.role === "user") {
      // Skip pure tool_result carriers (they hold tool output, not intent)
      if (
        Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        msg.content.every((b) => b?.type === "tool_result")
      ) {
        continue;
      }
      if (MEMORY_INTENT_PATTERN.test(text)) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────

function toolNameOf(tool) {
  return tool?.function?.name || tool?.name || "";
}

/**
 * Apply the deterministic CF tool set.
 *
 * @param {object} payload          internal-format payload (mutated copy of tools)
 * @param {object} opts
 * @param {boolean} opts.mcpSession request already carries mcp__ CF aliases —
 *                                  leave the tools array untouched
 * @returns {{ tools: Array, added: string[] }}
 */
export function applyStableToolSet(payload, { mcpSession = false } = {}) {
  const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];

  if (mcpSession) {
    return { tools, added: [] };
  }

  // What is already present (bare name OR any MCP alias form).
  const present = new Set();
  for (const t of tools) {
    const name = toolNameOf(t);
    if (!name) continue;
    present.add(name);
    const bare = name.slice(name.lastIndexOf("__") + 2);
    if (bare !== name) present.add(bare);
  }

  const additions = [];
  const add = (entry) => {
    // present holds BOTH the raw alias and the bare name of every existing
    // tool, so a bare-name lookup covers exact, mcp__-aliased and
    // contextforge__-aliased forms alike.
    if (present.has(entry.name)) return;
    additions.push(entry);
    present.add(entry.name);
  };

  // 1. Repo group — always.
  for (const entry of REPO_TOOLS) add(entry);

  // 2. Retrieve — sticky on compression markers.
  if (payloadHasVaultMarker(payload)) add(RETRIEVE_TOOL);

  // 3. Memory group — sticky on memory activity.
  if (payloadHasMemoryActivity(payload.messages)) {
    for (const entry of MEMORY_TOOLS) add(entry);
  }

  if (additions.length > 0) {
    payload.tools = [...tools, ...additions.map((e) => e.def)];
  }

  return { tools: payload.tools, added: additions.map((e) => e.name) };
}

/**
 * True when the request already carries any ContextForge tool in an
 * mcp__-prefixed (or contextforge__-prefixed) alias — i.e. the MCP server
 * owns tool availability for this session.
 */
export function getContextForgeToolPrefix(tools) {
  if (!Array.isArray(tools)) return "";
  for (const tool of tools) {
    const name = toolNameOf(tool);
    if (!name || !name.includes("__")) continue;
    const bare = name.slice(name.lastIndexOf("__") + 2);
    if (!CONTEXTFORGE_TOOL_NAMES.has(bare)) continue;

    const prefix = name.slice(0, name.length - bare.length);
    // Only known namespace forms are client-owned aliases. Do not let an
    // arbitrary tool ending in a CF-looking suffix suppress bare injection.
    if (prefix === "contextforge__" || prefix.startsWith("mcp__")) return prefix;
  }
  return "";
}

export function isMcpToolSession(tools) {
  return Boolean(getContextForgeToolPrefix(tools));
}
