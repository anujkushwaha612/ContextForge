/**
 * Per-model compression policy.
 *
 * Ported from Headroom's auth-mode policy system.
 * Instead of auth modes (PAYG/Subscription), ContextForge uses
 * model modes (cloud-expensive / local-free / rate-limited).
 *
 * Controls:
 * - How aggressively to compress
 * - Whether to touch the stable system prompt prefix
 * - Whether to write to the learning cache (TOIN equivalent)
 */

// ─────────────────────────────────────────────
// Model mode constants
// ─────────────────────────────────────────────

export const ModelMode = {
  FAST: "fast", // small/cheap models — aggressive compression
  BALANCED: "balanced", // default
  PRECISE: "precise", // large models — conservative compression
};

// ─────────────────────────────────────────────
// Policy class
// ─────────────────────────────────────────────

export class CompressionPolicy {
  constructor({
    modelMode,
    maxLossyRatio,
    singleMsgVaultThreshold,
    adaptiveSizerBias,
    liveZoneOnly,
    learningWriteEnabled,
  }) {
    this.modelMode = modelMode;
    this.maxLossyRatio = maxLossyRatio;
    this.singleMsgVaultThreshold = singleMsgVaultThreshold;
    this.adaptiveSizerBias = adaptiveSizerBias;
    this.liveZoneOnly = liveZoneOnly;
    this.learningWriteEnabled = learningWriteEnabled;
  }
}

// ─────────────────────────────────────────────
// Policy factory
// ─────────────────────────────────────────────

/**
 * Get compression policy for a model name.
 * Infers model mode from the model name string.
 */
export function getPolicyForModel(modelName = "") {
  const m = modelName.toLowerCase();

  // ── Precise mode: large context, expensive models ──
  if (
    m.includes("opus") 
  ) {
    return policyForMode(ModelMode.PRECISE);
  }

  // ── Fast mode: small/local models ──
  if (
    m.includes("haiku") ||
    m.includes("flash") ||
    m.includes("mini") ||
    m.includes("small") ||
    m.includes("7b") ||
    m.includes("8b")
  ) {
    return policyForMode(ModelMode.FAST);
  }

  // ── Default: balanced ──
  return policyForMode(ModelMode.BALANCED);
}

export function policyForMode(mode) {
  switch (mode) {
    case ModelMode.FAST:
      return {
        mode,

        // Tool result handling
        maxToolResults: 5,
        singleMsgVaultThreshold: 6_000, // vault sooner (small context)
        toolResultSliceLines: 30,

        // Adaptive sizer
        adaptiveSizerBias: 0.6, // keep fewer items
        adaptiveSizerMinK: 2,
        adaptiveSizerMaxK: 6,
        simhashThreshold: 4, // more aggressive dedup

        // Code compression
        maxBodyLines: 2,
        preserveErrorHandlers: false,

        // Conversation
        maxConversationTurns: 6,
        systemPromptMaxTokens: 500,
      };

    case ModelMode.PRECISE:
      return {
        mode,

        // Tool result handling
        maxToolResults: 20,
        singleMsgVaultThreshold: 15000, // vault only truly massive results
        toolResultSliceLines: 150,

        // Adaptive sizer
        adaptiveSizerBias: 1.2, // keep more items
        adaptiveSizerMinK: 5,
        adaptiveSizerMaxK: null, // no cap
        simhashThreshold: 2, // conservative dedup

        // Code compression
        maxBodyLines: 6,
        preserveErrorHandlers: true,

        // Conversation
        maxConversationTurns: 20,
        systemPromptMaxTokens: 2000,
      };

    case ModelMode.BALANCED:
    default:
      return {
        mode,

        // Tool result handling
        maxToolResults: 10,
        singleMsgVaultThreshold: 10_000, // current hardcoded value preserved
        toolResultSliceLines: 80,

        // Adaptive sizer
        adaptiveSizerBias: 1.0,
        adaptiveSizerMinK: 3,
        adaptiveSizerMaxK: null,
        simhashThreshold: 3,

        // Code compression
        maxBodyLines: 4,
        preserveErrorHandlers: true,

        // Conversation
        maxConversationTurns: 12,
        systemPromptMaxTokens: 1000,
      };
  }
}

/**
 * Infer model mode from model name string.
 * Extend this as you add new model routes.
 */
export function inferModelMode(modelName) {
  const lower = (modelName || "").toLowerCase();

  // Local Ollama models
  if (
    lower.includes("ollama") ||
    lower.includes(":latest") ||
    lower.includes("llama") ||
    lower.includes("mistral") ||
    lower.includes("qwen") ||
    lower.includes("phi") ||
    lower.includes("gemma") ||
    (lower.includes("minimax-m3:cloud") === false && lower.includes("minimax"))
  ) {
    return ModelMode.LOCAL_FREE;
  }

  // Cloud expensive models
  if (
    lower.includes("nemotron") ||
    lower.includes("claude") ||
    lower.includes("gpt-4") ||
    lower.includes("gemini-pro") ||
    lower.includes("minimax-m3:cloud")
  ) {
    return ModelMode.CLOUD_EXPENSIVE;
  }

  // Rate-limited free-tier APIs
  if (
    lower.includes("groq") ||
    lower.includes("together") ||
    lower.includes("fireworks") ||
    lower.includes("deepseek")
  ) {
    return ModelMode.RATE_LIMITED;
  }

  // Default: treat unknown as rate-limited (moderate/safe)
  return ModelMode.RATE_LIMITED;
}

// ─────────────────────────────────────────────
// Default policy (used when model is unknown)
// ─────────────────────────────────────────────

export function defaultPolicy() {
  return policyForMode(ModelMode.RATE_LIMITED);
}
