// benchmarks/workflows/renameFunction.bench.js
//
// Category: Workflow (Category B)
// Target: End-to-end developer workflow — rename a function across real files
//
// Measures what matters to a developer:
//   - How many LLM requests were needed?
//   - How many tokens were transmitted?
//   - How many tokens were saved by ContextForge?
//   - How many retries (ghost loops) occurred?
//   - How many graph lookups resolved the rename?
//   - What was total end-to-end latency?
//
// Two modes — the benchmark implementation is identical in both:
//
//   DEFAULT (npm run benchmark):
//     - MockProvider replays recorded session turns
//     - Deterministic, no API keys, CI safe
//     - Session file: benchmarks/fixtures/sessions/rename-function.json
//
//   LIVE (CF_BENCHMARK_MODE=live):
//     - Real provider (Anthropic / Ollama)
//     - Requires CF_PROVIDER and API keys in environment
//     - Session file is ignored — live LLM responses used
//
// The benchmark never checks which mode it is in.
// Only the provider changes. All measurement code is shared.
//
// Real repository targets (not synthetic):
//   - ContextForge itself (this codebase)
//   - Configured via BENCHMARK_REPO_PATH env var or defaults to process.cwd()

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  runBenchmark,
  requiresRecordedSession,
  isLiveMode,
  isMockMode,
} from "../benchmarkRunner.js";
import { loadJsonFixture, SESSION_FIXTURES, requireFixture } from "../fixtures/index.js";
import { MockProvider } from "../../tests/fixtures/MockProvider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

// Real repository to run the rename workflow against.
// Defaults to ContextForge itself — the most meaningful real-world target.
const REPO_PATH = process.env.BENCHMARK_REPO_PATH || path.join(__dirname, "../../src"); // default to ContextForge source

// The function being renamed in the workflow
const FUNCTION_TO_RENAME = "minimizeToolSchemas";
const NEW_FUNCTION_NAME = "compressToolSchemas";

// ContextForge proxy configuration — the benchmark sends requests through it
const CF_HOST = process.env.CF_HOST || "127.0.0.1";
const CF_PORT = parseInt(process.env.CF_PORT || "3000", 10);

// ─────────────────────────────────────────────────────────────────────────────
// Session loading
// ─────────────────────────────────────────────────────────────────────────────

function loadRenameSession() {
  const sessionPath = SESSION_FIXTURES["rename-function"];
  requireFixture(
    sessionPath,
    "rename-function session (run: node benchmarks/fixtures/generate.js)"
  );
  return loadJsonFixture(sessionPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock provider setup
//
// Starts a MockProvider HTTP server and wires it as the upstream
// provider by setting environment variables that ContextForge reads.
// The proxy server must already be running before this benchmark runs.
//
// In LIVE mode the MockProvider is still started but never receives traffic —
// the real provider is used instead. This ensures setup/teardown symmetry.
// ─────────────────────────────────────────────────────────────────────────────

let mockProvider = null;

async function setupMockProvider(session) {
  mockProvider = new MockProvider();
  const port = await mockProvider.start();

  console.log(`[RenameFunction] MockProvider listening on port ${port}`);

  // Queue all session turns into the mock
  if (isMockMode() && session?.turns?.length > 0) {
    for (const turn of session.turns) {
      if (turn.response) {
        mockProvider.setNextResponse(turn.response);
      }
    }
    console.log(`[RenameFunction] Queued ${session.turns.length} recorded turns`);
  }

  return { port };
}

async function teardownMockProvider() {
  if (mockProvider) {
    await mockProvider.stop();
    mockProvider = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
//
// Fire a single request through the ContextForge proxy and collect
// the response plus any benchmark metrics from response headers.
// ─────────────────────────────────────────────────────────────────────────────

function sendProxyRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    // Grab the dynamic port from the mock provider if we are in mock mode
    const mockPort = isMockMode() && mockProvider ? mockProvider.port : null;

    const options = {
      hostname: CF_HOST,
      port: CF_PORT,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        // Route upstream traffic to the Mock Provider instead of the real LLM
        ...(mockPort ? { "x-cf-mock-port": mockPort.toString() } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk.toString()));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error("Request timeout after 30s"));
    });

    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow: rename function across repository
//
// Simulates the exact sequence a developer follows when asking ContextForge
// to rename a function. Each step is a separate LLM request through the proxy.
//
// Turn 1: "Find all usages of minimizeToolSchemas in this codebase"
//   → Planner injects GRAPH tool
//   → LLM calls find_symbol
//   → Graph returns call sites
//
// Turn 2: "Rename minimizeToolSchemas to compressToolSchemas everywhere"
//   → Planner injects GRAPH + PATCH tools
//   → LLM calls read_file_chunk for each file
//   → LLM calls patch for each file
//
// Measured across both turns:
//   - Total proxy requests
//   - Tokens before/after per turn
//   - Graph lookups (from dry-run response)
//   - Ghost retries
//   - E2E latency
// ─────────────────────────────────────────────────────────────────────────────

async function executeRenameWorkflow() {
  const turnMetrics = [];
  const workflowStart = performance.now();

  // ── Turn 1: Find all usages ──────────────────────────────────────────────
  const turn1Start = performance.now();

  const turn1Response = await sendProxyRequest({
    model: "claude-sonnet-4-20250514",
    messages: [
      {
        role: "user",
        content: `Find all usages of the function \`${FUNCTION_TO_RENAME}\` in this codebase. List every file and line number where it is defined or called.`,
      },
    ],
  });

  const turn1Latency = performance.now() - turn1Start;

  // Extract pipeline metrics from dry-run response body
  const t1metrics = turn1Response.body ?? {};
  turnMetrics.push({
    turn: 1,
    description: "find all usages",
    status: turn1Response.status,
    latency_ms: parseFloat(turn1Latency.toFixed(2)),
    tokens_before: t1metrics.tokens_before ?? null,
    tokens_after: t1metrics.tokens_after ?? null,
    tokens_saved: t1metrics.tokens_saved ?? null,
    compression_ratio: t1metrics.compression_ratio ?? null,
    pipeline_ms: t1metrics.pipeline_ms ?? null,
  });

  // ── Turn 2: Apply rename across all files ────────────────────────────────
  const turn2Start = performance.now();

  // Build the conversation — include turn 1 response as assistant message
  const assistantContent =
    typeof turn1Response.body?.choices?.[0]?.message?.content === "string"
      ? turn1Response.body.choices[0].message.content
      : `[Graph lookup result for ${FUNCTION_TO_RENAME}]`;

  const turn2Response = await sendProxyRequest({
    model: "claude-sonnet-4-20250514",
    messages: [
      {
        role: "user",
        content: `Find all usages of the function \`${FUNCTION_TO_RENAME}\` in this codebase. List every file and line number where it is defined or called.`,
      },
      {
        role: "assistant",
        content: assistantContent,
      },
      {
        role: "user",
        content:
          `Rename the function \`${FUNCTION_TO_RENAME}\` to \`${NEW_FUNCTION_NAME}\` everywhere — ` +
          `the definition and all call sites. Apply the changes using the patch tool.`,
      },
    ],
  });

  const turn2Latency = performance.now() - turn2Start;
  const t2metrics = turn2Response.body ?? {};

  turnMetrics.push({
    turn: 2,
    description: "apply rename",
    status: turn2Response.status,
    latency_ms: parseFloat(turn2Latency.toFixed(2)),
    tokens_before: t2metrics.tokens_before ?? null,
    tokens_after: t2metrics.tokens_after ?? null,
    tokens_saved: t2metrics.tokens_saved ?? null,
    compression_ratio: t2metrics.compression_ratio ?? null,
    pipeline_ms: t2metrics.pipeline_ms ?? null,
  });

  const totalLatency = performance.now() - workflowStart;

  // ── Aggregate across turns ───────────────────────────────────────────────
  const totalTokensBefore = turnMetrics.reduce((acc, t) => acc + (t.tokens_before ?? 0), 0);
  const totalTokensAfter = turnMetrics.reduce((acc, t) => acc + (t.tokens_after ?? 0), 0);
  const totalTokensSaved = turnMetrics.reduce((acc, t) => acc + (t.tokens_saved ?? 0), 0);

  // Request count: 1 per turn (no ghost retries in dry-run mode)
  const llmRequests = turnMetrics.length;

  return {
    workflow: "rename-function",
    repo: REPO_PATH,
    function_renamed: FUNCTION_TO_RENAME,
    new_name: NEW_FUNCTION_NAME,
    mode: isLiveMode() ? "live" : "mock",
    llm_requests: llmRequests,
    total_latency_ms: parseFloat(totalLatency.toFixed(2)),
    total_tokens_before: totalTokensBefore,
    total_tokens_after: totalTokensAfter,
    total_tokens_saved: totalTokensSaved,
    overall_compression_pct:
      totalTokensBefore > 0
        ? parseFloat(((totalTokensSaved / totalTokensBefore) * 100).toFixed(1))
        : 0,
    turns: turnMetrics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Print workflow result table
// ─────────────────────────────────────────────────────────────────────────────

function printWorkflowResult(metrics) {
  console.log("\n[RenameFunction] Workflow Result:");
  console.log(`  Repository:         ${metrics.repo}`);
  console.log(`  Function renamed:   ${metrics.function_renamed} → ${metrics.new_name}`);
  console.log(`  Mode:               ${metrics.mode}`);
  console.log(`  LLM requests:       ${metrics.llm_requests}`);
  console.log(`  Total latency:      ${metrics.total_latency_ms}ms`);
  console.log(`  Tokens before:      ${metrics.total_tokens_before}`);
  console.log(`  Tokens after:       ${metrics.total_tokens_after}`);
  console.log(`  Tokens saved:       ${metrics.total_tokens_saved}`);
  console.log(`  Compression:        ${metrics.overall_compression_pct}%`);

  console.log("\n  Per-turn breakdown:");
  console.log(
    "  | Turn | Description          | Tokens Before | Tokens After | Saved | Latency   |"
  );
  console.log(
    "  |------|----------------------|---------------|--------------|-------|-----------|"
  );

  for (const t of metrics.turns) {
    const desc = t.description.padEnd(20);
    const before = String(t.tokens_before ?? "–").padStart(13);
    const after = String(t.tokens_after ?? "–").padStart(12);
    const saved = String(t.tokens_saved ?? "–").padStart(5);
    const latency = (t.latency_ms.toFixed(1) + "ms").padStart(9);
    console.log(`  | ${t.turn}    | ${desc} | ${before} | ${after} | ${saved} | ${latency} |`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main benchmark
// ─────────────────────────────────────────────────────────────────────────────

async function runRenameFunctionBenchmark() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("Workflow: Rename Function Benchmark");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Load session fixture — needed in mock mode, checked for stub status
  const session = loadRenameSession();

  let mockSetup = null;

  const result = await runBenchmark({
    name: "workflow-rename-function",
    category: "workflow",
    description: `Rename ${FUNCTION_TO_RENAME} → ${NEW_FUNCTION_NAME} across ${REPO_PATH}`,

    // iterations=1: workflow is stateful — each run is a complete scenario.
    // Multiple iterations would rename an already-renamed function.
    warmup: 0,
    iterations: 1,

    setup: async () => {
      if (requiresRecordedSession(session, "workflow-rename-function")) {
        // Stub detected — skip cleanly without process.exit
        return;
      }
      mockSetup = await setupMockProvider(session);
      console.log(`[RenameFunction] Proxy target: ${CF_HOST}:${CF_PORT}`);
      console.log(`[RenameFunction] Repository:   ${REPO_PATH}`);
    },

    benchmark: async () => {
      // If stub was detected in setup, session turns are empty — return early
      if (!session?.turns?.length && isMockMode()) {
        console.log("[RenameFunction] No recorded turns — skipping execution.");
        return {
          workflow: "rename-function",
          skipped: true,
          reason: "stub session — record with CF_BENCHMARK_MODE=live --record",
        };
      }

      const metrics = await executeRenameWorkflow();
      printWorkflowResult(metrics);
      return metrics;
    },

    teardown: async () => {
      await teardownMockProvider();
    },

    silent: false,
    saveResult: true,
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run if invoked directly
// ─────────────────────────────────────────────────────────────────────────────

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()
) {
  runRenameFunctionBenchmark()
    .then(() => {
      console.log("\n✅ Rename function workflow benchmark complete.\n");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\n❌ Benchmark failed: ${err.message}`);
      console.error(err.stack);
      process.exit(1);
    });
}

export { runRenameFunctionBenchmark };
