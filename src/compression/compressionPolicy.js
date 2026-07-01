/**
 * compressionPolicy.js
 *
 * Per-model compression policy.
 *
 * Controls three pipeline parameters:
 *   - singleMsgVaultThreshold  → fatCatch.js vault trigger (in chars, not tokens)
 *   - maxBodyLines             → astCompressor.js C++ body line cap
 *   - preserveErrorHandlers    → astCompressor.js C++ error handler preservation
 *
 * On the threshold values:
 *   The threshold is in CHARACTERS not tokens (4 chars ≈ 1 token).
 *   6,000 chars ≈ 1,500 tokens. 150,000 chars ≈ 37,500 tokens.
 *
 *   Vaulting has a cost: it forces an extra LLM round-trip to retrieve.
 *   Only vault when the content is genuinely too large to fit usefully
 *   in the context window. For local models (Ollama), token count is free
 *   so vaulting only adds latency — set threshold high.
 *   For paid cloud models, vault aggressively to save money.
 *
 * Why mode still exists:
 *   Reserved for when direct cloud API billing is added. With Ollama,
 *   all models effectively use BALANCED behavior since cost is zero.
 */

export const ModelMode = {
  FAST: "fast",
  BALANCED: "balanced",
  PRECISE: "precise",
};

export class CompressionPolicy {
  constructor({ mode, singleMsgVaultThreshold, maxBodyLines, preserveErrorHandlers }) {
    this.mode = mode;
    this.singleMsgVaultThreshold = singleMsgVaultThreshold;
    this.maxBodyLines = maxBodyLines;
    this.preserveErrorHandlers = preserveErrorHandlers;
    Object.freeze(this);
  }
}

export function policyForMode(mode) {
  switch (mode) {
    case ModelMode.FAST:
      // Local/cheap models — token cost is zero.
      // Vault threshold is HIGH: avoid unnecessary round-trips.
      // Body lines are low: local models have smaller context windows.
      return new CompressionPolicy({
        mode,
        singleMsgVaultThreshold: 100_000, // ~25,000 tokens — vault only truly massive results
        maxBodyLines: 2,
        preserveErrorHandlers: false,
      });

    case ModelMode.PRECISE:
      return new CompressionPolicy({
        mode,
        singleMsgVaultThreshold: 8_000, // ~2,000 tokens — vault aggressively for paid APIs
        maxBodyLines: 6,
        preserveErrorHandlers: true,
      });

    default:
      return new CompressionPolicy({
        mode,
        singleMsgVaultThreshold: 60_000, // ~15,000 tokens
        maxBodyLines: 4,
        preserveErrorHandlers: true,
      });
  }
}

// ─────────────────────────────────────────────
// Model name → mode inference
// ─────────────────────────────────────────────

const MODEL_MODE_REGISTRY = {
  // Anthropic
  "claude-opus-4": ModelMode.PRECISE,
  "claude-sonnet-4": ModelMode.BALANCED,
  "claude-haiku-4": ModelMode.FAST,
  "claude-3-5-sonnet": ModelMode.BALANCED,
  "claude-3-5-haiku": ModelMode.FAST,
  "claude-3-sonnet": ModelMode.BALANCED,
  "claude-3-haiku": ModelMode.FAST,

  // OpenAI
  "gpt-4o": ModelMode.PRECISE,
  "gpt-4o-mini": ModelMode.FAST,
  "gpt-4": ModelMode.PRECISE,
  o1: ModelMode.PRECISE,
  o3: ModelMode.PRECISE,

  // Google
  "gemini-2.5-pro": ModelMode.PRECISE,
  "gemini-2.5-flash": ModelMode.FAST,
  "gemini-1.5-pro": ModelMode.BALANCED,
  "gemini-1.5-flash": ModelMode.FAST,

  // Local
  ollama: ModelMode.FAST,
  "lm-studio": ModelMode.FAST,
};

export function inferModelMode(modelName = "") {
  const lower = modelName.toLowerCase();

  // Exact match
  if (MODEL_MODE_REGISTRY[lower] !== undefined) {
    return MODEL_MODE_REGISTRY[lower];
  }

  // Starts-with match (handles date suffixes like claude-sonnet-4-5-20250514)
  for (const [key, mode] of Object.entries(MODEL_MODE_REGISTRY)) {
    if (lower.startsWith(key)) return mode;
  }

  // Substring heuristics
  if (lower.includes("claude-opus")) return ModelMode.PRECISE;
  if (lower.includes("claude-sonnet")) return ModelMode.BALANCED;
  if (lower.includes("claude-haiku")) return ModelMode.FAST;
  if (lower.includes("gpt-4o-mini")) return ModelMode.FAST;
  if (lower.includes("gpt-4o")) return ModelMode.PRECISE;
  if (lower.includes("gpt-4")) return ModelMode.PRECISE;
  if (lower.includes("gemini-pro")) return ModelMode.PRECISE;
  if (lower.includes("gemini-flash")) return ModelMode.FAST;
  if (lower.includes("gemini")) return ModelMode.BALANCED;
  if (lower.includes("llama")) return ModelMode.FAST;
  if (lower.includes("mistral")) return ModelMode.FAST;
  if (lower.includes("deepseek")) return ModelMode.BALANCED;
  if (lower.includes(":latest")) return ModelMode.FAST;

  // Default
  return ModelMode.BALANCED;
}

// ─────────────────────────────────────────────
// Primary export — called from server.js
// ─────────────────────────────────────────────

export function getPolicyForModel(modelName = "") {
  const mode = inferModelMode(modelName);
  return policyForMode(mode);
}

export function defaultPolicy() {
  return policyForMode(ModelMode.BALANCED);
}
