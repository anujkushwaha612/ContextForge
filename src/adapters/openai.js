/**
 * openai.js
 *
 * Adapter for clients speaking the OpenAI Chat Completions format.
 * Handles: Cursor (OpenAI mode), Continue, Aider, LM Studio,
 * Ollama clients, any OpenAI-compatible tool.
 *
 * Ingress:  OpenAI payload  → OpenAI internal format (passthrough + normalization)
 * Egress:   OpenAI response → OpenAI response format (passthrough)
 *
 * This adapter is mostly a passthrough — the pipeline already
 * operates in OpenAI format internally. Normalizations handle
 * field name variations and strip unsupported OpenAI-only features.
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
   * Normalizations applied:
   *   - Remove fields Ollama doesn't support
   *   - Normalize max_tokens field name variations
   *   - Clone messages array to prevent caller mutation
   *   - Set stream field from headers if not in body
   */
  toInternal(clientPayload, requestHeaders) {
    const translationCtx = createTranslationContext();

    // FIX: Clone the messages ARRAY so pipeline push/splice can't affect
    // the caller's array. NOTE: this is a shallow clone — message objects
    // are still shared. That's fine today (the only caller is server.js,
    // which owns the freshly-JSON.parsed body), but don't hand this
    // adapter a payload you plan to reuse.
    const payload = {
      ...clientPayload,
      messages: Array.isArray(clientPayload.messages)
        ? [...clientPayload.messages]
        : [],
    };

    // ── Remove OpenAI-specific fields that Ollama doesn't support ──
    delete payload.logprobs;
    delete payload.top_logprobs;
    delete payload.store;
    delete payload.metadata;
    delete payload.user; // tracking field, not needed for inference
    delete payload.seed; // deterministic sampling, Ollama may not support
    delete payload.response_format; // json_object mode, strip for compatibility

    // ── Normalize max_tokens field name variations ──
    // OpenAI API recently added max_completion_tokens as an alias.
    // Some clients use max_output_tokens. Normalize to max_tokens.
    if (payload.max_completion_tokens !== undefined && !payload.max_tokens) {
      payload.max_tokens = payload.max_completion_tokens;
    }
    if (payload.max_output_tokens !== undefined && !payload.max_tokens) {
      payload.max_tokens = payload.max_output_tokens;
    }
    delete payload.max_completion_tokens;
    delete payload.max_output_tokens;

    // ── Set stream from headers if not in body ──
    // Some clients indicate streaming via endpoint/headers, not body field.
    if (payload.stream === undefined) {
      payload.stream = requestHeaders["x-cf-streaming"] === "true";
    }

    // ── Model override from header (for testing/routing) ──
    if (requestHeaders["x-cf-model"]) {
      payload.model = requestHeaders["x-cf-model"];
    }

    return { payload, translationCtx };
  }

  /**
   * OpenAI response passthrough with error normalization.
   *
   * FIX: Map upstream errors to OpenAI error format.
   * Ollama may return different error shapes — normalize to OpenAI spec.
   */
  fromInternal(openAIResponse, statusCode) {
    // ── Error response ──
    if (statusCode >= 400) {
      // Normalize to OpenAI error format
      const errorBody = {
        error: {
          message:
            openAIResponse?.error?.message ||
            openAIResponse?.message ||
            `Error: ${statusCode}`,
          type: this._mapErrorType(statusCode),
          param: null,
          code: this._mapErrorCode(statusCode),
        },
      };

      return {
        statusCode,
        body: JSON.stringify(errorBody),
      };
    }

    // ── Success response passthrough ──
    return {
      body: JSON.stringify(openAIResponse),
      statusCode: statusCode,
    };
  }

  /**
   * OpenAI SSE passthrough.
   *
   * FIX: Match signature of other adapters — accept 4 params even though
   * we don't use them.
   *
   * OA-2 FIX: Return the raw line re-wrapped as a one-element array, NOT
   * null. upstreamRequest.js short-circuits openai clients with a raw
   * res.write(chunk) BEFORE this method is called, so today this is never
   * reached on the hot path — but its only caller does
   * `translatedEvents.length > 0` with no null check. Returning null made
   * any future caller (or a reordering of the openai short-circuit) an
   * instant TypeError crash mid-stream. An array keeps the contract
   * identical to AnthropicAdapter/GeminiAdapter: always string[].
   *
   * @param {string}  openAIDataLine  — raw SSE data after "data: " prefix
   * @param {string}  messageId       — unused (OpenAI generates its own IDs)
   * @param {boolean} isFirstChunk    — unused (no special first-chunk handling needed)
   * @param {object}  toolState       — unused (passthrough doesn't accumulate state)
   * @returns {string[]}              — passthrough: the line re-emitted as SSE
   */
  fromInternalSSE(openAIDataLine, messageId, isFirstChunk, toolState) {
    if (!openAIDataLine) return [];
    // Already in client format — re-emit verbatim (including [DONE]).
    return [`data: ${openAIDataLine}\n\n`];
  }

  responseHeaders(isStreaming) {
    if (isStreaming) {
      return {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      };
    }
    return {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };
  }

  rateLimitSSE(resetSeconds) {
    // OpenAI streaming error format
    const errorChunk = {
      id: `chatcmpl-ratelimit-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "contextforge",
      system_fingerprint: "fp_proxy",
      choices: [
        {
          index: 0,
          delta: {
            content: `⚠️ Rate limit reached. Resets in ${Math.ceil(resetSeconds)}s. Please wait and retry.`,
          },
          finish_reason: "stop",
        },
      ],
    };

    return `data: ${JSON.stringify(errorChunk)}\n\ndata: [DONE]\n\n`;
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * Map HTTP status code to OpenAI error type string.
   */
  _mapErrorType(statusCode) {
    const map = {
      400: "invalid_request_error",
      401: "authentication_error",
      403: "permission_error",
      404: "not_found_error",
      429: "rate_limit_error",
      500: "api_error",
      503: "api_error",
    };
    return map[statusCode] || "api_error";
  }

  /**
   * Map HTTP status code to OpenAI error code string.
   */
  _mapErrorCode(statusCode) {
    const map = {
      400: "invalid_request",
      401: "invalid_api_key",
      403: "permission_denied",
      404: "model_not_found",
      429: "rate_limit_exceeded",
      500: "internal_error",
      503: "service_unavailable",
    };
    return map[statusCode] || null;
  }
}