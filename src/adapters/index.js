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
 * Detection priority:
 *   1. Gemini URL pattern (/models/.../generateContent)
 *   2. Gemini API key header (x-goog-api-key)
 *   3. Anthropic URL (/v1/messages)
 *   4. Anthropic version header
 *   5. OpenAI (default — /v1/chat/completions, LM Studio, Ollama, etc.)
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
  // ── Gemini ──
  const isGeminiUrl =
    url.includes("generateContent") || url.includes("streamGenerateContent");
  const isGeminiHeader = headers["x-goog-api-key"] !== undefined;

  if (isGeminiUrl || isGeminiHeader) {
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

  // ── Anthropic ──
  if (
    url.includes("/v1/messages") ||
    headers["anthropic-version"] !== undefined ||
    (headers["x-api-key"] !== undefined && !isGeminiHeader)
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