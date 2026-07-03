/**
 * adapters/index.js
 *
 * Adapter registry and auto-detection.
 * Detects client format from URL and headers.
 *
 * IMPORTANT: detectAdapter runs BEFORE request body is parsed.
 * It can only inspect URL and headers. Streaming detection for
 * Anthropic/OpenAI must happen AFTER toInternal() by checking
 * payload.stream — only Gemini can detect from URL alone.
 */

import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIAdapter } from "./openai.js";
import { GeminiAdapter } from "./gemini.js";

const _adapters = {
  anthropic: new AnthropicAdapter(),
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
};

/**
 * Detect adapter from incoming request.
 *
 * Detection priority (IDX-1: URLs before headers — auth headers get
 * cross-sent by proxies/tools and must never override an unambiguous URL):
 *   1. Gemini URL pattern (/models/.../generateContent)
 *   2. OpenAI URL (/v1/chat/completions)
 *   3. Gemini API key header (x-goog-api-key)
 *   4. Anthropic URL (/v1/messages) / version header / x-api-key
 *   5. OpenAI (default — LM Studio, Ollama, Continue, Aider, etc.)
 *
 * Streaming detection:
 *   - Gemini: URL contains "streamGenerateContent" → known at detection time
 *   - Anthropic/OpenAI: body field "stream: true" → unknown until toInternal
 *
 * @param {string} url
 * @param {object} headers
 * @returns {{ adapter, isStreaming, modelOverride }}
 */
export function detectAdapter(url, headers) {
  // IDX-1 FIX: URL shape is a stronger signal than auth headers.
  // Real clients cross-send auth headers (LiteLLM sends x-api-key to
  // OpenAI-shaped endpoints; some tools send both x-api-key and
  // Authorization). Old order let a header hijack a URL that already
  // unambiguously identified the wire format. New priority:
  //   1. Gemini URL  2. OpenAI URL  3. Anthropic URL
  //   4. Gemini header  5. Anthropic headers  6. OpenAI (default)

  // ── Gemini by URL ──
  const isGeminiUrl =
    url.includes("generateContent") || url.includes("streamGenerateContent");
  const isGeminiHeader = headers["x-goog-api-key"] !== undefined;

  if (isGeminiUrl) {
    const isStreaming = url.includes("streamGenerateContent");

    // Extract model from URL: /v1/models/{model}:generateContent
    const modelMatch = url.match(/\/models\/([^/:?]+)/);
    const modelOverride = modelMatch ? decodeURIComponent(modelMatch[1]) : null;

    // Pass extracted model to toInternal via header
    if (modelOverride) headers["x-cf-model"] = modelOverride;

    // Pass streaming intent to toInternal via header
    if (isStreaming) headers["x-cf-streaming"] = "true";

    return {
      adapter: _adapters.gemini,
      isStreaming,       // ✅ Known from URL
      modelOverride,
    };
  }

  // ── OpenAI by explicit URL ──
  // IDX-1 FIX: An OpenAI-format client POSTing to /v1/chat/completions may
  // also send an x-api-key header (LiteLLM, some proxies/tools do). The old
  // order fell through to the x-api-key → anthropic branch, which then ran
  // translateAnthropicToOpenAI on an already-OpenAI payload (garbage out).
  // The URL is a stronger signal than the auth header — check it first.
  if (url.includes("/v1/chat/completions")) {
    return {
      adapter: _adapters.openai,
      isStreaming: null,
      modelOverride: null,
    };
  }

  // ── Gemini by header (non-standard URL) ──
  if (isGeminiHeader) {
    return {
      adapter: _adapters.gemini,
      isStreaming: false, // no streamGenerateContent in URL → assume non-stream
      modelOverride: null,
    };
  }

  // ── Anthropic ──
  if (
    url.includes("/v1/messages") ||
    headers["anthropic-version"] !== undefined ||
    headers["x-api-key"] !== undefined
  ) {
    return {
      adapter: _adapters.anthropic,
      isStreaming: null,  // FIX: Unknown until body is parsed
      modelOverride: null,
    };
  }

  // ── OpenAI (default) ──
  // Catches: /v1/chat/completions, LM Studio, Ollama clients,
  // Continue, Aider, and any OpenAI-compatible tool.
  return {
    adapter: _adapters.openai,
    isStreaming: null,  // FIX: Unknown until body is parsed
    modelOverride: null,
  };
}

/**
 * Get adapter by name.
 * @param {string} name — "anthropic" | "openai" | "gemini"
 * @returns {AnthropicAdapter | OpenAIAdapter | GeminiAdapter}
 */
export function getAdapter(name) {
  return _adapters[name] || _adapters.openai;
}

// Explicit exports for better bundler compatibility
export { AnthropicAdapter, OpenAIAdapter, GeminiAdapter };