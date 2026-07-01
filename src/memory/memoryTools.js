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
              description:
                "The information to remember. Be specific and self-contained.",
            },
            importance: {
              type: "number",
              description:
                "Importance score 0.0-1.0. Default 0.5. Use 0.9+ for critical decisions.",
            },
          },
          required: ["content"],
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
    if (msg.role === "tool" && MEMORY_TOOL_NAMES.has(msg.name)) {
      return true;
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

export function injectMemoryTools(payload, { sessionHasMemory = false } = {}) {
  // MT-1: Wire up the condition that was previously computed but ignored
  const shouldInject =
    sessionHasMemory || payloadHasMemoryContent(payload.messages);

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
  return message.tool_calls.some((tc) =>
    MEMORY_TOOL_NAMES.has(tc.function?.name),
  );
}

// ─────────────────────────────────────────────
// Execute memory tool calls
// Called by Ghost Interceptor when LLM issues memory tool calls.
// Returns array of role:"tool" result messages to append.
// ─────────────────────────────────────────────

export async function executeMemoryToolCalls(
  message,
  memoryHandler,
  { userId, workspace = "" },
) {
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
    let content  = "";

    try {
      if (name === "memory_save") {
        const id = await memoryHandler.save({
          userId,
          workspace,
          content:    args.content || "",
          importance: args.importance ?? 0.5,
        });

        if (!id) {
          content = JSON.stringify({
            status: "error",
            error:  "Failed to save — content was empty or store rejected it",
          });
        } else {
          content = JSON.stringify({
            status:    "saved",
            memory_id: id,
            content:   (args.content || "").slice(0, 100),
          });
        }

      } else if (name === "memory_search") {
        const found = await memoryHandler.search({
          userId,
          workspace,
          query: args.query || "",
          topK:  args.top_k ?? 5,
        });

        const safeFound = Array.isArray(found) ? found : [];
        content = JSON.stringify({
          status:   "found",
          count:    safeFound.length,
          memories: safeFound.map((r) => ({
            id:      r.id,
            content: r.content || "",
            score:   Math.round((r.score || 0) * 1000) / 1000,
          })),
        });

      } else if (name === "memory_update") {
        const ok = await memoryHandler.update({
          id:      args.memory_id || "",
          content: args.new_content || "",
        });
        content = JSON.stringify({
          status:    ok ? "updated" : "not_found",
          memory_id: args.memory_id,
        });

      } else if (name === "memory_delete") {
        const ok = memoryHandler.delete(args.memory_id || "");
        content = JSON.stringify({
          status:    ok ? "deleted" : "not_found",
          memory_id: args.memory_id,
        });

      } else if (name === "memory_list") {
        const limit     = Math.min(args.limit ?? 10, 50);
        const items     = memoryHandler.list({ userId, workspace, limit });
        const safeItems = Array.isArray(items) ? items : [];

        content = JSON.stringify({
          status:   "ok",
          count:    safeItems.length,
          memories: safeItems.map((r) => ({
            id:         r.id,
            content:    r.content || "",
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
      role:         "tool",
      tool_call_id: callId,
      name,
      content,
    });
  }

  return results;
}