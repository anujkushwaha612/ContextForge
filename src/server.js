/**
 * server.js
 *
 * Fixes applied:
 *   SV-1: _cachedPlan and _cachedMessageHash removed. The plan cache was
 *         a size-1 global shared across concurrent requests with no TTL.
 *         planPipeline is async ~50ms — the cache saved nothing meaningful
 *         while adding concurrency confusion. planPipeline now runs every turn.
 *
 *   SV-3: req.on("end") async handler wrapped in top-level try/catch.
 *         Without it, any uncaught throw inside the pipeline (planPipeline
 *         embedder crash, countTokens on malformed payload, etc.) produces
 *         an UnhandledPromiseRejection and leaves the client hanging with
 *         no response. Now returns 500 with error details.
 *
 *   SV-4: MCP handler dynamic import() replaced with static imports at
 *         module top. executeGraphQuery, executeReadFileChunk, and
 *         executePatchToolCall are already loaded by the module graph —
 *         dynamic import() added unnecessary Promise overhead per request.
 *
 *   SV-5: hasCompressibleContent check adds [CF_COMPRESSED_FILE guard.
 *         AST-compressed messages have large content that could incorrectly
 *         trigger compression stages if _compressedVaultId was stripped.
 *
 *   SV-8: SSE stats stream listener wrapped in try/catch — res.write on a
 *         broken connection throws synchronously, which previously crashed
 *         the listener without removing itself from statsEmitter.
 *
 *   SV-9: countTokens call count reduced from 4 to 2 on the critical path.
 *         Calls 2 (afterAlwaysOnTokens) and 3 (baselineTokens) were only
 *         used in commented-out log lines and for ccrBaseline. ccrBaseline
 *         now uses trueBaselineTokens as a conservative approximation.
 *
 *   SV-10: Empty console.log() removed — was printing a blank line on
 *          every request due to commented-out content inside console.log().
 *
 *   SV-11: SIGINT handler now calls server.close() for graceful drain with
 *          a 5s force-exit timeout fallback.
 */

import http from "node:http";
import { createRequire } from "module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import crypto from "node:crypto";

// ── ContextForge core ──
import { detectAdapter } from "./adapters/index.js";
import { ProviderFactory } from "./providers/index.js";
import {
  fetchFromVault,
  fetchVaultTextConcatenated,
  invalidateByFile,
  resetEntireCache,
} from "./logging/cacheDb.js";
import { countTokens } from "./compression/compressionHelper.js";

import { applySemanticDedup } from "./compression/semanticDedup.js";
import { statsEmitter } from "./proxy/statsEmitter.js";
import { pruneStaleToolResults } from "./compression/historyPruner.js";
import { debugTranslation } from "./proxy/translationDebug.js";

// ── Message Origin ──
import {
  detectMessageOrigin,
  detectRecentToolActivity,
  requiresRepositoryWork,
} from "./proxy/messageOrigin.js";

// ── Pipeline helpers ──
import { detectMutation, hashFile } from "./utils/fileUtils.js";
import { minimizeToolSchemas } from "./proxy/translator.js";
import { interceptAndVaultMassiveToolResults } from "./compression/fatCatch.js";
import { scrubToolResults, tagToolResults } from "./compression/toolScrubber.js";
import { injectContextForgeRule, deduplicateSystemMessages } from "./proxy/systemMessages.js";
import { stripAnthropicSpecificFields } from "./proxy/translator.js";

// ── Compression stages ──
import { compressCodeToolResults } from "./compression/astCompressor.js";
import { getPolicyForModel } from "./compression/compressionPolicy.js";
import { CompressionDecision, getOptimizeFlag } from "./proxy/compressionDecision.js";
import { MemoryDecision, getMemoryMode } from "./proxy/memoryDecision.js";
import { StageTimer, STAGES } from "./proxy/stageTimer.js";
import { savingsTracker } from "./proxy/savingsTracker.js";
import { applyCCRPipeline } from "./ccr/index.js";

// ── Memory ──
import { MemoryHandler } from "./memory/memoryHandler.js";
import { setEmbedder } from "./memory/embedder.js";
import { injectMemoryTools } from "./memory/memoryTools.js";

// ── Graph + Patch ──
import { indexWorkspace, watchWorkspace, setSymbolEmbedder } from "./graph/workspaceMapper.js";
import {
  injectGraphTool,
  injectReadFileChunkTool,
  executeGraphQuery, // SV-4: static import replaces dynamic import()
  executeReadFileChunk, // SV-4: static import replaces dynamic import()
  getGraphToolDefinition, // CF-P8: served to the MCP bridge via /v1/mcp/tools
  getReadFileChunkToolDefinition, // CF-P8
} from "./graph/graphTools.js";
import {
  injectPatchTool,
  executePatchToolCall, // SV-4: static import replaces dynamic import()
  getPatchToolDefinition, // CF-P8
} from "./graph/patchTools.js";

// ── Request Planner ──
import { initPlanner, planPipeline, CAPABILITIES } from "./proxy/requestPlanner.js";

// ── Upstream handler ──
import { createUpstreamHandler } from "./proxy/upstreamRequest.js";
import { extractGeminiInlineContent } from "./compression/geminiContentExtractor.js";

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CF-P1: Never crash with a raw stack trace at import. The CLI relays
// structured CF_ERR_* lines to the user (cf doctor explains the fix).
// Resolution order matches the CLI: shipped prebuild first, local dev build second.
import { existsSync as _existsSync } from "node:fs";
const NATIVE_CANDIDATES = [
  path.join(__dirname, `../prebuilds/${process.platform}-${process.arch}/contextforge_native.node`),
  path.join(__dirname, "../native/build/Release/contextforge_native.node"),
];
let native;
{
  const found = NATIVE_CANDIDATES.find((p) => _existsSync(p));
  if (!found) {
    console.error(`CF_ERR_NATIVE_LOAD no addon for ${process.platform}-${process.arch}`);
    console.error(`Searched:\n  ${NATIVE_CANDIDATES.join("\n  ")}`);
    console.error("Run `cf doctor` for diagnosis.");
    process.exit(10);
  }
  try {
    native = require(found);
  } catch (err) {
    console.error(`CF_ERR_NATIVE_LOAD ${err.message}`);
    console.error("Native addon failed to load. Run `cf doctor` for diagnosis.");
    process.exit(10);
  }
}

const providerName = process.env.CF_PROVIDER || "ollama";
const provider = ProviderFactory.getAdapter(providerName);

// SV-1 FIX: Removed _cachedPlan / _cachedMessageHash module-level globals.
// The cache was size-1, shared across concurrent requests, with no TTL.
// planPipeline is ~50ms — running it every turn costs less than the
// concurrency confusion of a stale global cache.

function hashMessage(msg) {
  if (!msg) return "";
  return crypto.createHash("sha256").update(msg).digest("hex");
}

// ─────────────────────────────────────────────
// Native module initialization
// ─────────────────────────────────────────────

console.log("Initializing ContextForge Native Engine...");

// CF-P2: Model + data dirs are injectable by the CLI.
//   CF_MODEL_DIR → ~/.contextforge/models        (default: repo-local)
//   CF_DATA_DIR  → ~/.contextforge/data/<ws-hash> (default: repo-local ./data)
const MODEL_DIR = process.env.CF_MODEL_DIR || path.join(__dirname, "../contextforge_models");
const DATA_DIR = process.env.CF_DATA_DIR || path.join(__dirname, "./data");
mkdirSync(DATA_DIR, { recursive: true });

const modelPath = path.join(MODEL_DIR, "all-MiniLM-L6-v2-int8.onnx");
const tokenizerPath = path.join(MODEL_DIR, "tokenizer.json");
if (!existsSync(modelPath) || !existsSync(tokenizerPath)) {
  console.error(`CF_ERR_MODEL_MISSING dir=${MODEL_DIR}`);
  console.error("Models not found. Run `cf setup` (or scripts/setup-onnx.sh) to download them.");
  process.exit(10);
}

const onnxEmbedder = new native.OnnxEmbedder(modelPath, tokenizerPath, {
  dim: 384,
  cacheSize: 512,
  batchWaitMs: 1,
});

setEmbedder(onnxEmbedder);

const memoryStore = new native.PersistentMemoryStore(path.join(DATA_DIR, "memory.db"), 384);

const semanticCache = new native.SemanticCache(384);

const hybridRetriever = new native.HybridRetriever(semanticCache, {
  dimension: 384,
  denseWeight: 0.3,
});

const symbolSemanticCache = new native.SemanticCache(384);
const symbolRetriever = new native.HybridRetriever(symbolSemanticCache, {
  dimension: 384,
  denseWeight: 0.7,
});

// Prevent GC of symbolSemanticCache — C++ HybridRetriever holds a raw pointer
symbolRetriever._keepAliveCache = symbolSemanticCache;

const memoryHandler = new MemoryHandler(memoryStore, hybridRetriever, {
  maxTokens: 1024,
  maxEntries: 10,
  minScore: 0.3,
});

console.log("[Memory] PersistentMemoryStore ready");

// CF-P3: Readiness state exposed via /healthz so the CLI can health-gate
// `cf wrap` and show live indexing progress instead of a blind spinner.
const readiness = {
  status: "starting", // starting → indexing → ok
  progress: { current: 0, total: 0 },
  workspace: null,
  indexedFiles: 0,
  startedAt: Date.now(),
  version: "1.0.0",
};

// ─────────────────────────────────────────────
// Async startup
// ─────────────────────────────────────────────
// Note: server.listen() is called inside this IIFE after several awaits.
// By the time any await resolves, module evaluation is complete and
// `server` (defined below) is available. This ordering is intentional.
(async () => {
  // Yield to allow module evaluation to complete so `server` (defined below) is initialized
  await new Promise((resolve) => setImmediate(resolve));

  const workspacePath = process.env.CF_WORKSPACE_PATH || process.cwd();
  readiness.workspace = workspacePath;

  // CF-P6: Listen BEFORE indexing so /healthz is reachable during startup —
  // the CLI polls it to show live indexing progress. readiness.status gates
  // actual traffic: the CLI does not hand the agent over until status === "ok".
  // PORT=0 lets the OS pick a free port; the CLI reads it from CF_LISTENING.
  const PORT = parseInt(process.env.CF_PORT || process.env.PORT || "3000", 10);
  await new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`CF_LISTENING port=${server.address().port} pid=${process.pid}`);
      resolve();
    });
  });

  await onnxEmbedder.embed("warmup");
  console.log("[Embedder] Ready");
  console.log("[Embedder] Stats:", onnxEmbedder.getStats());

  setSymbolEmbedder(onnxEmbedder, symbolRetriever);

  readiness.status = "indexing";
  try {
    await indexWorkspace(workspacePath, {
      force: true,
      onProgress: ({ current, total, file }) => {
        readiness.progress = { current, total };
        if (current % 50 === 0) {
          console.log(`[GraphMapper] Progress: ${current}/${total} — ${file}`);
        }
      },
    });
    readiness.indexedFiles = readiness.progress.total || readiness.progress.current;
    const watcher = watchWorkspace(workspacePath);
    process.on("SIGINT", () => watcher.stop());
  } catch (err) {
    console.error(`[GraphMapper] ❌ Failed to index workspace: ${err.message}`);
  }

  await initPlanner(onnxEmbedder, semanticCache);

  const actualPort = server.address().port;
  readiness.status = "ok";
  console.log(
    `ContextForge Proxy routing engine active on port ${actualPort} [Provider: ${providerName}]`
  );
  // CF-P4: Machine-readable readiness line — belt-and-braces alongside /healthz.
  console.log(`CF_READY port=${actualPort} pid=${process.pid}`);
})();

// ─────────────────────────────────────────────
// Embedding worker
// ─────────────────────────────────────────────

const workerPath = path.join(__dirname, "workers", "embeddingWorker.js");
global.embeddingWorker = new Worker(workerPath, {
  execArgv: ["--experimental-vm-modules"],
});

global.embeddingWorker.on("error", (err) =>
  console.error(`\n[Background Thread] Fatal Error: ${err.message}`)
);

global.embeddingWorker.on("exit", (code) => {
  if (code !== 0) {
    console.error(`\n[Background Thread] Worker exited (code ${code}). RAG disabled.`);
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
    res.write(`event: snapshot\ndata: ${JSON.stringify(statsEmitter.getSnapshot("initial"))}\n\n`);

    // SV-8 FIX: Guard res.write — broken connections throw synchronously.
    // Without the guard, a write error crashes the listener without removing
    // it from statsEmitter, causing subsequent snapshots to also error.
    const listener = (snap) => {
      try {
        res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      } catch {
        // Connection broken — remove listener to prevent repeated errors
        statsEmitter.off("snapshot", listener);
      }
    };
    statsEmitter.on("snapshot", listener);
    req.on("close", () => statsEmitter.off("snapshot", listener));
    return;
  }

  if (req.url === "/healthz" && req.method === "GET") {
    // CF-P3: Rich health payload — powers `cf wrap` health-gate, `cf status`,
    // and proxy-reuse detection (same workspace? same version?).
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: readiness.status,
        provider: providerName,
        workspace: readiness.workspace,
        progress: readiness.progress,
        indexedFiles: readiness.indexedFiles,
        uptimeMs: Date.now() - readiness.startedAt,
        pid: process.pid,
        version: readiness.version,
      })
    );
  }

  // CF-P8: MCP tool definitions in MCP shape. The stdio bridge fetches this
  // at startup instead of importing graphTools/patchTools directly — those
  // imports transitively load tree-sitter + graphDb into the bridge process.
  if (req.url === "/v1/mcp/tools" && req.method === "GET") {
    const adapt = (def) =>
      def?.function
        ? {
            name: def.function.name,
            description: def.function.description || "",
            inputSchema: def.function.parameters || { type: "object", properties: {} },
          }
        : null;
    const tools = [
      adapt(getGraphToolDefinition()),
      adapt(getPatchToolDefinition()),
      adapt(getReadFileChunkToolDefinition()),
    ].filter(Boolean);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ tools }));
  }

  // CF-P7: One-shot JSON stats — used by `cf status`, `cf stats`, and the
  // end-of-session savings summary in `cf wrap`. The SSE stream at
  // /v1/stats/stream stays for the dashboard; this is the scriptable variant.
  if (req.url === "/v1/stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    try {
      return res.end(JSON.stringify(statsEmitter.getSnapshot("oneshot")));
    } catch (err) {
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // CF-P9: Savings snapshot without the history array (can reach ~500KB).
  // `cf wrap` diffs lifetime counters at session start/end for its summary.
  if (req.url === "/v1/savings" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    try {
      const snap = savingsTracker.snapshot();
      const { history, ...rest } = snap;
      return res.end(JSON.stringify({ ...rest, history_points: history?.length ?? 0 }));
    } catch (err) {
      return res.end(JSON.stringify({ error: err.message }));
    }
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
        res.end(JSON.stringify({ success: true, message: `Invalidated ${id}` }));
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
      // CF-P10: clearAll() wipes the ENTIRE SemanticCache — including the
      // planner intent anchors initPlanner seeded into the same instance.
      // Without re-seeding, the planner's semantic fallback silently
      // returns null for the rest of the session. Fire-and-forget: anchor
      // phrases are EmbedCache hits, so this completes in ~100ms.
      initPlanner(onnxEmbedder, semanticCache).catch((err) =>
        console.warn(`[Cache Reset] Planner re-seed failed: ${err.message}`)
      );
      console.log("\n[Cache Reset] ☢️ Nuclear reset triggered (planner anchors re-seeding).");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: true, message: "Entire cache has been reset." }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Failed to reset cache", details: e.message }));
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
      const content = fetchVaultTextConcatenated(vaultId) || fetchFromVault(vaultId);
      if (!content) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Vault not found", vault_id: vaultId }));
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
        })
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Vault read failed", details: err.message }));
    }
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Method Not Allowed" }));
  }

  const ALLOWED_POST_ROUTES = [
    "/v1/chat/completions",
    "/v1/messages",
    "/v1beta/models/",
    "/count_tokens",
    "/v1/mcp/tool",
  ];
  const isAllowed = ALLOWED_POST_ROUTES.some((route) => req.url.includes(route));

  // CF-P6: Server listens before indexing completes (so /healthz can report
  // progress). Reject inference traffic until fully ready — 503 with
  // Retry-After lets well-behaved clients back off instead of failing hard.
  if (isAllowed && readiness.status !== "ok") {
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "2" });
    return res.end(
      JSON.stringify({
        error: "ContextForge is still starting",
        status: readiness.status,
        progress: readiness.progress,
      })
    );
  }
  if (!isAllowed) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Not Found" }));
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
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: "Payload Too Large" }));
      req.unpipe();
      req.resume();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (destroyed) return;

    // SV-3 FIX: Wrap entire async handler in try/catch.
    // Without this, any uncaught throw (planPipeline crash, countTokens on
    // malformed payload, etc.) produces UnhandledPromiseRejection and leaves
    // the client hanging indefinitely with no response or error.
    try {
      await handleRequest(req, res, chunks);
    } catch (unexpectedErr) {
      console.error("[Server] ❌ Unhandled pipeline error:", unexpectedErr.message);
      console.error(unexpectedErr.stack);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Internal Server Error",
            details: unexpectedErr.message,
          })
        );
      }
    }
  });

  req.on("error", (err) => console.error("Ingress Socket Error:", err.message));
});

// ─────────────────────────────────────────────
// Tool Policy — runs on EVERY request before planner.
// Must be outside the planner block so it applies to
// TOOL_FOLLOWUP turns (bypass: true) as well as turn 1.
// ─────────────────────────────────────────────
function applyToolPolicy(payload) {
  if (process.env.CF_NUDGE_TOOLS !== "1") return payload;
  if (!Array.isArray(payload.tools)) return payload;

  const strippedTools = new Set(["Edit", "Read", "Update", "NotebookEdit"]);

  const before = payload.tools.length;
  payload.tools = payload.tools.filter(
    (t) => !strippedTools.has(t.name) && !strippedTools.has(t.function?.name)
  );
  const after = payload.tools.length;

  if (before !== after) {
    // SM-10 FIX: Log actual stripped tool names not hardcoded "Edit"
    const stripped = [...strippedTools].join(", ");
    console.log(`[Tool Policy] ✂️ Stripped ${before - after} tool(s): ${stripped}`);
  }

  return payload;
}

// ─────────────────────────────────────────────
// Request handler — extracted from inline async
// to make the top-level try/catch clean and to
// allow the function to be unit-tested in isolation.
// ─────────────────────────────────────────────

async function handleRequest(req, res, chunks) {
  const startTime = performance.now();
  const timer = new StageTimer();

  // ── Parse body ──
  let payload;
  let _rawPayloadForDebug = null;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    if (process.env.CF_DEBUG_TRANSLATION === "1") {
      _rawPayloadForDebug = JSON.parse(JSON.stringify(payload));
    }
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

  // ── MCP Tool Execution ──
  // SV-4 FIX: Static imports used instead of dynamic import() per request.
  // executeGraphQuery, executeReadFileChunk, executePatchToolCall are now
  // imported at module top — dynamic import() added Promise overhead for
  // modules that were already in the module cache.
  if (req.url.includes("/v1/mcp/tool")) {
    try {
      const { _mcp_tool, _mcp_args } = payload;
      let content;

      if (_mcp_tool === "contextforge_query_graph") {
        content = await executeGraphQuery(_mcp_args.query_type, _mcp_args.target, _mcp_args);
      } else if (_mcp_tool === "contextforge_patch_ast") {
        content = await executePatchToolCall(JSON.stringify(_mcp_args), semanticCache);
      } else if (_mcp_tool === "read_file_chunk") {
        content = executeReadFileChunk(
          _mcp_args.file_path,
          _mcp_args.start_line,
          _mcp_args.end_line
        );
      } else if (_mcp_tool === "contextforge_retrieve") {
        // ✅ Issue 1 FIX: Try chunked retrieval first, fall back to direct
        // vault lookup. saveToVault() writes to prune_vault (direct text),
        // while saveChunksToVault() writes to vault_chunks.
        // fetchVaultTextConcatenated returns "" (not null) when no chunks
        // exist — so an empty string means "try direct lookup", not "not found".
        let vaultContent = fetchVaultTextConcatenated(_mcp_args.vault_id);
        if (!vaultContent) {
          vaultContent = fetchFromVault(_mcp_args.vault_id);
        }
        if (!vaultContent) {
          content = JSON.stringify({
            error: "Vault not found",
            message: `Vault '${_mcp_args.vault_id}' is missing or expired.`,
          });
        } else {
          content = vaultContent;
        }
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: `Unknown _mcp_tool: ${_mcp_tool}` }));
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ content }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ content: JSON.stringify({ error: err.message }) }));
    }
  }

  // ── Detect client format + normalize to OpenAI internal format ──
  const { adapter: clientAdapter } = detectAdapter(req.url, req.headers);
  const { payload: normalizedPayload } = clientAdapter.toInternal(payload, req.headers);
  payload = normalizedPayload;

  // ✅ FIX: Apply tool policy before planner — runs on every turn including
  // TOOL_FOLLOWUP turns where bypass:true would otherwise skip stripping.
  payload = applyToolPolicy(payload);

  const isAnthropic = clientAdapter.name === "anthropic";
  const clientModel = payload.model || "unknown";

  // ── Parse per-request retry budget override ──
  const maxRetriesHeader = req.headers["x-cf-max-retries"];
  const parsedMaxRetries = maxRetriesHeader ? parseInt(maxRetriesHeader, 10) : NaN;
  const maxRetries =
    Number.isInteger(parsedMaxRetries) && parsedMaxRetries >= 0 ? parsedMaxRetries : undefined;

  const mockUpstreamPort = req.headers["x-cf-mock-port"]
    ? parseInt(req.headers["x-cf-mock-port"], 10)
    : null;

  if (clientAdapter.name === "gemini") {
    payload = extractGeminiInlineContent(payload);
  }

  // ── TRUE BASELINE ──
  // SV-9 FIX: Only two countTokens calls on critical path (baseline + final).
  // The intermediate afterAlwaysOnTokens and baselineTokens calls were only
  // used in commented-out log lines and for ccrBaseline. ccrBaseline now
  // uses trueBaselineTokens as a conservative approximation.
  const trueBaselineTokens = countTokens(payload);

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
    mockUpstreamPort,
    trueBaselineTokens,
  });

  // ── PASSTHROUGH MODE ──
  if (process.env.CF_MODE === "passthrough" && req.headers["x-cf-dry-run"] !== "true") {
    const passthroughMetrics = await executeUpstreamRequest(payload);
    const passthroughWireTokens = passthroughMetrics?.accumulatedInputTokens ?? trueBaselineTokens;
    const passthroughGhostRetries = passthroughMetrics?.ghostRetries ?? 0;
    const passthroughCacheRead = passthroughMetrics?.accumulatedCacheReadTokens ?? 0;
    const passthroughLatencyMs = performance.now() - startTime;

    savingsTracker.recordRequest({
      baselineTokens: trueBaselineTokens,
      wireTokens: passthroughWireTokens,
      tokensSaved: trueBaselineTokens - passthroughWireTokens,
      ghostRetries: passthroughGhostRetries,
      cacheReadTokens: passthroughCacheRead,
    });
    statsEmitter.recordRequest({
      baselineTokens: trueBaselineTokens,
      finalTokens: passthroughWireTokens,
      pipelineLatency: 0,
      upstreamLatency: passthroughLatencyMs,
    });

    console.log(`[Metrics] Total E2E Latency: ${passthroughLatencyMs.toFixed(2)}ms`);
    if (passthroughGhostRetries > 0) {
      console.log(
        `[Metrics] Background Hops:    ${passthroughGhostRetries} extra ` +
          `(${passthroughGhostRetries + 1} total LLM calls)`
      );
      console.log(`[Metrics] Total Wire Tokens:  ${passthroughWireTokens}`);
    }
    return;
  }

  // ── Always-on stages ──
  timer.time(STAGES.DEDUPLICATE, () => {
    payload = injectContextForgeRule(payload);
    payload = deduplicateSystemMessages(payload);
    if (payload._cf_sysPromptTokensSaved) {
      timer.recordTokenSavings(STAGES.DEDUPLICATE, payload._cf_sysPromptTokensSaved);
      delete payload._cf_sysPromptTokensSaved;
    }
  });

  timer.time(STAGES.HISTORY_PRUNE, () => {
    payload = pruneStaleToolResults(payload);
    if (payload._cf_historyPrunedTokens) {
      timer.recordTokenSavings(STAGES.HISTORY_PRUNE, payload._cf_historyPrunedTokens);
      delete payload._cf_historyPrunedTokens;
    }
  });

  const hasPriorTools = detectRecentToolActivity(payload.messages);

  let plan;
  await timer.timeAsync(STAGES.GRAPH_INJECT, async () => {
    const originResult = detectMessageOrigin(payload.messages);
    console.log(`[Planner] Origin: ${originResult.origin} | Reason: ${originResult.reason}`);

    if (!requiresRepositoryWork(originResult.origin)) {
      plan = {
        capabilities: new Set(),
        intent: originResult.origin,
        method: "origin_detection",
        bypass: true,
      };
      return;
    }

    // SV-1 FIX: planPipeline runs every turn — no module-level cache.
    plan = await planPipeline(
      payload,
      { hasPriorTools, trueBaselineTokens, originHint: originResult.origin },
      onnxEmbedder
    );
  });

  // ── GATE: Compression decision ──
  const decision = CompressionDecision.decide({
    headers: req.headers,
    optimize: getOptimizeFlag(),
    messages: payload.messages,
    payload,
    precomputedTokens: trueBaselineTokens,
  });

  if (!decision.shouldCompress && req.headers["x-cf-dry-run"] !== "true") {
    const passthroughMetrics = await executeUpstreamRequest(payload);
    const passthroughWireTokens =
      passthroughMetrics?.accumulatedInputTokens ?? countTokens(payload);
    const passthroughGhostRetries = passthroughMetrics?.ghostRetries ?? 0;
    const passthroughCacheRead = passthroughMetrics?.accumulatedCacheReadTokens ?? 0;
    const passthroughLatencyMs = performance.now() - startTime;

    savingsTracker.recordRequest({
      baselineTokens: trueBaselineTokens,
      wireTokens: passthroughWireTokens,
      tokensSaved: trueBaselineTokens - passthroughWireTokens,
      ghostRetries: passthroughGhostRetries,
      cacheReadTokens: passthroughCacheRead,
    });
    statsEmitter.recordRequest({
      baselineTokens: trueBaselineTokens,
      finalTokens: passthroughWireTokens,
      pipelineLatency: 0,
      upstreamLatency: passthroughLatencyMs,
    });
    return;
  }

  // ── COMPRESSION PIPELINE ──
  const prePipelinePayloadStr = JSON.stringify(payload);
  const policy = getPolicyForModel(payload.model || "");
  Object.defineProperty(payload, "__policy", {
    value: policy,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  // SV-5 FIX: Added [CF_COMPRESSED_FILE guard to prevent AST-compressed
  // messages from triggering compression stages a second time if
  // _compressedVaultId was stripped during message reconstruction.
  const hasCompressibleContent = payload.messages?.some(
    (m) =>
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.length > 800 &&
      !m._cf_vaulted &&
      !m._dedupVaultId &&
      !m._cf_deduped &&
      !m._compressedVaultId &&
      !m.content.includes("[CF_VAULT:") &&
      !m.content.includes("[CF_COMPRESSED_FILE") // SV-5 FIX
  );

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

  // 3. Tag Tool Results
  if (hasCompressibleContent) {
    await timer.timeAsync(STAGES.TAG, async () => {
      payload = await tagToolResults(payload);
    });
  }

  // 4. Semantic Dedup
  if (hasCompressibleContent) {
    await timer.timeAsync(STAGES.SEMANTIC_DEDUP, async () => {
      payload = await applySemanticDedup(payload);
    });
  }

  // 5. AST Compress Code
  if (hasCompressibleContent) {
    await timer.timeAsync(STAGES.CODE_COMPRESS, async () => {
      payload = await compressCodeToolResults(payload);
    });
  }

  // 6. Fat Catch / Vault Intercept
  if (hasCompressibleContent) {
    timer.time(STAGES.VAULT_INTERCEPT, () => {
      payload = interceptAndVaultMassiveToolResults(payload, policy.singleMsgVaultThreshold);
    });
  }

  // 7. Anthropic-specific field stripping
  if (isAnthropic) {
    timer.time(STAGES.STRIP_ANTHROPIC, () => {
      payload = stripAnthropicSpecificFields(payload);
    });
  }

  // 8. CCR Pipeline
  // SV-9 FIX: ccrBaseline uses trueBaselineTokens instead of a separate
  // countTokens() call. The Infinity override for vault-containing payloads
  // already handles the main correctness case.
  timer.time(STAGES.CCR_PIPELINE, () => {
    if (process.env.CF_CCR_ENABLED === "false") return;

    let ccrBaseline = countTokens(payload); // Use current payload size for accurate CCR ratios

    const hasVault = payload.messages?.some((m) => {
      if (typeof m.content === "string" && m.content.includes("[CF_VAULT:")) return true;
      if (Array.isArray(m.content)) {
        return m.content.some(
          (b) => typeof b.content === "string" && b.content.includes("[CF_VAULT:")
        );
      }
      return false;
    });

    if (hasVault) ccrBaseline = Infinity;

    payload = applyCCRPipeline(payload, ccrBaseline);
  });

  // 9. Minimize Tool Schemas
  timer.time(STAGES.MINIMIZE_TOOLS, () => {
    payload = minimizeToolSchemas(payload);
    if (payload._cf_minimizeTokensSaved) {
      timer.recordTokenSavings(STAGES.MINIMIZE_TOOLS, payload._cf_minimizeTokensSaved);
      delete payload._cf_minimizeTokensSaved;
    }
  });

  // 10. Inject Memory Context
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
      const ctx = await memoryHandler.searchAndFormatContext(userId, payload.messages, workspace);
      if (ctx) {
        payload.messages = memoryHandler.appendContextToMessages(payload.messages, ctx);
        console.log(`[Memory] Injected ${ctx.length} chars for user=${userId}`);
      }
    }
  });

  // ── Translation debug capture ──
  if (process.env.CF_DEBUG_TRANSLATION === "1") {
    debugTranslation({
      rawAnthropicPayload: _rawPayloadForDebug,
      translatedOpenAIPayload: payload,
      clientAdapterName: clientAdapter.name,
      originResult: plan ? { origin: plan.intent, method: plan.method, bypass: plan.bypass } : null,
      planResult: plan,
    });
  }

  const pipelineLatencyMs = performance.now() - startTime;
  // SV-9 FIX: Only two countTokens calls total (trueBaselineTokens above + finalTokens here)
  const finalTokens = countTokens(payload);
  const totalSaved = trueBaselineTokens - finalTokens;
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
      })
    );
  }

  // ── Mutation detection ──
  const { isMutation, mutatedFile } = detectMutation(prePipelinePayloadStr);
  if (isMutation && mutatedFile) {
    const newHash = hashFile(mutatedFile);
    const result = invalidateByFile(mutatedFile, newHash, semanticCache);
    if (result.deletedIds.length > 0) {
      console.log(
        `\n[State Monitor] 🚨 Mutation on '${mutatedFile}'. ` +
          `Invalidated ${result.deletedIds.length} entries.`
      );
    }
  }

  // ── Expose metrics via HTTP headers ──
  res.setHeader("x-cf-tokens-before", trueBaselineTokens);
  res.setHeader("x-cf-tokens-after", finalTokens);
  res.setHeader("x-cf-tokens-saved", totalSaved);
  res.setHeader("x-cf-pipeline-ms", pipelineLatencyMs.toFixed(2));
  res.setHeader(
    "x-cf-compression-ratio",
    trueBaselineTokens > 0 ? parseFloat(((totalSaved / trueBaselineTokens) * 100).toFixed(1)) : 0
  );

  const upstreamMetrics = await executeUpstreamRequest(payload);
  const totalLatencyMs = performance.now() - startTime;
  const wireTokens = upstreamMetrics?.accumulatedInputTokens ?? finalTokens;
  const ghostRetries = upstreamMetrics?.ghostRetries ?? 0;
  const cacheReadTokens = upstreamMetrics?.accumulatedCacheReadTokens ?? 0;

  savingsTracker.recordRequest({
    baselineTokens: trueBaselineTokens,
    wireTokens: wireTokens,
    tokensSaved: trueBaselineTokens - wireTokens,
    ghostRetries: ghostRetries,
    cacheReadTokens: cacheReadTokens,
  });
  statsEmitter.recordRequest({
    baselineTokens: trueBaselineTokens,
    finalTokens: wireTokens,
    pipelineLatency: pipelineLatencyMs,
    upstreamLatency: totalLatencyMs - pipelineLatencyMs,
  });

  // ── Pipeline report ──
  console.log("\n=== ContextForge Pipeline Report ===");
  console.log(`[Metrics] True Baseline:      ${trueBaselineTokens}`);
  console.log(`[Metrics] After Always-On:    ${trueBaselineTokens}`); // approximation post SV-9
  console.log(`[Metrics] Final Tokens:       ${finalTokens}`);
  console.log(`[Metrics] Savings Breakdown:`);

  if (totalSaved < 0) {
    console.warn(`[Pipeline] ⚠️ Net-negative: pipeline inflated by ${-totalSaved} tokens`);
  }

  if (ghostRetries > 0) {
    console.log(
      `[Metrics] Background Hops:    ${ghostRetries} extra ` +
        `(${ghostRetries + 1} total LLM calls)`
    );
    console.log(`[Metrics] Total Wire Tokens:  ${wireTokens}`);
  }
  console.log(`[Metrics] Pipeline Latency:   ${pipelineLatencyMs.toFixed(2)}ms`);
  console.log(`[Metrics] Total E2E Latency:  ${totalLatencyMs.toFixed(2)}ms`);

  // SV-10 FIX: Removed empty console.log() — was printing a blank line
  // every request due to commented-out content inside the call.

  const tokenSavings = timer.tokenSummary();
  if (Object.keys(tokenSavings).length > 0) {
    console.log(`[Tokens]  Stage Savings:`);
    for (const [stage, saved] of Object.entries(tokenSavings)) {
      if (saved > 0) console.log(`[Tokens]    ${stage}: ↓${saved} tokens`);
    }
  }
}

// ─────────────────────────────────────────────
// Graceful shutdown
//
// SV-11 FIX: server.close() called before process.exit() to drain
// in-flight connections. 5s timeout forces exit if drain stalls.
// ─────────────────────────────────────────────

// CF-P5: SIGTERM added — `cf stop`, docker stop, and process managers send
// SIGTERM by default. Previously only SIGINT drained gracefully.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 Shutting down ContextForge Proxy (${signal})...`);

  if (global.embeddingWorker) global.embeddingWorker.terminate();

  const forceExit = setTimeout(() => {
    console.warn("[Server] Force exit after 5s shutdown timeout");
    if (savingsTracker?.getSummary) console.log("\n" + savingsTracker.getSummary());
    process.exit(0);
  }, 5000);

  // .unref() prevents the timeout from keeping the process alive
  // if all connections drain before 5s
  forceExit.unref();

  server.close(() => {
    if (savingsTracker?.getSummary) console.log("\n" + savingsTracker.getSummary());
    else console.log("\n[Stats] Session ended.");
    process.exit(0);
  });
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
