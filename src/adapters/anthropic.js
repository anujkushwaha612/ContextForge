/**
 * anthropic.js
 *
 * Adapter for clients speaking the Anthropic Messages API format.
 * Handles Claude Code, Cursor (Anthropic mode), and any client
 * that POSTs to /v1/messages.
 *
 * Ingress:  Anthropic payload  → OpenAI internal format
 * Egress:   OpenAI response    → Anthropic response format
 */

import crypto from "node:crypto";
import {
  translateAnthropicToOpenAI,
  translateOpenAISSEToAnthropic,
  createTranslationContext,
} from "../proxy/translator.js";

export class AnthropicAdapter {
  constructor() {
    this._name = "anthropic";
  }

  get name() {
    return this._name;
  }

  /**
   * Normalize Anthropic payload to OpenAI internal format.
   * Creates a fresh translation context per request — isolated
   * from concurrent requests, prefix cache still works within
   * a single request pipeline.
   *
   * @param {object} clientPayload  — raw parsed request body
   * @param {object} requestHeaders — raw request headers
   * @returns {{ payload, translationCtx }}
   */
  toInternal(clientPayload, requestHeaders) {
    const translationCtx = createTranslationContext();
    const payload = translateAnthropicToOpenAI(clientPayload, translationCtx);

    // Set stream from header when not in body — some clients signal streaming
    // via URL or headers rather than payload field
    if (payload.stream === undefined) {
      payload.stream = requestHeaders["x-cf-streaming"] === "true";
    }

    return { payload, translationCtx };
  }

  /**
   * Convert OpenAI JSON response back to Anthropic format.
   * Called for non-streaming responses only.
   *
   * FIX: Handle DeepSeek-R1 / Nemotron reasoning field — prepend to content.
   * FIX: Use crypto.randomUUID() for message ID generation.
   * FIX: Wrap tool arguments parsing in try/catch.
   *
   * @param {object} openAIResponse — parsed OpenAI response JSON
   * @param {number} statusCode
   * @returns {{ body: string, statusCode: number }}
   */
  fromInternal(openAIResponse, statusCode) {
    // Upstream errors — translate error shape
    if (statusCode >= 400) {
      const body = JSON.stringify({
        type: "error",
        error: {
          type:
            statusCode === 429
              ? "rate_limit_error"
              : statusCode === 529
                ? "overloaded_error"
                : "api_error",
          message: openAIResponse?.error?.message || `Upstream error: ${statusCode}`,
        },
      });
      return { body, statusCode };
    }

    const message = openAIResponse.choices?.[0]?.message;

    const anthropicResponse = {
      id: openAIResponse.id || `msg_${crypto.randomUUID().replace(/-/g, "")}`, // FIX: unique ID
      type: "message",
      role: "assistant",
      content: [],
      model: openAIResponse.model || "contextforge",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: openAIResponse.usage?.prompt_tokens || 0,
        output_tokens: openAIResponse.usage?.completion_tokens || 0,
      },
    };

    // FIX: Handle reasoning field (DeepSeek-R1, Nemotron)
    // Prepend reasoning before content so the full chain-of-thought is preserved
    if (message?.reasoning) {
      anthropicResponse.content.push({
        type: "text",
        text: message.reasoning,
      });
    }

    if (message?.content) {
      anthropicResponse.content.push({
        type: "text",
        text: message.content,
      });
    }

    // FIX: Wrap tool arguments parsing in try/catch
    if (message?.tool_calls) {
      anthropicResponse.stop_reason = "tool_use";
      for (const tc of message.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch (err) {
          console.warn(
            `[AnthropicAdapter] Failed to parse tool arguments for ${tc.function.name}: ${err.message}`
          );
          // Leave input as empty object — better than crashing
        }

        anthropicResponse.content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }

    return {
      body: JSON.stringify(anthropicResponse),
      statusCode: statusCode,
    };
  }

  /**
   * Convert one OpenAI SSE data line to Anthropic SSE events.
   * Returns array of SSE strings ready to write to the client.
   *
   * @param {string}  openAIDataLine  — e.g. "data: {...}"
   * @param {string}  messageId
   * @param {boolean} isFirstChunk
   * @param {object}  toolState       — mutable state object shared across chunks
   * @returns {string[]}
   */
  fromInternalSSE(openAIDataLine, messageId, isFirstChunk, toolState) {
    return translateOpenAISSEToAnthropic(openAIDataLine, messageId, isFirstChunk, toolState);
  }

  /**
   * HTTP response headers to send back to the client.
   */
  responseHeaders(isStreaming) {
    if (isStreaming) {
      return {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      };
    }
    return {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };
  }

  /**
   * Generate a rate limit error SSE response in Anthropic format.
   * Called when upstream returns an empty stream (silent rate limit).
   */
  rateLimitSSE(resetSeconds) {
    const errorMsgId = `msg_forge_ratelimit_${Date.now()}`;
    const events = [];

    events.push(
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: errorMsgId,
          type: "message",
          role: "assistant",
          content: [],
          model: "contextforge",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 1 },
        },
      })}\n\n`
    );

    events.push(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`
    );

    events.push(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: `⚠️ Rate limit reached. Resets in ${Math.ceil(resetSeconds)}s. Please wait and retry.`,
        },
      })}\n\n`
    );

    events.push(
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: 0,
      })}\n\n`
    );

    events.push(
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      })}\n\n`
    );

    events.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);

    return events.join("");
  }
}
