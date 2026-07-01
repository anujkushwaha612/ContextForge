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
  FAST:     "fast",
  BALANCED: "balanced",
  PRECISE:  "precise",
};

export class CompressionPolicy {
  constructor({ mode, singleMsgVaultThreshold, maxBodyLines, preserveErrorHandlers }) {
    this.mode                    = mode;
    this.singleMsgVaultThreshold = singleMsgVaultThreshold;
    this.maxBodyLines            = maxBodyLines;
    this.preserveErrorHandlers   = preserveErrorHandlers;
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
        singleMsgVaultThreshold: 100_000,  // ~25,000 tokens — vault only truly massive results
        maxBodyLines:            2,
        preserveErrorHandlers:   false,
      });


    case ModelMode.BALANCED:
    default:
      return new CompressionPolicy({
        mode,
        singleMsgVaultThreshold: 60_000,  // ~10,000 tokens
        maxBodyLines:            4,
        preserveErrorHandlers:   true,
      });
  }
}