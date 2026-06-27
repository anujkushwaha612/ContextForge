/**
 * openai.js
 *
 * Adapter for clients speaking the OpenAI Chat Completions format.
 * Handles: Cursor (OpenAI mode), Continue, Aider, LM Studio,
 * Ollama clients, any OpenAI-compatible tool.
 *
 * Ingress:  OpenAI payload  → OpenAI internal format (passthrough)
 * Egress:   OpenAI response → OpenAI response format (passthrough)
 *
 * This adapter is mostly a passthrough — the pipeline already
 * operates in OpenAI format internally.
 */

import { createTranslationContext } from "../proxy/translator.js";

export class OpenAIAdapter {
  constructor() {
    this._name = "openai";
  }

  get name() {
    return this._name;
  }

  /**
   * OpenAI format is already the internal format.
   * Still create a translation context for pipeline compatibility.
   *
   * Normalizations applied:
   *   - Remove fields the pipeline doesn't understand
   *   - Ensure messages array exists
   *   - Normalize tool format if needed
   */
  toInternal(clientPayload, requestHeaders) {
    const translationCtx = createTranslationContext();

    // Shallow clone — don't mutate caller's object
    const payload = { ...clientPayload };

    // Remove OpenAI-specific fields that would confuse Ollama
    delete payload.logprobs;
    delete payload.top_logprobs;
    delete payload.store;
    delete payload.metadata;

    // Normalize: some OpenAI clients send max_completion_tokens
    // instead of max_tokens — normalize to max_tokens
    if (payload.max_completion_tokens && !payload.max_tokens) {
      payload.max_tokens = payload.max_completion_tokens;
    }
    delete payload.max_completion_tokens;
    delete payload.max_output_tokens;

    // Ensure messages is an array
    if (!Array.isArray(payload.messages)) {
      payload.messages = [];
    }

    return { payload, translationCtx };
  }

  /**
   * OpenAI response passthrough.
   * Minor normalization: ensure CORS headers, handle errors.
   */
  fromInternal(openAIResponse, statusCode) {
    return {
      body:       JSON.stringify(openAIResponse),
      statusCode: statusCode,
    };
  }

  /**
   * OpenAI SSE passthrough.
   * The chunk is already in the right format — return as-is.
   * Returns the raw chunk buffer, not a string array.
   *
   * Returning null signals the caller to write the raw chunk directly.
   */
  fromInternalSSE(chunk) {
    // Signal to server.js: write raw chunk, no translation needed
    return null;
  }

  responseHeaders(isStreaming) {
    if (isStreaming) {
      return {
        "Content-Type":                "text/event-stream",
        "Cache-Control":               "no-cache",
        "Connection":                  "keep-alive",
        "Access-Control-Allow-Origin": "*",
      };
    }
    return {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    };
  }

  rateLimitSSE(resetSeconds) {
    // OpenAI format rate limit error
    const errorChunk = {
      id:      `chatcmpl-ratelimit-${Date.now()}`,
      object:  "chat.completion.chunk",
      model:   "contextforge",
      choices: [{
        index: 0,
        delta: {
          content: `⚠️ Rate limit reached. Resets in ${Math.ceil(resetSeconds)}s.`,
        },
        finish_reason: "stop",
      }],
    };

    return (
      `data: ${JSON.stringify(errorChunk)}\n\n` +
      `data: [DONE]\n\n`
    );
  }
}