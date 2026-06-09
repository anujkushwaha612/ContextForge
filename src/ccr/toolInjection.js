/**
 * CCR Tool Injection — Port of headroom/ccr/tool_injection.py
 *
 * Injects the contextforge_retrieve tool into requests when
 * compressed content is detected. Implements the sticky-on pattern
 * (PR-B7): once injected, the tool stays for the entire session.
 */

export const CCR_TOOL_NAME = "contextforge_retrieve";

// ─────────────────────────────────────────────
// Tool definition per provider format
// ─────────────────────────────────────────────

export function createCCRToolDefinition(provider = "anthropic") {
  const description =
    "Retrieve original uncompressed content that was compressed to save tokens. " +
    "Use this when you need more data than what's shown in compressed tool results. " +
    "The vault_id is provided in compression markers like " +
    "[content compressed... vault_id=cf_vault_xxxxx].";

  if (provider === "anthropic") {
    return {
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
  }

  // OpenAI format (default — what your translated payload uses)
  return {
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

// ─────────────────────────────────────────────
// Marker detection — scans messages for vault IDs
// Multiple patterns handle different compressor formats
// ─────────────────────────────────────────────

const MARKER_PATTERNS = [
  // Standard ContextForge vault format
  /vault_id[=:]\s*["']?(cf_vault_[a-z0-9_]+)["']?/gi,
  // Tiered memory eviction format
  /Vault:\s*(cf_vault_[a-z0-9_]+)/gi,
  // Tombstone format from compressSingleMessage
  /vault_id:\s*'(cf_vault_[a-z0-9_]+)'/gi,
  // Generic fallback
  /\[.*?compressed.*?vault[_-]?id[=:]\s*([a-z0-9_]+)\]/gi,
];

/**
 * Scan messages for compression markers and extract vault IDs.
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

function extractVaultIds(text, resultSet) {
  for (const pattern of MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const vaultId = match[1];
      if (vaultId) resultSet.add(vaultId);
    }
  }
}

// ─────────────────────────────────────────────
// CCRToolInjector class
// ─────────────────────────────────────────────

export class CCRToolInjector {
  constructor({
    provider = "openai",        // "openai" after translation
    injectTool = true,
    injectSystemInstructions = false, // we use tombstone markers instead
  } = {}) {
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

  /**
   * Scan messages for compression markers.
   */
  scanForMarkers(messages) {
    this._detectedVaultIds = scanForMarkers(messages);
    return this._detectedVaultIds;
  }

  /**
   * Inject the CCR tool into the tools array.
   *
   * PR-B7 sticky-on: if sessionHasDoneCCR is true, inject even when
   * this turn has no fresh compression markers.
   */
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

    const ccrTool = createCCRToolDefinition(this.provider);
    return { tools: [...currentTools, ccrTool], wasInjected: true };
  }

  /**
   * Full request processing: scan + inject.
   */
  processRequest(messages, tools, { sessionHasDoneCCR = false } = {}) {
    this.scanForMarkers(messages);

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

/**
 * Parse a CCR tool call to extract vault_id and search_query.
 * Handles both OpenAI and Anthropic wire formats.
 */
export function parseCCRToolCall(toolCall, provider = "openai") {
  let name, inputData;

  if (provider === "anthropic") {
    name = toolCall.name;
    inputData = toolCall.input || {};
  } else {
    // OpenAI format
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