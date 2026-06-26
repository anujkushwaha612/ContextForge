import http from "node:http";
import { createRequire } from "module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { writeFileSync, readFileSync } from "node:fs";

// ── ContextForge core ──
import { detectAdapter } from "./adapters/index.js";
import { OllamaAdapter } from "./providers/ollama.js";
import {
  fetchFromVault,
  fetchVaultTextConcatenated,
  invalidateByFile,
  resetEntireCache,
} from "./logging/cacheDb.js";
import { countTokens } from "./compression/compressionHelper.js";
import { applySemanticDedup } from "./compression/semanticDedup.js";
import { statsEmitter } from "./proxy/statsEmitter.js";

// ── Message Origin ──
import {
  detectMessageOrigin,
  detectRecentToolActivity,
  requiresRepositoryWork,
} from "./proxy/messageOrigin.js";

// ── Pipeline helpers ──
import {
  detectMutation,
  hashFile,
  minimizeToolSchemas,
  interceptAndVaultMassiveToolResults,
  scrubToolResults,
  tagToolResults,
  pruneToolResults,
  sliceJsonToolResults,
  applyPredictiveInjection,
  deduplicateSystemMessages,
  stripAnthropicSpecificFields,
} from "./helper.js";

// ── Compression stages ──
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
import { applyCCRPipeline } from "./ccr/index.js";

// ── Memory ──
import { MemoryHandler } from "./memory/memoryHandler.js";
import { setEmbedder } from "./memory/embedder.js";
import { injectMemoryTools } from "./memory/memoryTools.js";

// ── Graph + Patch ──
import { indexWorkspace, watchWorkspace } from "./graph/workspaceMapper.js";
import {
  injectGraphTool,
  injectReadFileChunkTool,
} from "./graph/graphTools.js";
import { injectPatchTool } from "./graph/patchTools.js";

// ── Request Planner ──
import {
  initPlanner,
  planPipeline,
  CAPABILITIES,
} from "./proxy/requestPlanner.js";

// ── Upstream handler ──
import { createUpstreamHandler } from "./proxy/upstreamRequest.js";
import { extractGeminiInlineContent } from "./compression/geminiContentExtractor.js";

const require = createRequire(import.meta.url);
const native = require("../native/build/Release/contextforge_native.node");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────
// Provider — single instance, always Ollama for now
// ─────────────────────────────────────────────
const provider = new OllamaAdapter();

// ─────────────────────────────────────────────
// Native module initialization
// ─────────────────────────────────────────────

console.log("Initializing ContextForge Native Engine...");

(async () => {
  const workspacePath = process.env.CF_WORKSPACE_PATH || process.cwd();

  // ── Step 1: Index workspace ────────────────────────────────────────────
  try {
    await indexWorkspace(workspacePath, {
      force: false,
      onProgress: ({ current, total, file }) => {
        if (current % 50 === 0) {
          console.log(`[GraphMapper] Progress: ${current}/${total} — ${file}`);
        }
      },
    });
    const watcher = watchWorkspace(workspacePath);
    process.on("SIGINT", () => watcher.stop());
  } catch (err) {
    console.error(`[GraphMapper] ❌ Failed to index workspace: ${err.message}`);
  }

  // ── Step 2: Initialize embedder and planner ───────────────────────────
  await onnxEmbedder.embed("warmup");
  console.log("[Embedder] Ready");
  console.log("[Embedder] Stats:", onnxEmbedder.getStats());

  await initPlanner(onnxEmbedder, semanticCache);
  console.log("[Planner] ✅ Initialization complete");

  // ── Step 3: Start accepting requests ──────────────────────────────────
  server.listen(3000, () => {
    console.log("ContextForge Proxy routing engine active on port 3000");
  });
})();

const onnxEmbedder = new native.OnnxEmbedder(
  path.join(__dirname, "../models/all-MiniLM-L6-v2-int8.onnx"),
  path.join(__dirname, "../models/tokenizer.json"),
  { dim: 384, cacheSize: 512, batchWaitMs: 1 },
);

setEmbedder(onnxEmbedder);
// Warmup and initialization moved to startup sequence

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

console.log("[Memory] PersistentMemoryStore ready");

// ─────────────────────────────────────────────
// Embedding worker
// ─────────────────────────────────────────────

const workerPath = path.join(__dirname, "workers", "embeddingWorker.js");
global.embeddingWorker = new Worker(workerPath, {
  execArgv: ["--experimental-vm-modules"],
});

global.embeddingWorker.on("error", (err) =>
  console.error(`\n[Background Thread] Fatal Error: ${err.message}`),
);

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
      const allVectors = [];

      for (let i = 0; i < msg.texts.length; i += BATCH_SLICE) {
        const slice = msg.texts.slice(i, i + BATCH_SLICE);
        const vectors = await onnxEmbedder.embedBatch(slice);
        for (const v of vectors) allVectors.push(Array.from(v));
        if (i + BATCH_SLICE < msg.texts.length) {
          await new Promise((r) => setImmediate(r));
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
      "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
      "Access-Control-Allow-Headers": [
        "Content-Type",
        "Authorization",
        "x-api-key",
        "x-goog-api-key",
        "anthropic-version",
        "anthropic-beta",
        "x-cf-dry-run",
        "x-contextforge-user-id",
        "x-contextforge-workspace",
      ].join(", "),
    });
    return res.end();
  }

  // ── SSE stats stream ──
  if (req.url === "/v1/stats/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(
      `event: snapshot\ndata: ${JSON.stringify(statsEmitter.getSnapshot("initial"))}\n\n`,
    );
    const listener = (snap) =>
      res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
    statsEmitter.on("snapshot", listener);
    req.on("close", () => statsEmitter.off("snapshot", listener));
    return;
  }

  // ── Dashboard ──
  if (req.url === "/dashboard" && req.method === "GET") {
    const html = readFileSync(path.join(__dirname, "dashboard.html"), "utf-8");
    const dashboardHeaders = { "Content-Type": "text/html" };
    if (process.env.CF_IS_TEST_ENV === "true") {
      dashboardHeaders["x-cf-test-mode"] = "active";
    }
    res.writeHead(200, dashboardHeaders);
    return res.end(html);
  }

  // ── Cache invalidation ──
  if (req.url.startsWith("/v1/cache/invalidate") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body);
        if (!id) throw new Error("Missing ID");
        semanticCache.invalidate(id);
        console.log(`\n[Cache Invalidation] 🗑️ Vector ${id} wiped.`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ success: true, message: `Invalidated ${id}` }),
        );
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON or missing 'id'" }));
      }
    });
    return;
  }

  // ── Nuclear cache reset ──
  if (req.url.startsWith("/v1/cache/reset") && req.method === "POST") {
    try {
      resetEntireCache(semanticCache);
      console.log("\n[Cache Reset] ☢️ Nuclear reset triggered.");
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

  // ── Vault read (regression tests only) ──
  if (req.url.startsWith("/v1/vault/") && req.method === "GET") {
    const vaultId = req.url.split("/v1/vault/")[1]?.split("?")[0];
    if (!vaultId?.startsWith("cf_vault_")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid vault ID" }));
    }
    try {
      const content =
        fetchVaultTextConcatenated(vaultId) || fetchFromVault(vaultId);
      if (!content) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: "Vault not found", vault_id: vaultId }),
        );
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(
        JSON.stringify({
          vault_id: vaultId,
          content,
          chars: content.length,
          tokens: Math.floor(content.length / 4),
        }),
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ error: "Vault read failed", details: err.message }),
      );
    }
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Method Not Allowed" }));
  }

  // ── Collect body ──
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
      payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
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

    // ── Detect client format + normalize to OpenAI internal format ──
    const { adapter: clientAdapter } = detectAdapter(req.url, req.headers);
    const { payload: normalizedPayload } = clientAdapter.toInternal(
      payload,
      req.headers,
    );
    payload = normalizedPayload;

    // Drives egress format — pipeline always sees OpenAI format internally
    const isAnthropic = clientAdapter.name === "anthropic";

    // FIX F10: Save original model before upstream handler mutates it
    const clientModel = payload.model || "unknown";

    // ── Parse per-request retry budget override ──
    const maxRetriesHeader = req.headers["x-cf-max-retries"];
    const parsedMaxRetries = maxRetriesHeader
      ? parseInt(maxRetriesHeader, 10)
      : NaN;
    const maxRetries =
      Number.isInteger(parsedMaxRetries) && parsedMaxRetries >= 0
        ? parsedMaxRetries
        : undefined;

    // ── Bind upstream handler for this request ──
    const executeUpstreamRequest = createUpstreamHandler({
      req,
      res,
      isAnthropic,
      clientAdapter,
      provider,
      semanticCache,
      hybridRetriever,
      onnxEmbedder,
      memoryHandler,
      maxRetries,
    });

    // ─────────────────────────────────────────────
    // Gemini inline file content extraction
    // ─────────────────────────────────────────────
    if (clientAdapter.name === "gemini") {
      payload = extractGeminiInlineContent(payload);
    }

    // ─────────────────────────────────────────────
    // TRUE BASELINE — before any pipeline stage runs
    // ─────────────────────────────────────────────
    const trueBaselineTokens = countTokens(payload);

    // ── Always-on stages ──
    timer.time(STAGES.MINIMIZE_TOOLS, () => {
      payload = minimizeToolSchemas(payload);
      if (payload._cf_minimizeTokensSaved) {
        timer.recordTokenSavings(
          STAGES.MINIMIZE_TOOLS,
          payload._cf_minimizeTokensSaved,
        );
        delete payload._cf_minimizeTokensSaved;
      }
    });
    timer.time(STAGES.DEDUPLICATE, () => {
      payload = deduplicateSystemMessages(payload);
      if (payload._cf_sysPromptTokensSaved) {
        timer.recordTokenSavings(
          STAGES.DEDUPLICATE,
          payload._cf_sysPromptTokensSaved,
        );
        delete payload._cf_sysPromptTokensSaved;
      }
    });

    const afterAlwaysOnTokens = countTokens(payload);

    const hasPriorTools = detectRecentToolActivity(payload.messages);

    let plan;
    await timer.timeAsync(STAGES.GRAPH_INJECT, async () => {
      // ── Step 1: Message origin detection ──────────────────────────────
      // Determines if this is a human task, agent status update, or
      // mid-session continuation. Uses conversation structure, not
      // token count — so "Rename foo." (8 tokens) still gets tools.
      const originResult = detectMessageOrigin(payload.messages);

      console.log(
        `[Planner] Origin: ${originResult.origin} | Reason: ${originResult.reason}`,
      );

      // Agent status updates and tool followups never need repository tools.
      // Short "Done." / "Patch applied." messages bypass immediately.
      // Tool result messages are mid-loop — the LLM already has the tools it needs.
      if (!requiresRepositoryWork(originResult.origin)) {
        plan = {
          capabilities: new Set(),
          intent: originResult.origin, // Use origin as intent (AGENT_STATUS or TOOL_FOLLOWUP)
          method: "origin_detection",
          bypass: true,
        };
        console.log(
          `[Planner] ⏭️ Bypass — ${originResult.origin.toLowerCase()}, no repository work needed`,
        );
        return;
      }

      // ── Step 2: Intent + capability planning ──────────────────────────
      plan = await planPipeline(
        payload,
        { hasPriorTools, trueBaselineTokens, originHint: originResult.origin },
        onnxEmbedder,
      );

      console.log(
        `[Planner] Intent: ${plan.intent} | Method: ${plan.method}` +
          (plan.debug?.semanticScore !== undefined
            ? ` | Score: ${plan.debug.semanticScore.toFixed(3)}`
            : "") +
          (plan.debug?.regexConfidence !== undefined
            ? ` | Confidence: ${plan.debug.regexConfidence.toFixed(2)}`
            : ""),
      );
      // NEW: structured evidence for debugging misclassifications
      if (plan.debug?.evidence?.length > 0) {
        console.log(`[Planner] Evidence: ${plan.debug.evidence.join(" | ")}`);
      }

      if (!plan.bypass) {
        if (plan.capabilities.has(CAPABILITIES.GRAPH))
          payload.tools = injectGraphTool(payload.tools);
        if (plan.capabilities.has(CAPABILITIES.PATCH))
          payload.tools = injectPatchTool(payload.tools);
        if (plan.capabilities.has(CAPABILITIES.READ))
          payload.tools = injectReadFileChunkTool(payload.tools);
      } else {
        console.log(
          `[Planner] ⏭️ Bypass — '${plan.intent}' needs no file capabilities`,
        );
      }
    });

    const baselineTokens = countTokens(payload);
    const alwaysOnSaved = trueBaselineTokens - afterAlwaysOnTokens;
    const toolInjectionCost = baselineTokens - afterAlwaysOnTokens;

    // ─────────────────────────────────────────────
    // GATE: Compression decision
    // ─────────────────────────────────────────────
    const decision = CompressionDecision.decide({
      headers: req.headers,
      optimize: getOptimizeFlag(),
      messages: payload.messages,
      payload,
      precomputedTokens: trueBaselineTokens,
    });

    if (!decision.shouldCompress) {
      const passthroughTokens = countTokens(payload);
      const computedAlwaysOnSaved = trueBaselineTokens - passthroughTokens;
      console.log(`[Pipeline] Passthrough: ${decision.passthroughReason}`);
      if (computedAlwaysOnSaved > 0) {
        console.log(
          `[Pipeline] Always-on saved: ${computedAlwaysOnSaved} tokens ` +
            `(${((computedAlwaysOnSaved / trueBaselineTokens) * 100).toFixed(1)}% reduction before gate)`,
        );
      }
      const passthroughMetrics = await executeUpstreamRequest(payload);
      console.log(
        `[Metrics] Total E2E Latency: ${(performance.now() - startTime).toFixed(2)}ms`,
      );
      if ((passthroughMetrics?.ghostRetries ?? 0) > 0) {
        console.log(
          `[Metrics] Ghost Retries:      ${passthroughMetrics.ghostRetries}`,
        );
        console.log(
          `[Metrics] Total Wire Tokens:  ${passthroughMetrics.accumulatedInputTokens}`,
        );
      }
      return;
    }

    // ─────────────────────────────────────────────
    // COMPRESSION PIPELINE
    // ─────────────────────────────────────────────

    const policy = getPolicyForModel(payload.model || "");
    Object.defineProperty(payload, "__policy", {
      value: policy,
      writable: true,
      enumerable: false,
      configurable: true,
    });

    // ─────────────────────────────────────────────
    // Compressible content pre-check
    // ─────────────────────────────────────────────
    const hasCompressibleContent = payload.messages?.some(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        m.content.length > 800 &&
        !m._cf_vaulted &&
        !m._dedupVaultId &&
        !m._cf_deduped &&
        !m._compressedVaultId &&
        !m.content.includes("[CF_VAULT:"),
    );

    if (!hasCompressibleContent) {
      console.log(
        `[Pipeline] ⏭️ No compressible tool results — skipping content stages`,
      );
    }

    // 1. Inject Memory Tools
    timer.time(STAGES.MEMORY_INJECT, () => {
      payload = injectMemoryTools(payload);
    });

    // 2. Scrub Tool Results
    if (hasCompressibleContent) {
      timer.time(STAGES.SCRUB, () => {
        payload = scrubToolResults(payload);
      });
    }

    // 3. Prune Tool Results
    if (hasCompressibleContent) {
      timer.time(STAGES.PRUNE, () => {
        payload = pruneToolResults(payload);
      });
    }

    // 4. Tag Tool Results
    if (hasCompressibleContent) {
      await timer.timeAsync(STAGES.TAG, async () => {
        payload = await tagToolResults(payload);
      });
    }

    // 5. Semantic Dedup
    if (hasCompressibleContent) {
      await timer.timeAsync(STAGES.SEMANTIC_DEDUP, async () => {
        payload = await applySemanticDedup(payload);
      });
    }

    // 6. Slice JSON Tool Results
    if (hasCompressibleContent) {
      timer.time(STAGES.SLICE_CODE, () => {
        payload = sliceJsonToolResults(payload);
      });
    }

    // 7. AST Compress Code
    if (hasCompressibleContent) {
      await timer.timeAsync(STAGES.CODE_COMPRESS, async () => {
        payload = await compressCodeToolResults(payload);
      });
    }

    // 8. Fat Catch / Vault Intercept
    if (hasCompressibleContent) {
      timer.time(STAGES.VAULT_INTERCEPT, () => {
        payload = interceptAndVaultMassiveToolResults(
          payload,
          policy.singleMsgVaultThreshold,
        );
      });
    }

    // 10. Anthropic-specific field stripping (if applicable)
    if (isAnthropic) {
      timer.time(STAGES.STRIP_ANTHROPIC, () => {
        payload = stripAnthropicSpecificFields(payload);
      });
    }

    // 11. CCR Pipeline
    timer.time(STAGES.CCR_PIPELINE, () => {
      let ccrBaseline = baselineTokens;
      const hasVault = payload.messages?.some((m) => {
        if (typeof m.content === "string" && m.content.includes("[CF_VAULT:"))
          return true;
        if (Array.isArray(m.content)) {
          return m.content.some(
            (b) =>
              typeof b.content === "string" && b.content.includes("[CF_VAULT:"),
          );
        }
        return false;
      });

      if (hasVault) {
        ccrBaseline = Infinity;
      }

      payload = applyCCRPipeline(payload, ccrBaseline);
    });

    // 12. Inject Memory Context
    await timer.timeAsync(STAGES.MEMORY_CONTEXT, async () => {
      const memDecision = MemoryDecision.decide({
        headers: req.headers,
        memoryHandler,
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

    // 13. Align Cache Prefix
    timer.time(STAGES.CACHE_ALIGN, () => {
      payload = alignCachePrefix(payload, clientAdapter.name);
    });

    const pipelineLatencyMs = performance.now() - startTime;
    const finalTokens = countTokens(payload);
    const totalSaved = trueBaselineTokens - finalTokens;
    const pipelineSaved = baselineTokens - finalTokens;
    const stages = timer.summary();

    // ── Dry-run ──
    if (req.headers["x-cf-dry-run"] === "true") {
      const vaultIds = [];
      const vaultPattern = /\[CF_VAULT:\s*(cf_vault_[a-f0-9]+)\]/g;
      const payloadStr = JSON.stringify(payload);
      let vaultMatch;
      while ((vaultMatch = vaultPattern.exec(payloadStr)) !== null) {
        if (!vaultIds.includes(vaultMatch[1])) vaultIds.push(vaultMatch[1]);
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(
        JSON.stringify({
          pipeline_ms: pipelineLatencyMs,
          tokens_before: trueBaselineTokens,
          tokens_after: finalTokens,
          tokens_saved: totalSaved,
          compression_ratio:
            trueBaselineTokens > 0
              ? parseFloat(((totalSaved / trueBaselineTokens) * 100).toFixed(1))
              : 0,
          stages,
          vault_ids: vaultIds,
          vault_id: vaultIds[0] ?? null,
        }),
      );
    }

    // ── Mutation detection ──
    const payloadStr = JSON.stringify(payload);
    const { isMutation, mutatedFile } = detectMutation(payloadStr);
    if (isMutation && mutatedFile) {
      const newHash = hashFile(mutatedFile);
      const result = invalidateByFile(mutatedFile, newHash, semanticCache);
      if (result.deletedIds.length > 0) {
        console.log(
          `\n[State Monitor] 🚨 Mutation on '${mutatedFile}'. ` +
            `Invalidated ${result.deletedIds.length} entries.`,
        );
      }
    }

    const upstreamMetrics = await executeUpstreamRequest(payload);
    const totalLatencyMs = performance.now() - startTime;

    const wireTokens = upstreamMetrics?.accumulatedInputTokens ?? finalTokens;
    const ghostRetries = upstreamMetrics?.ghostRetries ?? 0;

    // FIX F10: Use clientModel instead of mutated payload.model
    savingsTracker.recordRequest({
      model: clientModel,
      inputTokens: wireTokens,
      tokensSaved: trueBaselineTokens * (ghostRetries + 1) - wireTokens,
      ghostRetries: ghostRetries,
    });
    statsEmitter.recordRequest({
      baselineTokens: trueBaselineTokens,
      finalTokens: wireTokens,
      pipelineLatency: pipelineLatencyMs,
      upstreamLatency: totalLatencyMs - pipelineLatencyMs,
    });

    // ── Pipeline report ──
    console.log("\n=== ContextForge Pipeline Report ===");
    console.log(`[Client]  ${clientAdapter.name}`);
    console.log(`[Metrics] True Baseline:      ${trueBaselineTokens}`);
    console.log(
      `[Metrics] After Minimize+Dedup: ${afterAlwaysOnTokens} (saved ${alwaysOnSaved} tokens)`,
    );
    if (toolInjectionCost > 0) {
      console.log(
        `[Metrics] Tool Injection Cost:  +${toolInjectionCost} tokens (graph+patch schemas)`,
      );
    }
    console.log(`[Metrics] After Always-On:    ${baselineTokens}`);
    console.log(`[Metrics] Final Tokens:       ${finalTokens}`);
    // ── Savings breakdown (replaces raw "Total Saved" line) ──
    console.log(`[Metrics] Savings Breakdown:`);
    const _tokenSavingsSnap = timer.tokenSummary();
    const _sysPromptSaved = _tokenSavingsSnap[STAGES.DEDUPLICATE] ?? 0;
    const _toolSchemaSaved = alwaysOnSaved - _sysPromptSaved;
    console.log(
      `          ├─ Tool Schemas:        ↓${_toolSchemaSaved} tokens`,
    );
    console.log(`          ├─ System Prompt Dedup: ↓${_sysPromptSaved} tokens`);
    console.log(`          └─ Semantic/AST:        ↓${pipelineSaved} tokens`);
    console.log(
      `[Metrics] Total Saved:        ${totalSaved} tokens (vs true baseline)`,
    );

    if (totalSaved < 0) {
      console.warn(
        `[Pipeline] ⚠️ Net-negative: pipeline inflated by ${-totalSaved} tokens`,
      );
    }

    if (trueBaselineTokens > 0) {
      console.log(
        `[Metrics] Compression:        ${((totalSaved / trueBaselineTokens) * 100).toFixed(1)}%`,
      );
    }
    if (ghostRetries > 0) {
      console.log(`[Metrics] Ghost Retries:      ${ghostRetries}`);
      console.log(
        `[Metrics] Total Wire Tokens:  ${wireTokens} (${ghostRetries + 1} LLM hops)`,
      );
    }
    console.log(
      `[Metrics] Pipeline Latency:   ${pipelineLatencyMs.toFixed(2)}ms`,
    );
    console.log(`[Metrics] Total E2E Latency:  ${totalLatencyMs.toFixed(2)}ms`);
    console.log(
      `[Metrics] Content Stages:     ${hasCompressibleContent ? "ACTIVE" : "SKIPPED (no compressible content)"}`,
    );
    console.log(`[Decision] ${decision}`);

    for (const [stage, ms] of Object.entries(stages)) {
      if (ms > 1) console.log(`[Stage] ${stage}: ${ms.toFixed(1)}ms`);
    }

    const tokenSavings = timer.tokenSummary();
    if (Object.keys(tokenSavings).length > 0) {
      console.log(`[Tokens]  Stage Savings:`);
      for (const [stage, saved] of Object.entries(tokenSavings)) {
        if (saved > 0) console.log(`[Tokens]    ${stage}: ↓${saved} tokens`);
      }
    }
  });

  req.on("error", (err) => console.error("Ingress Socket Error:", err.message));
});

// Moved to async startup block — see top of file

process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down ContextForge Proxy...");
  if (global.embeddingWorker) global.embeddingWorker.terminate();
  if (savingsTracker?.getSummary)
    console.log("\n" + savingsTracker.getSummary());
  else console.log("\n[Stats] Session ended.");
  process.exit(0);
});
