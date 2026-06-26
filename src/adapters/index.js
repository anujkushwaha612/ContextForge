/**
 * adapters/index.js
 *
 * Adapter registry and auto-detection.
 * Detects client format from URL and headers.
 */

import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIAdapter } from "./openai.js";
import { GeminiAdapter } from "./gemini.js";

const _adapters = {
  anthropic: new AnthropicAdapter(),
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
};

// /**
//  * Detect adapter from incoming request.
//  *
//  * Detection priority:
//  *   1. Gemini URL pattern (/models/*/generateContent)
//  *   2. Gemini API key header (x-goog-api-key)
//  *   3. Anthropic URL (/v1/messages)
//  *   4. Anthropic version header
//  *   5. OpenAI (default — catches /v1/chat/completions and everything else)
//  *
//  * @param {string} url
//  * @param {object} headers
//  * @returns {{ adapter, isStreaming, modelOverride }}
//  */
export function detectAdapter(url, headers) {
  // ── Gemini ──
  const isGeminiUrl =
    url.includes("generateContent") || url.includes("streamGenerateContent");
  const isGeminiHeader = headers["x-goog-api-key"] !== undefined;

  if (isGeminiUrl || isGeminiHeader) {
    const isStreaming = url.includes("streamGenerateContent");

    const modelMatch = url.match(/\/models\/([^/:?]+)/);
    const modelOverride = modelMatch ? decodeURIComponent(modelMatch[1]) : null;

    if (modelOverride) headers["x-cf-model"] = modelOverride;

    // Pass streaming intent to toInternal via headers
    if (isStreaming) headers["x-cf-streaming"] = "true";

    return {
      adapter: _adapters.gemini,
      isStreaming,
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
      isStreaming: false,
      modelOverride: null,
    };
  }

  // ── OpenAI (default) ──
  // Catches: /v1/chat/completions, LM Studio, Ollama clients,
  // Continue, Aider, and any OpenAI-compatible tool.
  return {
    adapter: _adapters.openai,
    isStreaming: false,
    modelOverride: null,
  };
}

export function getAdapter(name) {
  return _adapters[name] || _adapters.openai;
}

export { AnthropicAdapter, OpenAIAdapter, GeminiAdapter };
