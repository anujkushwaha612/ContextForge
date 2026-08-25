/**
 * memoryTools.js
 *
 * Memory tools — injected into requests, handled by Ghost Interceptor.
 *
 * Tools: memory_save, memory_search, memory_update, memory_delete, memory_list
 *
 * Fixes applied:
 *   MT-1: injectMemoryTools now actually uses the hasMemoryMarkers check.
 *         Previously computed but ignored — always injected 5 tool schemas
 *         (~1000-2000 tokens) on every request unconditionally.
 *         Now only injects when memory content exists in the conversation
 *         OR when the session has previously used memory tools.
 *
 *   MT-2: payloadHasMemoryContent now checks role:"tool" messages with
 *         name matching memory tool names — more precise than string matching
 *         "memory_" which could false-positive on "memory usage" in logs.
 *
 *   MT-3: Removed unused saveToVault import.
 */

export const MEMORY_TOOL_NAMES = new Set([
  "memory_save",
  "memory_search",
  "memory_update",
  "memory_delete",
  "memory_list",
]);

// ─────────────────────────────────────────────
// Tool definitions (OpenAI format)
// ─────────────────────────────────────────────

export function getMemoryToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "memory_save",
        description:
          "Save important information to persistent memory for future sessions. " +
          "Use for: user preferences, project decisions, recurring patterns, " +
          "architectural choices, debugging insights.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The information to remember. Be specific and self-contained.",
            },
            importance: {
              type: "number",
              description:
                "Importance score 0.0-1.0. Default 0.5. Use 0.9+ for critical decisions.",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_search",
        description:
          "Search persistent memory for relevant past context. " +
          "Use when you need context about user preferences, past decisions, or project history.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What to search for.",
            },
            top_k: {
              type: "number",
              description: "Number of results to return. Default 5.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_update",
        description: "Update an existing memory entry by ID.",
        parameters: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "The memory ID from a previous search or list.",
            },
            new_content: {
              type: "string",
              description: "The updated content.",
            },
          },
          required: ["memory_id", "new_content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_delete",
        description: "Delete a memory entry by ID.",
        parameters: {
          type: "object",
          properties: {
            memory_id: {
              type: "string",
              description: "The memory ID to delete.",
            },
          },
          required: ["memory_id"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_list",
        description: "List recent memory entries.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of entries to return. Default 10, max 50.",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
  ];
}

// ─────────────────────────────────────────────
// Detect whether this payload warrants memory tool injection
//
// MT-2: Now uses two precise checks instead of broad string matching:
//   1. Any role:"tool" message whose name is a memory tool name
//      → the LLM has already used memory tools this session
//   2. Any message content containing "mem_" followed by hex chars
//      → a memory ID is referenced in the conversation
//
// Previously checked content.includes("memory_") which false-positived
// on "memory usage", "memory management", etc. in logs and tool results.
// ─────────────────────────────────────────────

const MEMORY_ID_PATTERN = /\bmem_[0-9a-f]{16}\b/;

function payloadHasMemoryContent(messages) {
  if (!messages) return false;

  for (const msg of messages) {
    // Check if any tool result is from a memory tool
    if (msg.role === "tool" && typeof msg.name === "string") {
      // MT-5 FIX: match namespaced variants too (mcp__cf__memory_save).
      // Exact-only lookup missed prefixed names → markers never detected
      // → injection stopped after the first turn on MCP-routed setups.
      const bare = msg.name.slice(msg.name.lastIndexOf("__") + 2);
      if (MEMORY_TOOL_NAMES.has(msg.name) || MEMORY_TOOL_NAMES.has(bare)) {
        return true;
      }
    }

    // Check if any message content references a memory ID (mem_<hex>)
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .filter((b) => b?.type === "text")
              .map((b) => b.text || "")
              .join(" ")
          : "";

    if (MEMORY_ID_PATTERN.test(content)) return true;
  }

  return false;
}

// ─────────────────────────────────────────────
// Inject memory tools into payload
//
// MT-1: Now actually uses hasMemoryMarkers to gate injection.
//       Previously computed it but always injected unconditionally,
//       adding ~1000-2000 tokens to every single request.
//
// Injection triggers:
//   - sessionHasMemory: caller signals this session has used memory
//   - payloadHasMemoryContent: conversation references memory IDs or
//     tool results from memory tools
//
// The LLM will discover memory tools exist when it needs them — we do
// not need to pre-inject them on every turn "just in case".
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// MT-4: Memory-intent detection
//
// The MT-1 gate created a chicken-and-egg deadlock: tools are injected
// only when the conversation already shows memory usage — but a fresh
// session can never GET memory usage without the tools. A user saying
// "remember that I prefer tabs" got no memory_save schema, the model
// apologized, and the feature was effectively dead for new users.
//
// Fix: also inject when the LATEST user message expresses memory intent.
// Scoped to the last user message only (not history) so a week-old
// "remember..." doesn't re-inject forever; once the model actually calls
// a memory tool, the tool-result marker keeps injection alive.
// ─────────────────────────────────────────────

const MEMORY_INTENT_PATTERN =
  /\b(remember|memoriz|don'?t forget|keep in mind|save (this|that|it) (for|to memory)|note (this|that) down|for (future|next) (reference|session)|from (a )?(previous|past|last) (session|conversation)|what did (we|i) (decide|choose|say)|recall)\b/i;

function latestUserMessageHasMemoryIntent(messages) {
  if (!messages) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    // Skip Anthropic-style pure tool_result user messages
    if (
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      msg.content.every((b) => b?.type === "tool_result")
    )
      continue;

    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .filter((b) => b?.type === "text")
              .map((b) => b.text || "")
              .join(" ")
          : "";
    return MEMORY_INTENT_PATTERN.test(text);
  }
  return false;
}

export function injectMemoryTools(payload, { sessionHasMemory = false } = {}) {
  // MT-1: markers/session flag; MT-4: fresh-session intent escape hatch
  const shouldInject =
    sessionHasMemory ||
    payloadHasMemoryContent(payload.messages) ||
    latestUserMessageHasMemoryIntent(payload.messages);

  if (!shouldInject) return payload;

  const currentTools = payload.tools || [];

  // Avoid duplicates
  for (const tool of currentTools) {
    const name = tool.name || tool.function?.name;
    if (MEMORY_TOOL_NAMES.has(name)) return payload;
  }

  return {
    ...payload,
    tools: [...currentTools, ...getMemoryToolDefinitions()],
  };
}

// ─────────────────────────────────────────────
// Detect memory tool calls in a message or synthetic object
// ─────────────────────────────────────────────

export function hasMemoryToolCalls(message) {
  if (!message?.tool_calls) return false;
  return message.tool_calls.some((tc) => MEMORY_TOOL_NAMES.has(tc.function?.name));
}

// ─────────────────────────────────────────────
// Execute memory tool calls
// Called by Ghost Interceptor when LLM issues memory tool calls.
// Returns array of role:"tool" result messages to append.
// ─────────────────────────────────────────────

export async function executeMemoryToolCalls(message, memoryHandler, { userId, workspace = "" }) {
  if (!message?.tool_calls) return [];

  const results = [];

  for (const tc of message.tool_calls) {
    const name = tc.function?.name;
    if (!MEMORY_TOOL_NAMES.has(name)) continue;

    let args = {};
    try {
      args = JSON.parse(tc.function?.arguments || "{}");
    } catch (err) {
      console.warn(`[Memory] ⚠️  Malformed JSON args for ${name}:`, err.message);
    }

    const callId = tc.id;
    let content = "";

    try {
      if (name === "memory_save") {
        const id = await memoryHandler.save({
          userId,
          workspace,
          content: args.content || "",
          importance: args.importance ?? 0.5,
        });

        if (!id) {
          content = JSON.stringify({
            status: "error",
            error: "Failed to save — content was empty or store rejected it",
          });
        } else {
          content = JSON.stringify({
            status: "saved",
            memory_id: id,
            content: (args.content || "").slice(0, 100),
          });
        }
      } else if (name === "memory_search") {
        const found = await memoryHandler.search({
          userId,
          workspace,
          query: args.query || "",
          topK: args.top_k ?? 5,
        });

        const safeFound = Array.isArray(found) ? found : [];
        content = JSON.stringify({
          status: "found",
          count: safeFound.length,
          memories: safeFound.map((r) => ({
            id: r.id,
            content: r.content || "",
            score: Math.round((r.score || 0) * 1000) / 1000,
          })),
        });
      } else if (name === "memory_update") {
        const ok = await memoryHandler.update({
          id: args.memory_id || "",
          content: args.new_content || "",
        });
        content = JSON.stringify({
          status: ok ? "updated" : "not_found",
          memory_id: args.memory_id,
        });
      } else if (name === "memory_delete") {
        const ok = memoryHandler.delete(args.memory_id || "");
        content = JSON.stringify({
          status: ok ? "deleted" : "not_found",
          memory_id: args.memory_id,
        });
      } else if (name === "memory_list") {
        const limit = Math.min(args.limit ?? 10, 50);
        const items = memoryHandler.list({ userId, workspace, limit });
        const safeItems = Array.isArray(items) ? items : [];

        content = JSON.stringify({
          status: "ok",
          count: safeItems.length,
          memories: safeItems.map((r) => ({
            id: r.id,
            content: r.content || "",
            created_at: r.createdAt,
          })),
        });
      }
    } catch (err) {
      console.error(`[Memory] Tool ${name} failed:`, err.message);
      content = JSON.stringify({ status: "error", error: err.message });
    }

    console.log(`[Memory] Executed: ${name} → ${content.slice(0, 80)}`);

    results.push({
      role: "tool",
      tool_call_id: callId,
      name,
      content,
    });
  }

  return results;
}
