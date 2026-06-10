/**
 * Per-model compression policy.
 *
 * Controls:
 * - How aggressively to compress
 * - Vault thresholds
 * - Adaptive sizer behavior
 * - Code compression depth
 * - Conversation history limits
 */

// ─────────────────────────────────────────────
// Model mode constants
// ─────────────────────────────────────────────

export const ModelMode = {
  FAST:     "fast",     // small/local models — aggressive compression
  BALANCED: "balanced", // default — moderate compression
  PRECISE:  "precise",  // large/expensive models — conservative compression
};

// ─────────────────────────────────────────────
// Policy class
// ─────────────────────────────────────────────

export class CompressionPolicy {
  constructor({
    mode,
    maxToolResults,
    singleMsgVaultThreshold,
    toolResultSliceLines,
    adaptiveSizerBias,
    adaptiveSizerMinK,
    adaptiveSizerMaxK,
    simhashThreshold,
    maxBodyLines,
    preserveErrorHandlers,
    maxConversationTurns,
    systemPromptMaxTokens,
  }) {
    this.mode                    = mode;
    this.maxToolResults          = maxToolResults;
    this.singleMsgVaultThreshold = singleMsgVaultThreshold;
    this.toolResultSliceLines    = toolResultSliceLines;
    this.adaptiveSizerBias       = adaptiveSizerBias;
    this.adaptiveSizerMinK       = adaptiveSizerMinK;
    this.adaptiveSizerMaxK       = adaptiveSizerMaxK;
    this.simhashThreshold        = simhashThreshold;
    this.maxBodyLines            = maxBodyLines;
    this.preserveErrorHandlers   = preserveErrorHandlers;
    this.maxConversationTurns    = maxConversationTurns;
    this.systemPromptMaxTokens   = systemPromptMaxTokens;
  }
}

// ─────────────────────────────────────────────
// Policy factory
// ─────────────────────────────────────────────

export function policyForMode(mode) {
  switch (mode) {

    case ModelMode.FAST:
      return new CompressionPolicy({
        mode,

        // Tool result handling
        maxToolResults:          5,
        singleMsgVaultThreshold: 6_000,  // vault sooner — small context window
        toolResultSliceLines:    30,

        // Adaptive sizer
        adaptiveSizerBias:   0.6,  // keep fewer items
        adaptiveSizerMinK:   2,
        adaptiveSizerMaxK:   6,
        simhashThreshold:    4,    // more aggressive dedup

        // Code compression
        maxBodyLines:           2,
        preserveErrorHandlers:  false,

        // Conversation
        maxConversationTurns:   6,
        systemPromptMaxTokens:  500,
      });

    case ModelMode.PRECISE:
      return new CompressionPolicy({
        mode,

        // Tool result handling
        maxToolResults:          20,
        singleMsgVaultThreshold: 20_000, // only vault truly massive results
        toolResultSliceLines:    150,

        // Adaptive sizer
        adaptiveSizerBias:   1.2,  // keep more items
        adaptiveSizerMinK:   5,
        adaptiveSizerMaxK:   null, // no cap
        simhashThreshold:    2,    // conservative dedup

        // Code compression
        maxBodyLines:           6,
        preserveErrorHandlers:  true,

        // Conversation
        maxConversationTurns:   20,
        systemPromptMaxTokens:  2000,
      });

    case ModelMode.BALANCED:
    default:
      return new CompressionPolicy({
        mode,

        // Tool result handling
        maxToolResults:          10,
        singleMsgVaultThreshold: 15_000,
        toolResultSliceLines:    80,

        // Adaptive sizer
        adaptiveSizerBias:   1.0,
        adaptiveSizerMinK:   3,
        adaptiveSizerMaxK:   null,
        simhashThreshold:    3,

        // Code compression
        maxBodyLines:           4,
        preserveErrorHandlers:  true,

        // Conversation
        maxConversationTurns:   12,
        systemPromptMaxTokens:  1000,
      });
  }
}

// ─────────────────────────────────────────────
// Explicit model → mode registry
//
// Checked before heuristic substring matching.
// Add new models here first; fall through to
// inferModelMode() only for unknowns.
// ─────────────────────────────────────────────

const MODEL_MODE_REGISTRY = {

  // ── Anthropic ─────────────────────────────────────────────────────────────

  // Claude Opus 4.x — flagship, quality-critical
  "claude-opus-4":   ModelMode.PRECISE,
  "claude-opus-4-5": ModelMode.PRECISE,
  "claude-opus-4-6": ModelMode.PRECISE,
  "claude-opus-4-7": ModelMode.PRECISE,
  "claude-opus-4-8": ModelMode.PRECISE,

  // Claude Sonnet 4.x — mid-tier, balanced
  "claude-sonnet-4":   ModelMode.BALANCED,
  "claude-sonnet-4-5": ModelMode.BALANCED,
  "claude-sonnet-4-6": ModelMode.BALANCED,

  // Claude Haiku 4.x — fast / cheap
  "claude-haiku-4":   ModelMode.FAST,
  "claude-haiku-4-5": ModelMode.FAST,

  // Legacy 3.x
  "claude-3-5-sonnet": ModelMode.BALANCED,
  "claude-3-5-haiku":  ModelMode.FAST,
  "claude-3-sonnet":   ModelMode.BALANCED,
  "claude-3-haiku":    ModelMode.FAST,

  // ── OpenAI ────────────────────────────────────────────────────────────────

  // GPT-5.5
  "gpt-5.5":      ModelMode.PRECISE,
  "gpt-5.5-mini": ModelMode.BALANCED,

  // GPT-5
  "gpt-5":      ModelMode.PRECISE,
  "gpt-5-mini": ModelMode.BALANCED,

  // GPT-4.1
  "gpt-4.1":      ModelMode.BALANCED,
  "gpt-4.1-mini": ModelMode.FAST,
  "gpt-4.1-nano": ModelMode.FAST,

  // GPT-4o
  "gpt-4o":      ModelMode.PRECISE,
  "gpt-4o-mini": ModelMode.FAST,

  // Reasoning — o-series
  "o4":      ModelMode.PRECISE,
  "o4-mini": ModelMode.BALANCED,
  "o3":      ModelMode.PRECISE,
  "o3-pro":  ModelMode.PRECISE,
  "o3-mini": ModelMode.BALANCED,
  "o1":      ModelMode.PRECISE,
  "o1-pro":  ModelMode.PRECISE,
  "o1-mini": ModelMode.BALANCED,

  // Codex
  "codex-mini": ModelMode.BALANCED,

  // Legacy
  "gpt-4-turbo": ModelMode.PRECISE,
  "gpt-4":       ModelMode.PRECISE,

  // ── Google Gemini ─────────────────────────────────────────────────────────

  // Gemini 2.5
  "gemini-2.5-pro":        ModelMode.PRECISE,
  "gemini-2.5-flash":      ModelMode.FAST,
  "gemini-2.5-flash-lite": ModelMode.FAST,

  // Gemini 2.0
  "gemini-2.0-flash": ModelMode.FAST,

  // Gemini 1.5 (legacy)
  "gemini-1.5-pro":   ModelMode.BALANCED,
  "gemini-1.5-flash": ModelMode.FAST,

  // ── DeepSeek ──────────────────────────────────────────────────────────────

  "deepseek-r1-0528":              ModelMode.BALANCED,
  "deepseek-r1":                   ModelMode.BALANCED,
  "deepseek-v3-0324":              ModelMode.BALANCED,
  "deepseek-v3":                   ModelMode.BALANCED,
  "deepseek-v3-2":                 ModelMode.BALANCED,
  "deepseek-prover-v2":            ModelMode.BALANCED,
  "deepseek-r1-distill-llama-70b": ModelMode.FAST,
  "deepseek-coder":                ModelMode.FAST,

  // ── Meta Llama ────────────────────────────────────────────────────────────

  // Llama 4
  "llama-4-behemoth": ModelMode.PRECISE,
  "llama-4-maverick": ModelMode.BALANCED,
  "llama-4-scout":    ModelMode.FAST,

  // Llama 3.x
  "llama-3.3-70b":  ModelMode.BALANCED,
  "llama-3.1-405b": ModelMode.PRECISE,
  "llama-3.1-70b":  ModelMode.BALANCED,
  "llama-3.1-8b":   ModelMode.FAST,
  "llama-3-70b":    ModelMode.BALANCED,

  // ── Mistral ───────────────────────────────────────────────────────────────

  "mistral-large":    ModelMode.BALANCED,
  "mistral-large-2":  ModelMode.BALANCED,
  "mistral-medium":   ModelMode.BALANCED,
  "mistral-medium-3": ModelMode.BALANCED,
  "mistral-small":       ModelMode.FAST,
  "mistral-small-3.1":   ModelMode.FAST,
  "mistral-7b":          ModelMode.FAST,
  "mistral-nemo":        ModelMode.FAST,
  "devstral-small":      ModelMode.FAST,
  "mixtral-8x7b":        ModelMode.BALANCED,
  "mixtral-8x22b":       ModelMode.BALANCED,
  "codestral":           ModelMode.FAST,
  "codestral-mamba":     ModelMode.FAST,

  // ── xAI Grok ──────────────────────────────────────────────────────────────

  "grok-4":      ModelMode.PRECISE,
  "grok-3":      ModelMode.PRECISE,
  "grok-3-fast": ModelMode.PRECISE,
  "grok-3-mini": ModelMode.FAST,
  "grok-2":      ModelMode.BALANCED,

  // ── Cohere ────────────────────────────────────────────────────────────────

  "command-a":       ModelMode.BALANCED,
  "command-r-plus":  ModelMode.BALANCED,
  "command-r":       ModelMode.FAST,
  "command-r7b":     ModelMode.FAST,

  // ── Qwen (Alibaba) ────────────────────────────────────────────────────────

  "qwen3-235b-a22b": ModelMode.PRECISE,
  "qwen3-30b-a3b":   ModelMode.BALANCED,
  "qwen3-32b":       ModelMode.BALANCED,
  "qwen3-8b":        ModelMode.FAST,
  "qwen3-4b":        ModelMode.FAST,
  "qwen2.5-72b":     ModelMode.BALANCED,
  "qwen2.5-7b":      ModelMode.FAST,
  "qwen-max":        ModelMode.BALANCED,
  "qwen-plus":       ModelMode.FAST,

  // ── Amazon Nova ───────────────────────────────────────────────────────────

  "nova-premier": ModelMode.PRECISE,
  "nova-pro":     ModelMode.BALANCED,
  "nova-lite":    ModelMode.FAST,
  "nova-micro":   ModelMode.FAST,

  // ── Microsoft Phi ─────────────────────────────────────────────────────────

  "phi-4":      ModelMode.FAST,
  "phi-4-mini": ModelMode.FAST,

  // ── AI21 Jamba ────────────────────────────────────────────────────────────

  "jamba-1.5-large": ModelMode.BALANCED,
  "jamba-1.5-mini":  ModelMode.FAST,

  // ── Local / self-hosted ───────────────────────────────────────────────────

  "ollama":    ModelMode.FAST,
  "lm-studio": ModelMode.FAST,
};

// ─────────────────────────────────────────────
// Model name → mode inference
// ─────────────────────────────────────────────

/**
 * Infer ModelMode from a model name string.
 *
 * Resolution order:
 *  1. Exact match in MODEL_MODE_REGISTRY
 *  2. Starts-with match in MODEL_MODE_REGISTRY (handles date suffixes like -20250514)
 *  3. Substring heuristics — most specific first
 *  4. Default → BALANCED
 */
export function inferModelMode(modelName = "") {
  const lower = modelName.toLowerCase();

  // ── 1. Exact match ──
  if (MODEL_MODE_REGISTRY[lower] !== undefined) {
    return MODEL_MODE_REGISTRY[lower];
  }

  // ── 2. Starts-with match (versioned suffixes) ──
  for (const [key, mode] of Object.entries(MODEL_MODE_REGISTRY)) {
    if (lower.startsWith(key)) return mode;
  }

  // ── 3. Substring heuristics ──────────────────────────────────────────────
  // Listed most-specific → least-specific within each family.

  // Anthropic
  if (lower.includes("claude-opus"))   return ModelMode.PRECISE;
  if (lower.includes("claude-sonnet")) return ModelMode.BALANCED;
  if (lower.includes("claude-haiku"))  return ModelMode.FAST;

  // OpenAI — GPT-5.x
  if (lower.includes("gpt-5.5-mini"))  return ModelMode.BALANCED;
  if (lower.includes("gpt-5.5"))       return ModelMode.PRECISE;
  if (lower.includes("gpt-5-mini"))    return ModelMode.BALANCED;
  if (lower.includes("gpt-5"))         return ModelMode.PRECISE;
  // OpenAI — GPT-4.x
  if (lower.includes("gpt-4.1-nano"))  return ModelMode.FAST;
  if (lower.includes("gpt-4.1-mini"))  return ModelMode.FAST;
  if (lower.includes("gpt-4.1"))       return ModelMode.BALANCED;
  if (lower.includes("gpt-4o-mini"))   return ModelMode.FAST;
  if (lower.includes("gpt-4o"))        return ModelMode.PRECISE;
  if (lower.includes("gpt-4"))         return ModelMode.PRECISE;
  // OpenAI — o-series (check mini/pro before base)
  if (lower.includes("o4-mini"))       return ModelMode.BALANCED;
  if (lower.includes("o4"))            return ModelMode.PRECISE;
  if (lower.includes("o3-pro"))        return ModelMode.PRECISE;
  if (lower.includes("o3-mini"))       return ModelMode.BALANCED;
  if (lower.includes("o3"))            return ModelMode.PRECISE;
  if (lower.includes("o1-pro"))        return ModelMode.PRECISE;
  if (lower.includes("o1-mini"))       return ModelMode.BALANCED;
  if (lower.includes("o1"))            return ModelMode.PRECISE;
  // OpenAI — Codex
  if (lower.includes("codex"))         return ModelMode.BALANCED;

  // Google — check flash-lite before flash, pro before generic gemini
  if (lower.includes("gemini-2.5-flash-lite")) return ModelMode.FAST;
  if (lower.includes("gemini-2.5-flash"))      return ModelMode.FAST;
  if (lower.includes("gemini-2.5-pro"))        return ModelMode.PRECISE;
  if (lower.includes("gemini-2.0-flash"))      return ModelMode.FAST;
  if (lower.includes("gemini-1.5-flash"))      return ModelMode.FAST;
  if (lower.includes("gemini-1.5-pro"))        return ModelMode.BALANCED;
  if (lower.includes("gemini-pro"))            return ModelMode.PRECISE;
  if (lower.includes("gemini-flash"))          return ModelMode.FAST;
  if (lower.includes("gemini"))                return ModelMode.BALANCED;

  // DeepSeek
  if (lower.includes("deepseek-prover"))       return ModelMode.BALANCED;
  if (lower.includes("deepseek-r1"))           return ModelMode.BALANCED;
  if (lower.includes("deepseek-v3"))           return ModelMode.BALANCED;
  if (lower.includes("deepseek"))              return ModelMode.BALANCED;

  // Llama — 4 before 3 to avoid wrong match
  if (lower.includes("llama-4-behemoth"))      return ModelMode.PRECISE;
  if (lower.includes("llama-4-maverick"))      return ModelMode.BALANCED;
  if (lower.includes("llama-4-scout"))         return ModelMode.FAST;
  if (lower.includes("llama-4"))               return ModelMode.BALANCED;
  if (lower.includes("llama-3.1-405b"))        return ModelMode.PRECISE;
  if (lower.includes("llama-3.3"))             return ModelMode.BALANCED;
  if (lower.includes("llama-3.1-8b"))          return ModelMode.FAST;
  if (lower.includes("llama-3.1"))             return ModelMode.BALANCED;
  if (lower.includes("llama-3"))               return ModelMode.BALANCED;
  if (lower.includes("llama"))                 return ModelMode.FAST;

  // Mistral family — specific before generic
  if (lower.includes("mixtral-8x22b"))         return ModelMode.BALANCED;
  if (lower.includes("mixtral"))               return ModelMode.BALANCED;
  if (lower.includes("codestral"))             return ModelMode.FAST;
  if (lower.includes("devstral"))              return ModelMode.FAST;
  if (lower.includes("mistral-large"))         return ModelMode.BALANCED;
  if (lower.includes("mistral-medium"))        return ModelMode.BALANCED;
  if (lower.includes("mistral-small"))         return ModelMode.FAST;
  if (lower.includes("mistral-nemo"))          return ModelMode.FAST;
  if (lower.includes("mistral"))               return ModelMode.FAST;

  // xAI Grok
  if (lower.includes("grok-4"))                return ModelMode.PRECISE;
  if (lower.includes("grok-3-mini"))           return ModelMode.FAST;
  if (lower.includes("grok-3"))                return ModelMode.PRECISE;
  if (lower.includes("grok"))                  return ModelMode.BALANCED;

  // Cohere
  if (lower.includes("command-a"))             return ModelMode.BALANCED;
  if (lower.includes("command-r-plus"))        return ModelMode.BALANCED;
  if (lower.includes("command-r7b"))           return ModelMode.FAST;
  if (lower.includes("command-r"))             return ModelMode.FAST;

  // Qwen — specific before generic
  if (lower.includes("qwen3-235b"))            return ModelMode.PRECISE;
  if (lower.includes("qwen3-30b"))             return ModelMode.BALANCED;
  if (lower.includes("qwen3-32b"))             return ModelMode.BALANCED;
  if (lower.includes("qwen3-8b"))              return ModelMode.FAST;
  if (lower.includes("qwen3-4b"))              return ModelMode.FAST;
  if (lower.includes("qwen3"))                 return ModelMode.BALANCED;
  if (lower.includes("qwen2.5-72b"))           return ModelMode.BALANCED;
  if (lower.includes("qwen2.5-7b"))            return ModelMode.FAST;
  if (lower.includes("qwen-max"))              return ModelMode.BALANCED;
  if (lower.includes("qwen-plus"))             return ModelMode.FAST;
  if (lower.includes("qwen"))                  return ModelMode.BALANCED;

  // Amazon Nova
  if (lower.includes("nova-premier"))          return ModelMode.PRECISE;
  if (lower.includes("nova-pro"))              return ModelMode.BALANCED;
  if (lower.includes("nova-lite"))             return ModelMode.FAST;
  if (lower.includes("nova-micro"))            return ModelMode.FAST;
  if (lower.includes("nova"))                  return ModelMode.BALANCED;

  // Microsoft Phi
  if (lower.includes("phi-4-mini"))            return ModelMode.FAST;
  if (lower.includes("phi-4"))                 return ModelMode.FAST;
  if (lower.includes("phi"))                   return ModelMode.FAST;

  // AI21 Jamba
  if (lower.includes("jamba-1.5-large"))       return ModelMode.BALANCED;
  if (lower.includes("jamba-1.5-mini"))        return ModelMode.FAST;
  if (lower.includes("jamba"))                 return ModelMode.FAST;

  // Gemma (free-tier / Groq-hosted)
  if (lower.includes("gemma"))                 return ModelMode.FAST;

  // Nemotron (NVIDIA large model)
  if (lower.includes("nemotron"))              return ModelMode.PRECISE;

  // Local / self-hosted
  if (
    lower.includes("ollama")    ||
    lower.includes(":latest")   ||
    lower.includes("lm-studio")
  ) return ModelMode.FAST;

  // ── 4. Unknown — default to BALANCED ──
  return ModelMode.BALANCED;
}

// ─────────────────────────────────────────────
// Primary export: getPolicyForModel
// ─────────────────────────────────────────────

/**
 * Get compression policy for a model name.
 * This is the function called from server.js.
 */
export function getPolicyForModel(modelName = "") {
  const mode = inferModelMode(modelName);
  return policyForMode(mode);
}

// ─────────────────────────────────────────────
// Default policy (used when model is unknown)
// ─────────────────────────────────────────────

export function defaultPolicy() {
  return policyForMode(ModelMode.BALANCED);
}