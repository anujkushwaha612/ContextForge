/**
 * CCR Tool Injection
 *
 * Fix 3: Tool schema sanitization cache in translateAnthropicToOpenAI
 * is handled in systemMessages.js. Here we just ensure scanForMarkers is
 * incremental-friendly (stateless, called with only new messages).
 */

export const CCR_TOOL_NAME = "contextforge_retrieve";

// ─────────────────────────────────────────────
// Tool definition — built once per provider, cached
// ─────────────────────────────────────────────

const _toolDefCache = new Map();

export function createCCRToolDefinition(provider = "anthropic") {
  if (_toolDefCache.has(provider)) {
    return _toolDefCache.get(provider);
  }

  const description =
    "Retrieve original uncompressed content that was compressed to save tokens. " +
    "Use this when you need more data than what's shown in compressed tool results. " +
    "The vault_id is provided in compression markers like " +
    "[content compressed... vault_id=cf_vault_xxxxx].";

  let def;

  if (provider === "anthropic") {
    def = {
      name: CCR_TOOL_NAME,
      description,
      input_schema: {
        type: "object",
        properties: {
          vault_id: {
            type: "string",
            description: "Vault ID from the compression marker (e.g., 'cf_vault_abc123')",
          },
          search_query: {
            type: "string",
            description:
              "Optional search query to filter results. " +
              "If provided, only returns content matching the query.",
          },
        },
        required: ["vault_id"],
        additionalProperties: false,
      },
    };
  } else {
    def = {
      type: "function",
      function: {
        name: CCR_TOOL_NAME,
        description,
        parameters: {
          type: "object",
          properties: {
            vault_id: {
              type: "string",
              description: "Vault ID from the compression marker",
            },
            search_query: {
              type: "string",
              description: "Optional search query to filter results",
            },
          },
          required: ["vault_id"],
          additionalProperties: false,
        },
      },
    };
  }

  _toolDefCache.set(provider, def);
  return def;
}

// ─────────────────────────────────────────────
// Marker patterns — compiled once at module load
// ─────────────────────────────────────────────

// CCR-8 FIX: the 4th pattern captured ANY [a-z0-9_]+ id — text like
// "[data compressed for transit, vault_id: 12345]" in a tool result made
// the injector fire for garbage ids that fetchFromVault can never resolve
// (wasted schema tokens + a guaranteed failed tool call if the LLM bites).
// All patterns now require the cf_vault_ prefix. Pattern 3 was a strict
// subset of pattern 1 — removed.
const MARKER_PATTERNS = [
  /vault_id[=:]\s*["']?(cf_vault_[a-z0-9_]+)["']?/gi,
  /Vault:\s*(cf_vault_[a-z0-9_]+)/gi,
  /\[.*?compressed.*?vault[_-]?id[=:]\s*["']?(cf_vault_[a-z0-9_]+)["']?\]/gi,
];

// Semantic dedup used to emit `[CF_VAULT:…]` placeholders for copies that
// were explicitly redundant because a current full copy remained visible later
// in the conversation. CCR treated those *non-retrievable* placeholders as
// real retrieval work, repeatedly injected contextforge_retrieve, and taught
// the model to open stale copies. Keep compatibility with old histories while
// excluding them from retrieve discovery.
const LEGACY_NON_RETRIEVABLE_DEDUP_STUB =
  /^\[CF_VAULT:cf_vault_[a-z0-9_]+\]\s+\((?:identical to (?:the )?current copy|outdated copy)/i;
const NON_RETRIEVABLE_DEDUP_STUB = /^\[CF_(?:DEDUPLICATED|SUPERSEDED)\]/i;

export function isNonRetrievableVaultStub(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trimStart();
  return (
    NON_RETRIEVABLE_DEDUP_STUB.test(trimmed) || LEGACY_NON_RETRIEVABLE_DEDUP_STUB.test(trimmed)
  );
}

export function extractRetrievableVaultIds(text, resultSet = new Set()) {
  if (typeof text !== "string" || isNonRetrievableVaultStub(text)) return resultSet;

  for (const pattern of MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) resultSet.add(match[1]);
    }
  }
  return resultSet;
}

export function hasRetrievableVaultMarker(text) {
  return extractRetrievableVaultIds(text).size > 0;
}

/**
 * Scan messages for compression markers.
 * Stateless — caller decides which messages to pass (new vs all).
 * In applyCCRPipeline we pass only new messages (incremental).
 */
export function scanForMarkers(messages) {
  const detectedVaultIds = new Set();

  for (const msg of messages) {
    // CF markers are generated in tool results. Restrict discovery to those
    // carriers so user prose, assistant explanations, and system guidance do
    // not accidentally create a retrieve capability loop.
    if (msg?.role === "tool" && typeof msg.content === "string") {
      extractRetrievableVaultIds(msg.content, detectedVaultIds);
      continue;
    }

    if (msg?.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type !== "tool_result") continue;
        const toolContent = block.content;
        if (typeof toolContent === "string") {
          extractRetrievableVaultIds(toolContent, detectedVaultIds);
        } else if (Array.isArray(toolContent)) {
          for (const contentBlock of toolContent) {
            if (contentBlock?.type === "text" && contentBlock.text) {
              extractRetrievableVaultIds(contentBlock.text, detectedVaultIds);
            }
          }
        }
      }
    }
  }

  return [...detectedVaultIds];
}

// ─────────────────────────────────────────────
// CCRToolInjector
// ─────────────────────────────────────────────

export class CCRToolInjector {
  constructor({ provider = "openai", injectTool = true, injectSystemInstructions = false } = {}) {
    this.provider = provider;
    this.injectTool = injectTool;
    this.injectSystemInstructions = injectSystemInstructions;
    this._detectedVaultIds = [];
  }

  get hasCompressedContent() {
    return this._detectedVaultIds.length > 0;
  }

  get detectedVaultIds() {
    return [...this._detectedVaultIds];
  }

  scanForMarkers(messages) {
    this._detectedVaultIds = scanForMarkers(messages);
    return this._detectedVaultIds;
  }

  injectToolDefinition(tools, { sessionHasDoneCCR = false } = {}) {
    if (!this.injectTool) return { tools: tools || [], wasInjected: false };

    // FIX: Removed sessionHasDoneCCR from shouldInject condition.
    // The sticky-on behavior was the root cause of permanent injection.
    // Injection is now decided entirely by whether hasCompressedContent
    // is true — which is controlled by the caller (applyCCRPipeline)
    // setting _detectedVaultIds to only UNRETRIEVED vault IDs.
    const shouldInject = this.hasCompressedContent;
    if (!shouldInject) return { tools: tools || [], wasInjected: false };

    const currentTools = tools || [];

    // Avoid duplicates
    for (const tool of currentTools) {
      const name = tool.name || tool.function?.name;
      if (name === CCR_TOOL_NAME) {
        return { tools: currentTools, wasInjected: false };
      }
    }

    console.log("Injecting retrieve tool");
    const ccrTool = createCCRToolDefinition(this.provider);
    return { tools: [...currentTools, ccrTool], wasInjected: true };
  }

  processRequest(messages, tools, { sessionHasDoneCCR = false } = {}) {
    // Note: in the incremental path (called from applyCCRPipeline),
    // _detectedVaultIds is pre-set by the caller — don't overwrite
    // by calling scanForMarkers on all messages here.
    // Only scan if not already set externally.
    if (this._detectedVaultIds.length === 0 && !sessionHasDoneCCR) {
      this.scanForMarkers(messages);
    }

    const shouldProcess = sessionHasDoneCCR || this.hasCompressedContent;
    if (!shouldProcess) {
      return { messages, tools, toolWasInjected: false };
    }

    const { tools: updatedTools, wasInjected } = this.injectToolDefinition(tools, {
      sessionHasDoneCCR,
    });

    return {
      messages,
      tools: updatedTools,
      toolWasInjected: wasInjected,
    };
  }
}

export function parseCCRToolCall(toolCall, provider = "openai") {
  let name, inputData;

  if (provider === "anthropic") {
    name = toolCall.name;
    inputData = toolCall.input || {};
  } else {
    const fn = toolCall.function || {};
    name = fn.name;
    try {
      inputData = JSON.parse(fn.arguments || "{}");
    } catch {
      inputData = {};
    }
  }

  if (name !== CCR_TOOL_NAME) return { vaultId: null, searchQuery: null };

  return {
    vaultId: inputData.vault_id || null,
    searchQuery: inputData.search_query || null,
  };
}
