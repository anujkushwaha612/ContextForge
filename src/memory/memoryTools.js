/**
 * Memory tools — injected into every request, handled natively.
 *
 * Tools: memory_save, memory_search, memory_update, memory_delete, memory_list
 *
 * These are REAL tools (not Ghost Interceptor hacks).
 * The LLM calls them → the proxy intercepts before forwarding → executes →
 * injects tool result → continues.
 *
 */

export const MEMORY_TOOL_NAMES = new Set([
  "memory_save",
  "memory_search",
  "memory_update",
  "memory_delete",
  "memory_list",
]);

// ─────────────────────────────────────────────
// Tool definitions (OpenAI format — post-translation)
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
// Inject memory tools into payload
// Sticky-on: once injected, always injected
// ─────────────────────────────────────────────

export function injectMemoryTools(payload, { sessionHasMemory = false } = {}) {
  // Check if this request has any memory-related content
  const hasMemoryMarkers =
    sessionHasMemory || payloadHasMemoryContent(payload.messages);

  // Always inject — memory tools should always be available
  // (unlike CCR which only injects when vault markers exist)
  const currentTools = payload.tools || [];

  // Check if already injected
  for (const tool of currentTools) {
    const name = tool.name || tool.function?.name;
    if (MEMORY_TOOL_NAMES.has(name)) return payload; // Already present
  }

  return {
    ...payload,
    tools: [...currentTools, ...getMemoryToolDefinitions()],
  };
}

function payloadHasMemoryContent(messages) {
  if (!messages) return false;
  for (const msg of messages) {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    if (content.includes("mem_") || content.includes("memory_")) return true;
  }
  return false;
}

// ─────────────────────────────────────────────
// Detect memory tool calls in a non-streaming response
// ─────────────────────────────────────────────

export function hasMemoryToolCalls(message) {
  if (!message?.tool_calls) return false;
  return message.tool_calls.some((tc) =>
    MEMORY_TOOL_NAMES.has(tc.function?.name),
  );
}

// ─────────────────────────────────────────────
// Execute memory tool calls
// Called when LLM response contains memory tool calls
// Returns array of tool result messages to append
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
    } catch (_) {}

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
        content = JSON.stringify({
          status: "saved",
          memory_id: id,
          content: (args.content || "").slice(0, 100),
        });
      } else if (name === "memory_search") {
        const found = await memoryHandler.search({
          userId,
          workspace,
          query: args.query || "",
          topK: args.top_k ?? 5,
        });

        // SAFEGUARD: Ensure 'found' is always treated as an array
        const safeFound = Array.isArray(found) ? found : [];

        content = JSON.stringify({
          status: "found",
          count: safeFound.length,
          memories: safeFound.map((r) => ({
            id: r.id,
            content: r.content,
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
        const ok = memoryHandler.delete(args.memory_id || ""); // synchronous in memoryHandler
        content = JSON.stringify({
          status: ok ? "deleted" : "not_found",
          memory_id: args.memory_id,
        });
      } else if (name === "memory_list") {
        const limit = Math.min(args.limit ?? 10, 50);
        const items = memoryHandler.list({ userId, workspace, limit }); // synchronous

        // SAFEGUARD: Ensure 'items' is always treated as an array
        const safeItems = Array.isArray(items) ? items : [];

        content = JSON.stringify({
          status: "ok",
          count: safeItems.length,
          memories: safeItems.map((r) => ({
            id: r.id,
            content: (r.content || "").slice(0, 150),
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
