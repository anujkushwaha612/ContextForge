import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";

import { ProviderFactory } from "./providers/index.js";
import { invalidateByFile, resetEntireCache } from "./logging/cacheDb.js";
import { countTokens } from "./compression/compressionHelper.js";
import { createRequire } from "module";
import { retrieveFromVault } from "./vaultRetriever.js";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { applySemanticDedup } from "./compression/semanticDedup.js";

import {
  detectMutation,
  hashFile,
  translateAnthropicToOpenAI,
  stripAnthropicSpecificFields,
  translateOpenAISSEToAnthropic,
  minimizeToolSchemas,
  interceptAndVaultMassiveToolResults,
  scrubToolResults,
  tagToolResults,
  pruneToolResults,
  sliceJsonToolResults,
  applyPredictiveInjection,
  deduplicateSystemMessages,
  // validateAndRepairMessages,
} from "./helper.js";

import { compressCodeToolResults } from "./compression/astCompressor.js";
import { getPolicyForModel } from "./compression/compressionPolicy.js";
import {
  CompressionDecision,
  getOptimizeFlag,
} from "./proxy/compressionDecision.js";
import { alignCachePrefix } from "./compression/cacheAligner.js";
import { MemoryDecision, getMemoryMode } from "./proxy/memoryDecision.js";
import { StageTimer, STAGES } from "./proxy/stageTimer.js";
import { savingsTracker } from "./proxy/savingsTracker.js";
import { applyCCRPipeline, recordCCRSuccess } from "./ccr/index.js";
import { MemoryHandler } from "./memory/memoryHandler.js";
import { setEmbedder } from "./memory/embedder.js";
import {
  executeMemoryToolCalls,
  hasMemoryToolCalls,
  injectMemoryTools,
} from "./memory/memoryTools.js";
import { indexWorkspace, watchWorkspace } from "./graph/workspaceMapper.js";
import {
  isGraphToolCall,
  executeGraphQuery,
  normalizeGraphToolName,
} from "./graph/graphTools.js";
import { injectGraphTool } from "./graph/graphTools.js";
import { getGraphStats } from "./graph/graphDb.js";

const require = createRequire(import.meta.url);
const native = require("../native/build/Release/contextforge_native.node");
const GRAPH_TOOL_NAME = "contextforge_query_graph";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────
// Native module initialization
// ─────────────────────────────────────────────

console.log("Initializing ContextForge Native Engine...");

// Boot-time graph indexing (non-blocking background task)
(async () => {
  const workspacePath = process.env.CF_WORKSPACE_PATH || process.cwd();
  try {
    await indexWorkspace(workspacePath, {
      force: false,
      onProgress: ({ current, total, file }) => {
        if (current % 50 === 0) {
          console.log(`[GraphMapper] Progress: ${current}/${total} — ${file}`);
        }
      },
    });

    // Watch for changes after initial index
    const watcher = watchWorkspace(workspacePath);

    // Stop watcher on shutdown
    process.on("SIGINT", () => {
      watcher.stop();
    });
  } catch (err) {
    console.error(`[GraphMapper] ❌ Failed to index workspace: ${err.message}`);
  }
})();

const onnxEmbedder = new native.OnnxEmbedder(
  path.join(__dirname, "../models/all-MiniLM-L6-v2-int8.onnx"),
  path.join(__dirname, "../models/tokenizer.json"),
  {
    dim: 384,
    cacheSize: 512,
    batchWaitMs: 1,
  },
);

setEmbedder(onnxEmbedder);

onnxEmbedder.embed("warmup").then(() => {
  console.log("[Embedder] Ready");
  console.log("[Embedder] Stats:", onnxEmbedder.getStats());
});

const memoryStore = new native.PersistentMemoryStore(
  path.join(__dirname, "./data/memory.db"),
  384,
);

const semanticCache = new native.SemanticCache(384);

const hybridRetriever = new native.HybridRetriever(semanticCache, {
  dimension: 384,
  denseWeight: 0.3,
});

const memoryHandler = new MemoryHandler(memoryStore, hybridRetriever, {
  maxTokens: 1024,
  maxEntries: 10,
  minScore: 0.3,
});

console.log(`[Memory] PersistentMemoryStore ready`);

// ─────────────────────────────────────────────
// Embedding worker
// ─────────────────────────────────────────────

const workerPath = path.join(__dirname, "workers", "embeddingWorker.js");
global.embeddingWorker = new Worker(workerPath, {
  execArgv: ["--experimental-vm-modules"],
});

global.embeddingWorker.on("error", (err) => {
  console.error(`\n[Background Thread] Fatal Error: ${err.message}`);
});

global.embeddingWorker.on("exit", (code) => {
  if (code !== 0) {
    console.error(
      `\n[Background Thread] Worker exited (code ${code}). RAG disabled.`,
    );
    global.embeddingWorker = null;
  }
});

global.embeddingWorker.on("message", async (msg) => {
  if (typeof msg === "string") {
    console.log(`\n[Background Thread] ${msg}`);
    return;
  }

  if (msg.type === "embed_request") {
    try {
      const BATCH_SLICE = 8;
      const texts = msg.texts;
      const allVectors = [];

      for (let i = 0; i < texts.length; i += BATCH_SLICE) {
        const slice = texts.slice(i, i + BATCH_SLICE);
        const vectors = await onnxEmbedder.embedBatch(slice);
        for (const v of vectors) {
          allVectors.push(Array.from(v));
        }
        if (i + BATCH_SLICE < texts.length) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      global.embeddingWorker.postMessage({
        type: "embed_response",
        requestId: msg.requestId,
        vaultId: msg.vaultId,
        vectors: allVectors,
      });
    } catch (err) {
      console.error(`[Worker Bridge] Embed failed: ${err.message}`);
      global.embeddingWorker.postMessage({
        type: "embed_error",
        requestId: msg.requestId,
        vaultId: msg.vaultId,
      });
    }
    return;
  }

  console.log(`\n[Background Thread]`, msg);
});

// ─────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────

const MAX_BODY_SIZE = 10_000_000;

const server = http.createServer((req, res) => {
  // ── CORS Preflight ──
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "OPTIONS, POST",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    });
    return res.end();
  }

  // ── Cache Invalidation ──
  if (req.url.startsWith("/v1/cache/invalidate") && req.method === "POST") {
    let invBody = "";
    req.on("data", (chunk) => (invBody += chunk.toString()));
    req.on("end", () => {
      try {
        const { id } = JSON.parse(invBody);
        if (id) {
          semanticCache.invalidate(id);
          console.log(`\n[Cache Invalidation] 🗑️ Vector ${id} wiped.`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ success: true, message: `Invalidated ${id}` }),
          );
        } else {
          throw new Error("Missing ID");
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON or missing 'id'" }));
      }
    });
    return;
  }

  // ── Nuclear Cache Reset ──
  if (req.url.startsWith("/v1/cache/reset") && req.method === "POST") {
    try {
      resetEntireCache(semanticCache);
      console.log(`\n[Cache Reset] ☢️ Nuclear reset triggered.`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          success: true,
          message: "Entire cache has been reset.",
        }),
      );
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ error: "Failed to reset cache", details: e.message }),
      );
    }
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Method Not Allowed" }));
  }

  const chunks = [];
  let totalBytes = 0;
  let destroyed = false;

  req.on("data", (chunk) => {
    if (destroyed) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_SIZE) {
      destroyed = true;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload Too Large" }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (destroyed) return;
    const startTime = performance.now();
    const timer = new StageTimer();

    // ── Parse body ──
    let payload;
    try {
      const bodyBuffer = Buffer.concat(chunks);
      payload = JSON.parse(bodyBuffer.toString("utf-8"));
    } catch (err) {
      console.error("Parse Error:", err.message);
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request - Invalid JSON" }));
      }
      return;
    }

    // ── Token counting ping ──
    if (req.url.includes("/count_tokens")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 150 }));
    }

    const isAnthropic = req.url.includes("/v1/messages");

    // ── Provider setup ──
    const adapter = ProviderFactory.getAdapter("ollama");

    // ─────────────────────────────────────────────
    // executeUpstreamRequest
    // Defined before the gate so both passthrough
    // and compression branches can call it.
    // ─────────────────────────────────────────────
    async function executeUpstreamRequest(
      currentPayload,
      retryCount = 0,
      isInitialHop = true,
    ) {
      // // ── Validate and repair message sequence ──
      // if (currentPayload.messages) {
      //   const { messages, valid, issues } = validateAndRepairMessages(
      //     currentPayload.messages,
      //   );
      //   if (!valid) {
      //     console.warn(
      //       `[MsgValidator] Repaired ${issues.length} issue(s) before transmit`,
      //     );
      //     currentPayload = { ...currentPayload, messages };
      //   }
      // }

      // ── Model override — done here, not before the pipeline ──
      // Keeps the original model name available to getPolicyForModel above
      currentPayload = { ...currentPayload, model: "minimax-m3:cloud" };
      delete currentPayload.max_completion_tokens;
      delete currentPayload.max_output_tokens;

      // ── Debug payload dump ──
      if (process.env.CF_DEBUG_PAYLOAD === "1") {
        writeFileSync(
          path.join(__dirname, "../debug_payload.json"),
          JSON.stringify(currentPayload, null, 2),
          "utf-8",
        );
        console.log("[Debug] Payload dumped to debug_payload.json");
      }

      try {
        const finalTokenCount = countTokens(currentPayload);
        console.log(
          `\n[Wire Inspector] Transmitting ${finalTokenCount} tokens to LLM (Retry: ${retryCount})`,
        );
      } catch {
        console.log(`\n[Wire Inspector] Transmitting payload...`);
      }

      const outboundBody = JSON.stringify(currentPayload);
      const outboundHeaders = adapter.transformHeaders(req.headers);

      delete outboundHeaders["x-api-key"];
      delete outboundHeaders["anthropic-version"];
      delete outboundHeaders["anthropic-beta"];

      if (process.env.NEMOTRON_CLOUD_API_KEY) {
        outboundHeaders["authorization"] =
          `Bearer ${process.env.NEMOTRON_CLOUD_API_KEY}`;
      }

      outboundHeaders["content-length"] = Buffer.byteLength(outboundBody);
      delete outboundHeaders["accept-encoding"];

      const outboundPath = "/v1/chat/completions";
      const requestOptions = {
        hostname: adapter.hostname,
        port: adapter.port,
        path: outboundPath,
        method: req.method,
        headers: outboundHeaders,
      };

      const requestModule =
        requestOptions.port === 80 || requestOptions.port === 11434
          ? http
          : https;

      if (retryCount === 0) {
        console.log(
          `\n[Route] ${req.url} -> ${adapter.hostname}${outboundPath}`,
        );
      } else {
        console.log(
          `\n[Ghost Interceptor] Retry #${retryCount} -> ${adapter.hostname}${outboundPath}`,
        );
      }

      const isStreamRequest = currentPayload.stream === true;

      const proxyReq = requestModule.request(requestOptions, (proxyRes) => {
        let sseBuffer = "";
        const responseChunks = [];

        let toolState = {
          inToolCall: false,
          inTextBlock: false,
          toolIndex: 0,
          nextBlockIndex: undefined,
          textBlockIndex: -1,
          currentToolIndex: -1,
        };

        let messageId =
          "msg_forge_" + Math.random().toString(36).substring(2, 15);
        let isFirstChunk = isInitialHop;

        let fullStreamedText = "";
        let detectedToolName = "";
        let detectedToolId = "";
        let detectedToolArgs = "";

        let heldEvents = [];
        let hasSeenToolCall = false;
        let hasSeenTextContent = false;

        // ── Data handler ──
        proxyRes.on("data", (chunk) => {
          responseChunks.push(chunk);

          if (isStreamRequest) {
            const rawSseText = chunk.toString("utf-8");
            sseBuffer += rawSseText;

            if (isAnthropic) {
              const lines = rawSseText.split("\n");

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const openAiData = line.substring(6).trim();
                if (!openAiData) continue;

                try {
                  if (openAiData !== "[DONE]") {
                    const parsedChunk = JSON.parse(openAiData);
                    const delta = parsedChunk.choices?.[0]?.delta;

                    if (delta?.reasoning || delta?.content) {
                      fullStreamedText +=
                        (delta.reasoning || "") + (delta.content || "");
                      hasSeenTextContent = true;
                    }

                    if (delta?.tool_calls?.[0]) {
                      hasSeenToolCall = true;
                      const tc = delta.tool_calls[0];
                      if (tc.id) detectedToolId = tc.id;
                      if (tc.function?.name)
                        detectedToolName += tc.function.name;
                      if (tc.function?.arguments)
                        detectedToolArgs += tc.function.arguments;
                    }
                  }
                } catch {
                  // ignore malformed partial chunks
                }

                if (hasSeenToolCall) {
                  const anthropicEvents = translateOpenAISSEToAnthropic(
                    openAiData,
                    messageId,
                    isFirstChunk,
                    toolState,
                  );
                  if (anthropicEvents.length > 0) {
                    isFirstChunk = false;
                    heldEvents.push(...anthropicEvents);
                  }
                  continue;
                }

                if (!res.headersSent) {
                  res.writeHead(proxyRes.statusCode, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "Access-Control-Allow-Origin": "*",
                  });
                }

                const anthropicEvents = translateOpenAISSEToAnthropic(
                  openAiData,
                  messageId,
                  isFirstChunk,
                  toolState,
                );
                if (anthropicEvents.length > 0) {
                  isFirstChunk = false;
                  for (const event of anthropicEvents) res.write(event);
                }
              }
            } else {
              if (!res.headersSent) {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
              }
              res.write(chunk);
            }
          }
        });

        // ── End handler ──
        proxyRes.on("end", async () => {
          // ── Silent rate limit (empty SSE stream) ──
          if (isStreamRequest && sseBuffer.length === 0) {
            const resetSeconds =
              parseFloat(proxyRes.headers["x-ratelimit-reset-tokens"]) || 60;

            if (!res.headersSent) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
              });
            }

            const errorMsgId = `msg_forge_ratelimit_${Date.now()}`;
            res.write(
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
              })}\n\n`,
            );
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              })}\n\n`,
            );
            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: {
                  type: "text_delta",
                  text: `⚠️ Rate limit reached. Resets in ${Math.ceil(resetSeconds)}s. Please wait and retry.`,
                },
              })}\n\n`,
            );
            res.write(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: 0,
              })}\n\n`,
            );
            res.write(
              `event: message_delta\ndata: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              })}\n\n`,
            );
            res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
            res.end();
            return;
          }

          // ── Streaming: Ghost Interceptor decision point ──
          if (isStreamRequest) {
            const dummyMessage = {
              tool_calls: [
                {
                  id: detectedToolId || `call_cf_${Date.now()}`,
                  type: "function",
                  function: {
                    name: detectedToolName,
                    arguments: detectedToolArgs,
                  },
                },
              ],
            };

            const normalizedToolName = normalizeGraphToolName(detectedToolName);
            const isGraphTool = isGraphToolCall(detectedToolName);
            const isRetrieveTool = normalizedToolName.includes(
              "contextforge_retrieve",
            );
            const isMemoryTool =
              normalizedToolName && hasMemoryToolCalls(dummyMessage);

            if (
              (isRetrieveTool || isMemoryTool || isGraphTool) &&
              retryCount < 2
            ) {
              // ← MODIFY
              console.log(
                `\n[Ghost Interceptor] 🔍 Intercepted background tool: ` +
                  `${detectedToolName} (swallowing ${heldEvents.length} buffered events)`,
              );

              // ── Graph query ──                                      ← ADD ENTIRE BLOCK
              if (isGraphTool) {
                console.log(
                  `\n[Ghost Interceptor] 🗺️  Graph query intercepted: ${detectedToolName}` +
                    (normalizedToolName !== detectedToolName
                      ? ` (normalized from MCP: ${detectedToolName})`
                      : ``),
                );

                let args = null;
                try {
                  args = JSON.parse(detectedToolArgs);
                } catch {
                  console.error(`[Ghost Interceptor] ⚠️ Graph args malformed`);
                }

                if (args?.query_type && args?.target) {
                  const result = executeGraphQuery(
                    args.query_type,
                    args.target,
                  );

                  console.log(
                    `[Ghost Interceptor] ✅ Graph: ${args.query_type}("${args.target}") ` +
                      `→ ${result.length} chars`,
                  );

                  currentPayload.messages.push({
                    role: "assistant",
                    content: null,
                    tool_calls: dummyMessage.tool_calls,
                  });
                  currentPayload.messages.push({
                    role: "tool",
                    tool_call_id: dummyMessage.tool_calls[0].id,
                    name: GRAPH_TOOL_NAME, // ← always use canonical name, never the MCP variant
                    content: result,
                  });

                  delete currentPayload.tools;
                  delete currentPayload.tool_choice;
                  return executeUpstreamRequest(
                    currentPayload,
                    retryCount + 1,
                    false,
                  );
                }

                // Args malformed — fall through to replay as real tool
                console.warn(
                  `[Ghost Interceptor] ⚠️ Graph args missing query_type/target — falling through`,
                );
              }

              // ── Vault retrieval ──
              if (isRetrieveTool) {
                let args = null;
                try {
                  args = JSON.parse(detectedToolArgs);
                } catch {
                  console.error(
                    `[Ghost Interceptor] ⚠️ Args JSON malformed: "${detectedToolArgs.slice(0, 120)}"`,
                  );
                }

                if (args) {
                  let vaultedText = null;
                  try {
                    vaultedText = await retrieveFromVault(
                      args.vault_id,
                      args.search_query || null,
                      currentPayload.messages,
                      semanticCache,
                      hybridRetriever,
                    );
                  } catch (retrieveErr) {
                    console.error(
                      `[Ghost Interceptor] ⚠️ Vault retrieval failed: ${retrieveErr.message}`,
                    );
                  }

                  if (vaultedText) {
                    recordCCRSuccess(currentPayload, args.vault_id);
                    console.log(
                      `[Ghost Interceptor] ✅ Vault ${args.vault_id} opened (${vaultedText.length} chars)`,
                    );
                    currentPayload.messages.push({
                      role: "assistant",
                      content: null,
                      tool_calls: dummyMessage.tool_calls,
                    });
                    currentPayload.messages.push({
                      role: "tool",
                      tool_call_id: dummyMessage.tool_calls[0].id,
                      name: "contextforge_retrieve",
                      content: vaultedText,
                    });
                    delete currentPayload.tools;
                    delete currentPayload.tool_choice;
                    return executeUpstreamRequest(
                      currentPayload,
                      retryCount + 1,
                      false,
                    );
                  } else {
                    console.warn(
                      `[Ghost Interceptor] ⚠️ Vault ${args.vault_id} returned empty — replaying as real tool`,
                    );
                  }
                }
              }

              // ── Memory tools ──
              if (isMemoryTool) {
                const userId =
                  req.headers["x-contextforge-user-id"] ?? "anonymous";
                const workspace = req.headers["x-contextforge-workspace"] ?? "";

                const toolResults = await executeMemoryToolCalls(
                  dummyMessage,
                  memoryHandler,
                  { userId, workspace },
                );

                if (toolResults.length > 0) {
                  console.log(
                    `[Ghost Interceptor] 🧠 Memory tool executed successfully`,
                  );
                  currentPayload.messages.push({
                    role: "assistant",
                    content: null,
                    tool_calls: dummyMessage.tool_calls,
                  });
                  currentPayload.messages.push(...toolResults);
                  delete currentPayload.tools;
                  delete currentPayload.tool_choice;
                  return executeUpstreamRequest(
                    currentPayload,
                    retryCount + 1,
                    false,
                  );
                }

                console.warn(
                  `[Ghost Interceptor] ⚠️ Memory tool returned no results — replaying as real tool`,
                );
              }
            }

            // ── Replay: real tool call ──
            if (heldEvents.length > 0) {
              if (!res.headersSent) {
                res.writeHead(proxyRes.statusCode, {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive",
                  "Access-Control-Allow-Origin": "*",
                });
              }
              for (const event of heldEvents) res.write(event);
            }

            // ── RAG indexing (fire-and-forget) ──
            if (
              !isRetrieveTool &&
              !isMemoryTool &&
              fullStreamedText.trim().length > 0
            ) {
              (async () => {
                try {
                  const tokenCount = Math.floor(fullStreamedText.length / 4);
                  if (tokenCount >= 50) {
                    const indexId = "IDX_" + crypto.randomUUID();
                    const embedding =
                      await onnxEmbedder.embed(fullStreamedText);
                    hybridRetriever.addDocumentWithEmbedding(
                      indexId,
                      fullStreamedText,
                      embedding,
                    );
                    console.log(
                      `[RAG Index] Indexed ${tokenCount} tokens (BM25 + HNSW, dim=384)`,
                    );
                  }
                } catch (err) {
                  console.error("[RAG Index] Indexing failed:", err.message);
                }
              })();
            }

            res.end();
            return;
          }

          // ── Non-streaming: JSON response ──
          const fullResponseBuf = Buffer.concat(responseChunks);
          let jsonResponse;

          try {
            jsonResponse = JSON.parse(fullResponseBuf.toString("utf-8"));
          } catch {
            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode, {
                ...proxyRes.headers,
                "Access-Control-Allow-Origin": "*",
              });
            }
            res.write(fullResponseBuf);
            return res.end();
          }

          // ── Upstream error translation ──
          if (proxyRes.statusCode >= 400) {
            console.error(
              `\n[Upstream Error] Status ${proxyRes.statusCode}:`,
              jsonResponse?.error?.message || "Unknown error",
            );
            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              });
            }
            return res.end(
              JSON.stringify({
                type: "error",
                error: {
                  type:
                    proxyRes.statusCode === 429
                      ? "rate_limit_error"
                      : proxyRes.statusCode === 529
                        ? "overloaded_error"
                        : "api_error",
                  message:
                    jsonResponse?.error?.message ||
                    `Upstream error: ${proxyRes.statusCode}`,
                },
              }),
            );
          }

          const message = jsonResponse.choices?.[0]?.message;

          // ── Memory tool interceptor (non-streaming) ──
          if (message?.tool_calls && hasMemoryToolCalls(message)) {
            const userId = req.headers["x-contextforge-user-id"] ?? "anonymous";
            const workspace = req.headers["x-contextforge-workspace"] ?? "";

            const toolResults = await executeMemoryToolCalls(
              message,
              memoryHandler,
              { userId, workspace },
            );

            if (toolResults.length > 0) {
              currentPayload.messages.push({
                role: "assistant",
                content: message.content ?? null,
                tool_calls: message.tool_calls,
              });
              currentPayload.messages.push(...toolResults);
              delete currentPayload.tools;
              delete currentPayload.tool_choice;
              return executeUpstreamRequest(
                currentPayload,
                retryCount + 1,
                false,
              );
            }
          }

          // ── Ghost interceptor (non-streaming) ──
          if (message?.tool_calls?.length > 0) {
            const toolCall = message.tool_calls[0];
            if (
              toolCall.function.name === "contextforge_retrieve" &&
              retryCount < 2
            ) {
              console.log(
                `\n[Ghost Interceptor] Non-streaming contextforge_retrieve`,
              );
              try {
                const args = JSON.parse(toolCall.function.arguments);
                const vaultedText = await retrieveFromVault(
                  args.vault_id,
                  args.search_query || null,
                  currentPayload.messages,
                  semanticCache,
                  hybridRetriever,
                );
                if (vaultedText) {
                  currentPayload.messages.push({
                    role: "assistant",
                    content: message.content ?? null,
                    tool_calls: message.tool_calls,
                  });
                  currentPayload.messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: vaultedText,
                  });
                  delete currentPayload.tools;
                  delete currentPayload.tool_choice;
                  return executeUpstreamRequest(
                    currentPayload,
                    retryCount + 1,
                    false,
                  );
                }
              } catch (err) {
                console.error("[Ghost Interceptor] Failed:", err.message);
              }
            }
          }

          // ── Translate response to Anthropic format ──
          if (isAnthropic) {
            const anthropicResponse = {
              id: jsonResponse.id || `msg_${Date.now()}`,
              type: "message",
              role: "assistant",
              content: [],
              model: jsonResponse.model || "contextforge",
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: {
                input_tokens: jsonResponse.usage?.prompt_tokens || 0,
                output_tokens: jsonResponse.usage?.completion_tokens || 0,
              },
            };

            if (message?.content) {
              anthropicResponse.content.push({
                type: "text",
                text: message.content,
              });
            }

            if (message?.tool_calls) {
              anthropicResponse.stop_reason = "tool_use";
              for (const tc of message.tool_calls) {
                anthropicResponse.content.push({
                  type: "tool_use",
                  id: tc.id,
                  name: tc.function.name,
                  input: JSON.parse(tc.function.arguments || "{}"),
                });
              }
            }

            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              });
            }
            res.write(JSON.stringify(anthropicResponse));
            return res.end();
          }

          // ── Non-Anthropic passthrough ──
          if (!res.headersSent) {
            res.writeHead(proxyRes.statusCode, {
              ...proxyRes.headers,
              "Access-Control-Allow-Origin": "*",
            });
          }
          res.write(fullResponseBuf);
          res.end();

          // ── RAG indexing for non-streaming responses ──
          if (
            proxyRes.statusCode === 200 &&
            message?.content?.trim().length > 0
          ) {
            (async () => {
              try {
                const tokenCount = Math.floor(message.content.length / 4);
                if (tokenCount >= 50) {
                  const indexId = "IDX_" + crypto.randomUUID();
                  const embedding = await onnxEmbedder.embed(message.content);
                  hybridRetriever.addDocumentWithEmbedding(
                    indexId,
                    message.content,
                    embedding,
                  );
                  console.log(
                    `[RAG Index] Indexed ${tokenCount} tokens (BM25 + HNSW, dim=384)`,
                  );
                }
              } catch (e) {
                console.error("[RAG Index] Indexing failed:", e.message);
              }
            })();
          }
        });
      });

      proxyReq.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "Bad Gateway", details: err.message }),
          );
        }
      });

      proxyReq.write(outboundBody);
      proxyReq.end();
    }

    // ─────────────────────────────────────────────
    // GATE: Decision before any transformation
    // Runs on raw Anthropic payload so token
    // counter sees the correct message format
    // ─────────────────────────────────────────────
    const decision = CompressionDecision.decide({
      headers: req.headers,
      optimize: getOptimizeFlag(),
      messages: payload.messages,
      payload: payload,
    });

    if (!decision.shouldCompress) {
      console.log(`[Pipeline] Passthrough: ${decision.passthroughReason}`);
      // Translate even on passthrough — strips $schema poison
      // and converts to OpenAI format before hitting Nemotron
      if (isAnthropic) {
        payload = translateAnthropicToOpenAI(payload);
      }
      executeUpstreamRequest(payload);
      return;
    }

    // ─────────────────────────────────────────────
    // COMPRESSION PIPELINE (Anthropic branch only)
    // ─────────────────────────────────────────────
    if (isAnthropic) {
      // Attach policy before pipeline stages
      // Uses original payload.model before executeUpstreamRequest overrides it
      const policy = getPolicyForModel(payload.model || "");
      Object.defineProperty(payload, "__policy", {
        value: policy,
        writable: true,
        enumerable: false,
        configurable: true,
      });

      // Stage: Translation (baseline token count taken here)
      const baselineTokens = timer.time(STAGES.TRANSLATION, () => {
        payload = translateAnthropicToOpenAI(payload);
        return countTokens(payload);
      });

      timer.time(STAGES.MEMORY_INJECT, () => {
        payload = injectMemoryTools(payload);
      });

      timer.time(STAGES.SCRUB, () => {
        payload = scrubToolResults(payload);
      });

      await timer.timeAsync(STAGES.TAG, async () => {
        payload = await tagToolResults(payload);
      });

      timer.time(STAGES.SEMANTIC_DEDUP, () => {
        payload = applySemanticDedup(payload);
      });

      timer.time(STAGES.PRUNE, () => {
        payload = pruneToolResults(payload);
      });

      timer.time(STAGES.SLICE_CODE, () => {
        payload = sliceJsonToolResults(payload);
      });

      timer.time(STAGES.CODE_COMPRESS, () => {
        payload = compressCodeToolResults(payload);
      });

      timer.time(STAGES.PREDICTIVE, () => {
        payload = applyPredictiveInjection(payload, hybridRetriever);
      });

      timer.time(STAGES.VAULT_INTERCEPT, () => {
        payload = interceptAndVaultMassiveToolResults(
          payload,
          policy.singleMsgVaultThreshold,
        );
      });

      timer.time(STAGES.STRIP_ANTHROPIC, () => {
        payload = stripAnthropicSpecificFields(payload);
      });

      timer.time(STAGES.CCR_PIPELINE, () => {
        payload = applyCCRPipeline(payload, baselineTokens);
      });

      // Stage: Memory context injection
      await timer.timeAsync(STAGES.MEMORY_CONTEXT, async () => {
        const memDecision = MemoryDecision.decide({
          headers: req.headers,
          memoryHandler: memoryHandler,
          memoryUserId: req.headers["x-contextforge-user-id"] ?? null,
          modeName: getMemoryMode(),
        });

        if (memDecision.inject) {
          const userId = req.headers["x-contextforge-user-id"];
          const workspace = req.headers["x-contextforge-workspace"] ?? "";

          const ctx = await memoryHandler.searchAndFormatContext(
            userId,
            payload.messages,
            workspace,
          );

          if (ctx) {
            payload.messages = memoryHandler.appendContextToMessages(
              payload.messages,
              ctx,
            );
            console.log(
              `[Memory] Injected ${ctx.length} chars for user=${userId}`,
            );
          }
        }
      });

      timer.time(STAGES.MINIMIZE_TOOLS, () => {
        payload = minimizeToolSchemas(payload);
      });

      timer.time(STAGES.DEDUPLICATE, () => {
        payload = deduplicateSystemMessages(payload);
      });

      // ── Graph tool injection ──           ← ADD THIS BLOCK
      timer.time(STAGES.GRAPH_INJECT, () => {
        payload.tools = injectGraphTool(payload.tools);
      });

      // NEW — must be LAST before transmission
      timer.time(STAGES.CACHE_ALIGN, () => {
        payload = alignCachePrefix(payload);
      });

      // ── Pipeline report ──
      const finalTokens = countTokens(payload);
      const tokensSaved = baselineTokens - finalTokens;
      const totalLatencyMs = performance.now() - startTime;

      savingsTracker.recordRequest({
        model: payload.model || "unknown",
        inputTokens: finalTokens,
        tokensSaved,
      });

      console.log("\n=== ContextForge Pipeline Report ===");
      console.log(`[Metrics] Baseline Tokens:  ${baselineTokens}`);
      console.log(`[Metrics] Final Tokens:     ${finalTokens}`);
      console.log(`[Metrics] Total Saved:      ${tokensSaved}`);
      if (baselineTokens > 0) {
        console.log(
          `[Metrics] Compression:      ${((tokensSaved / baselineTokens) * 100).toFixed(1)}%`,
        );
      }
      console.log(`[Metrics] Latency Added:    ${totalLatencyMs.toFixed(2)}ms`);
      console.log(`[Decision] ${decision}`);

      const stages = timer.summary();
      for (const [stage, ms] of Object.entries(stages)) {
        if (ms > 1) console.log(`[Stage] ${stage}: ${ms.toFixed(1)}ms`);
      }

      // ── Mutation detection ──
      const payloadStr = JSON.stringify(payload);
      const { isMutation, mutatedFile } = detectMutation(payloadStr);
      if (isMutation && mutatedFile) {
        const newHash = hashFile(mutatedFile);
        const result = invalidateByFile(mutatedFile, newHash, semanticCache);
        if (result.deletedIds.length > 0) {
          console.log(
            `\n[State Monitor] 🚨 Mutation detected on '${mutatedFile}'. ` +
              `Invalidated ${result.deletedIds.length} cache entries.`,
          );
        }
      }

      executeUpstreamRequest(payload);
    } else {
      // Non-Anthropic: passthrough unmodified
      console.log("[Pipeline] Non-Anthropic request, forwarding unmodified");
      executeUpstreamRequest(payload);
    }
  });

  req.on("error", (err) => {
    console.error("Ingress Socket Error:", err.message);
  });
});

server.listen(3000, () => {
  console.log("ContextForge Proxy routing engine active on port 3000");
});

process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down ContextForge Proxy...");
  if (global.embeddingWorker) global.embeddingWorker.terminate();

  if (savingsTracker && typeof savingsTracker.getSummary === "function") {
    console.log("\n" + savingsTracker.getSummary());
  } else {
    console.log("\n[Stats] Session ended.");
  }

  process.exit(0);
});
