/**
 * gemini.js
 *
 * Adapter for clients speaking the Google Gemini API format.
 *
 * Ingress:  Gemini generateContent  → OpenAI internal format
 * Egress:   OpenAI response         → Gemini response format
 *
 * Gemini endpoints:
 *   POST /v1/models/{model}:generateContent          (non-streaming)
 *   POST /v1/models/{model}:streamGenerateContent    (streaming)
 *
 * Model extraction:
 *   Gemini encodes the model in the URL path, not the request body.
 *   detectAdapter must extract it from the URL and pass via x-cf-model header.
 *
 * Gemini API reference:
 *   https://ai.google.dev/api/generate-content
 */

import { createTranslationContext } from "../proxy/translator.js";

export class GeminiAdapter {
  constructor() {
    this._name = "gemini";
  }

  get name() {
    return this._name;
  }

  // ─────────────────────────────────────────────
  // Ingress: Gemini → OpenAI internal format
  // ─────────────────────────────────────────────

  /**
   * Convert Gemini generateContent request to OpenAI format.
   *
   * Gemini request shape:
   * {
   *   contents: [
   *     {
   *       role: "user" | "model",
   *       parts: [
   *         { text: "..." },
   *         { inlineData: { mimeType: "image/png", data: "<base64>" } },
   *         { functionCall: { name: "...", args: {...} } },
   *         { functionResponse: { name: "...", response: {...} } }
   *       ]
   *     }
   *   ],
   *   systemInstruction: { parts: [{ text: "..." }] },
   *   generationConfig: { maxOutputTokens, temperature, topP, stopSequences },
   *   tools: [{ functionDeclarations: [...] }],
   *   toolConfig: { functionCallingConfig: { mode: "AUTO"|"ANY"|"NONE" } }
   * }
   */
  toInternal(clientPayload, requestHeaders) {
    const translationCtx = createTranslationContext();
    const isStreaming = requestHeaders["x-cf-streaming"] === "true";

    const payload = {
      model: this._extractModel(requestHeaders, clientPayload),
      messages: [],
      stream: isStreaming,
    };

    // ── System instruction ──
    if (clientPayload.systemInstruction?.parts) {
      const systemText = clientPayload.systemInstruction.parts
        .map((p) => p.text || "")
        .join("\n")
        .trim();
      if (systemText) {
        payload.messages.push({ role: "system", content: systemText });
      }
    }

    // ── Contents → messages ──
    for (const content of clientPayload.contents || []) {
      const role = content.role === "model" ? "assistant" : "user";
      this._convertContent(content, role, payload.messages);
    }

    // ── Generation config ──
    // FIX: Use !== undefined to preserve temperature: 0 and topP: 0
    const gc = clientPayload.generationConfig || {};
    if (gc.maxOutputTokens !== undefined) payload.max_tokens = gc.maxOutputTokens;
    if (gc.temperature !== undefined) payload.temperature = gc.temperature;
    if (gc.topP !== undefined) payload.top_p = gc.topP;
    if (gc.stopSequences?.length) payload.stop = gc.stopSequences;
    if (gc.candidateCount && gc.candidateCount > 1) {
      payload.n = gc.candidateCount;
    }

    // ── Tools ──
    if (clientPayload.tools?.length > 0) {
      payload.tools = [];
      for (const toolGroup of clientPayload.tools) {
        for (const fd of toolGroup.functionDeclarations || []) {
          payload.tools.push({
            type: "function",
            function: {
              name: fd.name,
              description: fd.description || "",
              parameters: fd.parameters || { type: "object", properties: {} },
            },
          });
        }
      }
    }

    // ── Tool choice ──
    const mode = clientPayload.toolConfig?.functionCallingConfig?.mode;
    if (mode === "ANY") payload.tool_choice = "required";
    if (mode === "NONE") payload.tool_choice = "none";
    // AUTO → omit (let model decide, same as OpenAI default)

    return { payload, translationCtx };
  }

  /**
   * Convert a single Gemini content block to one or more OpenAI messages.
   * Handles text, inlineData (images), functionCall, functionResponse.
   *
   * ID handling:
   *   Gemini sends real stable IDs on both functionCall and functionResponse:
   *     functionCall:     { id: "write_file_1781811258832_0", name: "write_file", args: {} }
   *     functionResponse: { id: "write_file_1781811258832_0", name: "write_file", response: {} }
   *
   *   These must be used as-is on both sides so tool_call_id on the tool
   *   message matches the id on the assistant tool_calls entry. Mismatched
   *   IDs break tagToolResults metadata backfill and cause the upstream LLM
   *   to see orphaned tool messages.
   *
   *   Fallback format: `call_${name}_${i}` used consistently on BOTH sides
   *   when Gemini does not provide a real ID.
   */
  _convertContent(content, role, messages) {
    const parts = content.parts || [];

    const textParts = parts.filter((p) => p.text !== undefined);
    const imageParts = parts.filter((p) => p.inlineData);
    const functionCalls = parts.filter((p) => p.functionCall);
    const functionResps = parts.filter((p) => p.functionResponse);

    // ── Function responses → OpenAI tool messages ──
    // Must come before functionCall check — a turn can have both.
    //
    // FIX: Use loop index i, not hardcoded 0, so multi-tool responses
    // generate unique fallback IDs that match the functionCall side.
    if (functionResps.length > 0) {
      for (let i = 0; i < functionResps.length; i++) {
        const p = functionResps[i];
        const name = p.functionResponse.name;
        const id = p.functionResponse.id || `call_${name}_${i}`;
        messages.push({
          role: "tool",
          tool_call_id: id,
          name,
          content:
            typeof p.functionResponse.response === "string"
              ? p.functionResponse.response
              : JSON.stringify(p.functionResponse.response || {}),
        });
      }
      return;
    }

    // ── Function calls → OpenAI assistant with tool_calls ──
    //
    // FIX: Use loop index i in fallback ID so both sides (functionCall
    // and functionResponse) generate matching IDs when Gemini omits them.
    if (functionCalls.length > 0) {
      const textContent = textParts.map((p) => p.text).join("") || null;
      messages.push({
        role: "assistant",
        content: textContent,
        tool_calls: functionCalls.map((p, i) => ({
          id: p.functionCall.id || `call_${p.functionCall.name}_${i}`,
          type: "function",
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args || {}),
          },
        })),
      });
      return;
    }

    // ── Text + optional images ──
    if (imageParts.length > 0) {
      const contentArray = [];

      for (const t of textParts) {
        contentArray.push({ type: "text", text: t.text });
      }

      for (const img of imageParts) {
        contentArray.push({
          type: "image_url",
          image_url: {
            url: `data:${img.inlineData.mimeType};base64,${img.inlineData.data}`,
          },
        });
      }

      messages.push({ role, content: contentArray });
      return;
    }

    // ── Plain text ──
    const text = textParts.map((p) => p.text).join("");
    if (text) {
      messages.push({ role, content: text });
    }
  }

  // ─────────────────────────────────────────────
  // Egress non-streaming: OpenAI → Gemini format
  // ─────────────────────────────────────────────

  /**
   * Convert OpenAI JSON response to Gemini generateContent response.
   *
   * FIX: Preserve tool call ID in functionCall so Gemini CLI can correlate
   * the next turn's functionResponse back to this call.
   *
   * Gemini response shape:
   * {
   *   candidates: [{
   *     content: { role: "model", parts: [{ text: "..." }] },
   *     finishReason: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER",
   *     index: 0,
   *     safetyRatings: []
   *   }],
   *   usageMetadata: {
   *     promptTokenCount: N,
   *     candidatesTokenCount: N,
   *     totalTokenCount: N
   *   },
   *   modelVersion: "contextforge-proxy"
   * }
   */
  fromInternal(openAIResponse, statusCode) {
    // ── Error response ──
    if (statusCode >= 400) {
      const geminiErrorCode = this._mapErrorCode(statusCode);
      return {
        statusCode,
        body: JSON.stringify({
          error: {
            code: statusCode,
            message: openAIResponse?.error?.message || `Error: ${statusCode}`,
            status: geminiErrorCode,
          },
        }),
      };
    }

    const parts = [];
    const message = openAIResponse.choices?.[0]?.message;
    const finish = openAIResponse.choices?.[0]?.finish_reason;

    // ── Text content ──
    if (message?.content) {
      parts.push({ text: message.content });
    }

    // ── Tool calls → functionCall parts ──
    // FIX: Preserve tc.id so Gemini CLI can match functionResponse to this call
    if (message?.tool_calls?.length > 0) {
      for (const tc of message.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* keep empty */
        }
        parts.push({
          functionCall: {
            id: tc.id, // FIXED: preserve ID for client correlation
            name: tc.function.name,
            args,
          },
        });
      }
    }

    const geminiResponse = {
      candidates: [
        {
          content: { role: "model", parts },
          finishReason: this._mapFinishReason(finish),
          index: 0,
          // safetyRatings intentionally omitted —
          // proxy has no content safety system; omitting is valid per Gemini spec
        },
      ],
      usageMetadata: {
        promptTokenCount: openAIResponse.usage?.prompt_tokens || 0,
        candidatesTokenCount: openAIResponse.usage?.completion_tokens || 0,
        totalTokenCount: openAIResponse.usage?.total_tokens || 0,
      },
      modelVersion: "contextforge-proxy",
    };

    return {
      statusCode,
      body: JSON.stringify(geminiResponse),
    };
  }

  // ─────────────────────────────────────────────
  // Egress streaming: OpenAI SSE → Gemini SSE
  // ─────────────────────────────────────────────

  /**
   * Convert one OpenAI SSE data line to Gemini streaming format.
   *
   * OpenAI streams tool call arguments as fragments across multiple chunks:
   *   chunk 1: { delta: { tool_calls: [{ id: "call_abc", function: { name: "foo", arguments: "" } }] } }
   *   chunk 2: { delta: { tool_calls: [{ function: { arguments: '{"key"' } }] } }
   *   chunk 3: { delta: { tool_calls: [{ function: { arguments: ': "val"}' } }] } }
   *
   * We must assemble the full arguments string before emitting a functionCall part.
   * This method uses toolState to accumulate fragments.
   *
   * FIX: Handle multi-tool streaming — accumulate ALL tool_calls indices,
   * not just index 0.
   *
   * Gemini streaming: each chunk is SSE data: {...} format (same as OpenAI SSE,
   * but with Gemini response shape inside).
   *
   * @param {string}  openAIDataLine  — raw data after "data: " prefix
   * @param {string}  messageId       — unused for Gemini but kept for interface compat
   * @param {boolean} isFirstChunk
   * @param {object}  toolState       — shared state object across chunks
   * @returns {string[]}              — array of SSE strings to write
   */
  fromInternalSSE(openAIDataLine, messageId, isFirstChunk, toolState) {
    // ── Stream end ──
    if (!openAIDataLine || openAIDataLine === "[DONE]") {
      // Flush any pending tool calls
      if (toolState._geminiPendingToolCalls?.length > 0) {
        const parts = [];
        for (const tc of toolState._geminiPendingToolCalls) {
          if (!tc) continue; // sparse array guard

          let args = {};
          try {
            args = JSON.parse(tc.arguments || "{}");
          } catch {
            /* keep empty */
          }
          parts.push({
            functionCall: {
              id: tc.id,
              name: tc.name,
              args,
            },
          });
        }
        toolState._geminiPendingToolCalls = null;

        const chunk = this._buildStreamChunk(parts, "STOP");
        return [`data: ${JSON.stringify(chunk)}\n\n`];
      }
      return []; // [DONE] is never forwarded to Gemini client
    }

    let parsed;
    try {
      parsed = JSON.parse(openAIDataLine);
    } catch {
      return [];
    }

    const delta = parsed.choices?.[0]?.delta;
    const finishReason = parsed.choices?.[0]?.finish_reason;
    const parts = [];

    // ── Text content ──
    if (delta?.content) {
      parts.push({ text: delta.content });
    }

    // ── Tool call argument assembly ──
    // FIX: Handle ALL tool_calls indices, not just [0]
    if (delta?.tool_calls?.length > 0) {
      if (!toolState._geminiPendingToolCalls) {
        toolState._geminiPendingToolCalls = [];
      }

      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0; // OpenAI sends index on each fragment

        // Ensure array slot exists
        if (!toolState._geminiPendingToolCalls[index]) {
          toolState._geminiPendingToolCalls[index] = {
            id: tc.id || "",
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || "",
          };
        } else {
          // Accumulate fragments
          if (tc.id) toolState._geminiPendingToolCalls[index].id = tc.id;
          if (tc.function?.name)
            toolState._geminiPendingToolCalls[index].name += tc.function.name;
          if (tc.function?.arguments)
            toolState._geminiPendingToolCalls[index].arguments +=
              tc.function.arguments;
        }
      }

      // Don't emit yet — wait for finish_reason or [DONE]
    }

    // ── Finish: flush all pending tool calls ──
    if (finishReason && toolState._geminiPendingToolCalls?.length > 0) {
      for (const tc of toolState._geminiPendingToolCalls) {
        if (!tc) continue; // sparse array guard

        let args = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          /* keep empty */
        }

        parts.push({
          functionCall: {
            id: tc.id,
            name: tc.name,
            args,
          },
        });
      }
      toolState._geminiPendingToolCalls = null;
    }

    if (parts.length === 0 && !finishReason) return [];

    const chunk = this._buildStreamChunk(
      parts,
      finishReason ? this._mapFinishReason(finishReason) : undefined,
    );

    return [`data: ${JSON.stringify(chunk)}\n\n`];
  }

  // ─────────────────────────────────────────────
  // Headers
  // ─────────────────────────────────────────────

  responseHeaders(isStreaming) {
    return {
      "Content-Type": isStreaming ? "text/event-stream" : "application/json",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    };
  }

  rateLimitSSE(resetSeconds) {
    const chunk = this._buildStreamChunk(
      [
        {
          text: `⚠️ Rate limit reached. Resets in ${Math.ceil(resetSeconds)}s. Please wait and retry.`,
        },
      ],
      "OTHER",
    );
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  _buildStreamChunk(parts, finishReason) {
    const candidate = {
      content: { role: "model", parts },
      index: 0,
    };
    if (finishReason) candidate.finishReason = finishReason;

    return { candidates: [candidate] };
  }

  _mapFinishReason(openAIReason) {
    const map = {
      stop: "STOP",
      length: "MAX_TOKENS",
      tool_calls: "STOP",
      content_filter: "SAFETY",
      null: "STOP",
    };
    return map[openAIReason] || "OTHER";
  }

  _mapErrorCode(statusCode) {
    const map = {
      400: "INVALID_ARGUMENT",
      401: "UNAUTHENTICATED",
      403: "PERMISSION_DENIED",
      404: "NOT_FOUND",
      429: "RESOURCE_EXHAUSTED",
      500: "INTERNAL",
      503: "UNAVAILABLE",
    };
    return map[statusCode] || "INTERNAL";
  }

  /**
   * Extract model name from headers or payload.
   *
   * Gemini encodes the model in the URL path, not the request body:
   *   POST /v1/models/gemini-2.0-flash:generateContent
   *
   * detectAdapter must extract the model from the URL and pass it via
   * the x-cf-model header before calling toInternal().
   */
  _extractModel(requestHeaders, clientPayload) {
    return (
      requestHeaders["x-cf-model"] ||
      clientPayload.model ||
      "gemini-2.0-flash"
    );
  }
}