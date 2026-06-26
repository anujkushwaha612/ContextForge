/**
 * CCR Tool Injection
 *
 * Fix 3: Tool schema sanitization cache in translateAnthropicToOpenAI
 * is handled in helper.js. Here we just ensure scanForMarkers is
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

const MARKER_PATTERNS = [
  /vault_id[=:]\s*["']?(cf_vault_[a-z0-9_]+)["']?/gi,
  /Vault:\s*(cf_vault_[a-z0-9_]+)/gi,
  /vault_id:\s*'(cf_vault_[a-z0-9_]+)'/gi,
  /\[.*?compressed.*?vault[_-]?id[=:]\s*([a-z0-9_]+)\]/gi,
];

function extractVaultIds(text, resultSet) {
  for (const pattern of MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) resultSet.add(match[1]);
    }
  }
}

/**
 * Scan messages for compression markers.
 * Stateless — caller decides which messages to pass (new vs all).
 * In applyCCRPipeline we pass only new messages (incremental).
 */
export function scanForMarkers(messages) {
  const detectedVaultIds = new Set();

  for (const msg of messages) {
    const content = msg.content;

    if (typeof content === "string") {
      extractVaultIds(content, detectedVaultIds);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;

        if (block.type === "text" && block.text) {
          extractVaultIds(block.text, detectedVaultIds);
        } else if (block.type === "tool_result") {
          const tc = block.content;
          if (typeof tc === "string") {
            extractVaultIds(tc, detectedVaultIds);
          } else if (Array.isArray(tc)) {
            for (const c of tc) {
              if (c?.type === "text" && c.text) {
                extractVaultIds(c.text, detectedVaultIds);
              }
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
  constructor({
    provider = "openai",
    injectTool = true,
    injectSystemInstructions = false,
  } = {}) {
    this.provider                = provider;
    this.injectTool              = injectTool;
    this.injectSystemInstructions = injectSystemInstructions;
    this._detectedVaultIds       = [];
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

    const shouldInject = sessionHasDoneCCR || this.hasCompressedContent;
    if (!shouldInject) return { tools: tools || [], wasInjected: false };

    const currentTools = tools || [];

    // Check if already present — avoid duplicates
    for (const tool of currentTools) {
      const name = tool.name || tool.function?.name;
      if (name === CCR_TOOL_NAME) {
        return { tools: currentTools, wasInjected: false };
      }
    }

    console.log('Injecting retrieve tool');
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

    const { tools: updatedTools, wasInjected } = this.injectToolDefinition(
      tools,
      { sessionHasDoneCCR },
    );

    return {
      messages,
      tools:          updatedTools,
      toolWasInjected: wasInjected,
    };
  }
}

export function parseCCRToolCall(toolCall, provider = "openai") {
  let name, inputData;

  if (provider === "anthropic") {
    name      = toolCall.name;
    inputData = toolCall.input || {};
  } else {
    const fn = toolCall.function || {};
    name     = fn.name;
    try {
      inputData = JSON.parse(fn.arguments || "{}");
    } catch {
      inputData = {};
    }
  }

  if (name !== CCR_TOOL_NAME) return { vaultId: null, searchQuery: null };

  return {
    vaultId:     inputData.vault_id    || null,
    searchQuery: inputData.search_query || null,
  };
}