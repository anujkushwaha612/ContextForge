// benchmarks/planner/capabilitySelection.bench.js
//
// Category: Engine (Category A)
// Target: src/proxy/requestPlanner.js
//
// Measures accuracy of the hybrid regex + semantic intent classifier.
//
// Ground truth: benchmarks/fixtures/prompts/labeled-100.json
//   - 100 prompts across 5 intents (EDIT, SEARCH, CHAT, DEBUG, EXPLAIN)
//   - Each labeled with expected capabilities
//
// Metrics:
//   - Overall accuracy %
//   - Per-intent precision/recall
//   - False positives (tools injected when bypass expected)
//   - False negatives (bypass when tools expected)
//   - Average classification latency
//
// Success criteria:
//   - Overall accuracy >= 90%
//   - No intent with precision < 75%
//   - Median latency < 10ms

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createRequire } from "module";

import { runBenchmark } from "../benchmarkRunner.js";
import { loadJsonFixture, PROMPT_FIXTURES } from "../fixtures/index.js";
import {
  CAPABILITIES,
  initPlanner,
  planPipeline,
} from "../../src/proxy/requestPlanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// Mock embedder and cache
//
// The planner needs these to seed semantic anchors. We use the real
// native modules so semantic classification behaves exactly as in production.
// ─────────────────────────────────────────────────────────────────────────────

const native = require("../../native/build/Release/contextforge_native.node");

let onnxEmbedder;
let semanticCache;
let plannerReady = false;

async function setupPlanner() {
  if (plannerReady) return;

  console.log("[CapabilitySelection] Initializing planner dependencies...");

  // Real ONNX embedder — same as production
  const modelPath = path.join(
    __dirname,
    "../../contextforge_models/all-MiniLM-L6-v2-int8.onnx"
  );
  const tokenizerPath = path.join(__dirname, "../../contextforge_models/tokenizer.json");

  onnxEmbedder = new native.OnnxEmbedder(modelPath, tokenizerPath, {
    dim: 384,
    cacheSize: 128, // smaller cache for benchmarking
    batchWaitMs: 1,
  });

  // Real SemanticCache HNSW — same as production
  semanticCache = new native.SemanticCache(384);

  // Seed anchors into cache
  await initPlanner(onnxEmbedder, semanticCache);

  plannerReady = true;
  console.log("[CapabilitySelection] Planner ready.");
}

function teardownPlanner() {
  if (onnxEmbedder) {
    try {
      onnxEmbedder = null;
    } catch {}
  }
  semanticCache = null;
  plannerReady = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ground truth dataset
// ─────────────────────────────────────────────────────────────────────────────

function loadLabeledPrompts() {
  const datasetPath = PROMPT_FIXTURES["labeled-100"];
  const dataset = loadJsonFixture(datasetPath);

  if (!dataset.prompts || dataset.prompts.length === 0) {
    throw new Error(
      `Labeled prompt dataset is empty or malformed: ${datasetPath}`
    );
  }

  console.log(
    `[CapabilitySelection] Loaded ${dataset.prompts.length} labeled prompts`
  );
  console.log(
    `  Categories: ${Object.entries(dataset.categories)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  );

  return dataset.prompts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert expected capabilities from fixture format to a Set.
 * Fixture format: capabilities: ["GRAPH", "PATCH"]
 */
function parseExpectedCapabilities(labeledPrompt) {
  return new Set(labeledPrompt.capabilities ?? []);
}

/**
 * Build a minimal payload from a prompt string.
 * Planner only needs payload.messages to extract the last user message.
 */
function buildPayload(promptText) {
  return {
    model: "test-model",
    messages: [{ role: "user", content: promptText }],
  };
}

/**
 * Session state for planner.
 * hasPriorTools: false — we are testing fresh-session classification.
 * trueBaselineTokens: 0 — not used by planner logic.
 * originHint: null — no fast-path bypass.
 */
function buildSessionState() {
  return {
    hasPriorTools: false,
    trueBaselineTokens: 0,
    originHint: null,
  };
}

/**
 * Compare two capability sets.
 * Returns { match: boolean, falsePositives: Set, falseNegatives: Set }
 */
function compareCapabilities(expected, actual) {
  const falsePositives = new Set(
    [...actual].filter((cap) => !expected.has(cap))
  );
  const falseNegatives = new Set(
    [...expected].filter((cap) => !actual.has(cap))
  );
  const match = falsePositives.size === 0 && falseNegatives.size === 0;
  return { match, falsePositives, falseNegatives };
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark: Classify all labeled prompts and measure accuracy
// ─────────────────────────────────────────────────────────────────────────────

async function benchmarkCapabilitySelection() {
  const prompts = loadLabeledPrompts();
  const results = [];
  const timings = [];

  for (const labeled of prompts) {
    const payload = buildPayload(labeled.prompt);
    const sessionState = buildSessionState();

    const start = performance.now();
    const plan = await planPipeline(payload, sessionState, onnxEmbedder);
    const elapsed = performance.now() - start;

    timings.push(elapsed);

    const expectedCaps = parseExpectedCapabilities(labeled);
    const actualCaps = plan.capabilities;

    const comparison = compareCapabilities(expectedCaps, actualCaps);

    results.push({
      id: labeled.id,
      prompt: labeled.prompt,
      expected_intent: labeled.intent,
      actual_intent: plan.intent,
      expected_capabilities: [...expectedCaps],
      actual_capabilities: [...actualCaps],
      match: comparison.match,
      false_positives: [...comparison.falsePositives],
      false_negatives: [...comparison.falseNegatives],
      method: plan.method,
      latency_ms: elapsed,
      bypass_expected: labeled.bypass ?? expectedCaps.size === 0,
      bypass_actual: plan.bypass,
    });
  }

  // ── Compute metrics ──────────────────────────────────────────────────────

  const totalPrompts = results.length;
  const correctClassifications = results.filter((r) => r.match).length;
  const overallAccuracy = (correctClassifications / totalPrompts) * 100;

  // False positives: tools injected when none expected
  const falsePositivesCount = results.filter(
    (r) => r.bypass_expected && !r.bypass_actual
  ).length;

  // False negatives: no tools when some expected
  const falseNegativesCount = results.filter(
    (r) => !r.bypass_expected && r.bypass_actual
  ).length;

  const avgLatency = timings.reduce((a, b) => a + b, 0) / timings.length;
  const medianLatency = [...timings].sort((a, b) => a - b)[
    Math.floor(timings.length / 2)
  ];

  // Per-intent precision/recall
  const intentStats = {};
  const uniqueIntents = [...new Set(prompts.map((p) => p.intent))];

  for (const intent of uniqueIntents) {
    const subset = results.filter((r) => r.expected_intent === intent);
    const correct = subset.filter((r) => r.match).length;
    const precision = (correct / subset.length) * 100;

    // Recall: of all prompts classified as this intent, how many were correct?
    const classifiedAsIntent = results.filter(
      (r) => r.actual_intent === intent
    );
    const truePositives = classifiedAsIntent.filter(
      (r) => r.expected_intent === intent && r.match
    ).length;
    const recall =
      classifiedAsIntent.length > 0
        ? (truePositives / subset.length) * 100
        : 0;

    intentStats[intent] = {
      total: subset.length,
      correct,
      precision: precision.toFixed(1),
      recall: recall.toFixed(1),
    };
  }

  // Method breakdown
  const methodCounts = {};
  for (const r of results) {
    methodCounts[r.method] = (methodCounts[r.method] ?? 0) + 1;
  }

  // ── Print results ────────────────────────────────────────────────────────

  console.log("\n[CapabilitySelection] Classification Results:");
  console.log(`  Total prompts:          ${totalPrompts}`);
  console.log(
    `  Correct classifications: ${correctClassifications} (${overallAccuracy.toFixed(1)}%)`
  );
  console.log(`  False positives:        ${falsePositivesCount}`);
  console.log(`  False negatives:        ${falseNegativesCount}`);
  console.log(`  Median latency:         ${medianLatency.toFixed(2)}ms`);
  console.log(`  Average latency:        ${avgLatency.toFixed(2)}ms`);

  console.log("\n  Per-Intent Metrics:");
  console.log(
    "  | Intent   | Total | Correct | Precision | Recall |"
  );
  console.log(
    "  |----------|-------|---------|-----------|--------|"
  );
  for (const [intent, stats] of Object.entries(intentStats)) {
    console.log(
      `  | ${intent.padEnd(8)} | ${String(stats.total).padStart(5)} | ${String(stats.correct).padStart(7)} | ${String(stats.precision + "%").padStart(9)} | ${String(stats.recall + "%").padStart(6)} |`
    );
  }

  console.log("\n  Classification Methods:");
  for (const [method, count] of Object.entries(methodCounts)) {
    console.log(`    ${method.padEnd(20)} ${count}`);
  }

  // ── Success criteria ─────────────────────────────────────────────────────

  const meetsAccuracyThreshold = overallAccuracy >= 90.0;
  const allIntentsAbove75 = Object.values(intentStats).every(
    (s) => parseFloat(s.precision) >= 75.0
  );
  const medianLatencyOk = medianLatency < 10.0;

  const success = meetsAccuracyThreshold && allIntentsAbove75 && medianLatencyOk;

  if (!success) {
    console.log("\n  ❌ BENCHMARK FAILED:");
    if (!meetsAccuracyThreshold) {
      console.log(
        `     Overall accuracy ${overallAccuracy.toFixed(1)}% < 90% threshold`
      );
    }
    if (!allIntentsAbove75) {
      console.log(`     One or more intents have precision < 75%`);
    }
    if (!medianLatencyOk) {
      console.log(`     Median latency ${medianLatency.toFixed(2)}ms >= 10ms`);
    }
  } else {
    console.log("\n  ✅ All success criteria met.");
  }

  // ── Misclassifications report (top 5) ────────────────────────────────────

  const misclassified = results.filter((r) => !r.match);
  if (misclassified.length > 0) {
    console.log(`\n  Misclassifications (showing first 5 of ${misclassified.length}):`);
    for (const m of misclassified.slice(0, 5)) {
      console.log(`    • "${m.prompt.slice(0, 60)}"`);
      console.log(
        `      Expected: ${m.expected_intent} → [${m.expected_capabilities.join(", ") || "none"}]`
      );
      console.log(
        `      Got:      ${m.actual_intent} → [${m.actual_capabilities.join(", ") || "none"}] (${m.method})`
      );
    }
  }

  return {
    total_prompts: totalPrompts,
    correct: correctClassifications,
    accuracy_pct: parseFloat(overallAccuracy.toFixed(1)),
    false_positives: falsePositivesCount,
    false_negatives: falseNegativesCount,
    median_latency_ms: parseFloat(medianLatency.toFixed(2)),
    avg_latency_ms: parseFloat(avgLatency.toFixed(2)),
    intent_stats: intentStats,
    method_counts: methodCounts,
    success,
    meets_accuracy_threshold: meetsAccuracyThreshold,
    all_intents_above_75: allIntentsAbove75,
    median_latency_ok: medianLatencyOk,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Run benchmark
// ─────────────────────────────────────────────────────────────────────────────

async function runCapabilitySelectionBenchmark() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("Planner Capability Selection Benchmark");
  console.log("═══════════════════════════════════════════════════════════\n");

  const result = await runBenchmark({
    name: "planner-capability-selection",
    category: "planner",
    description: "Intent classification accuracy on 100 labeled prompts",
    warmup: 0, // dataset is large enough that warmup doesn't matter
    iterations: 1, // classification is deterministic (except for HNSW ties which are rare)
    setup: setupPlanner,
    teardown: teardownPlanner,
    benchmark: benchmarkCapabilitySelection,
    silent: false,
    saveResult: true,
  });

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("Benchmark Result");
  console.log("─────────────────────────────────────────────────────────────\n");

  if (result.failed) {
    console.log(`❌ Benchmark execution failed: ${result.error}`);
    process.exit(1);
  }

  const metrics = result.custom_metrics;

  if (!metrics.success) {
    console.log("❌ Capability selection accuracy below threshold.\n");
    console.log(`   Accuracy:        ${metrics.accuracy_pct}% (threshold: ≥90%)`);
    console.log(`   False Positives: ${metrics.false_positives}`);
    console.log(`   False Negatives: ${metrics.false_negatives}`);
    console.log(`   Median Latency:  ${metrics.median_latency_ms}ms (threshold: <10ms)`);
    console.log("\n   Run with CF_DEBUG_GRAPH=1 to see detailed classifications.\n");
    process.exit(1);
  } else {
    console.log("✅ Planner capability selection benchmark PASSED.\n");
    console.log(`   Accuracy:        ${metrics.accuracy_pct}%`);
    console.log(`   False Positives: ${metrics.false_positives}`);
    console.log(`   False Negatives: ${metrics.false_negatives}`);
    console.log(`   Median Latency:  ${metrics.median_latency_ms}ms\n`);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run if invoked directly
// ─────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  runCapabilitySelectionBenchmark()
    .then(() => {
      console.log("✅ Planner capability selection benchmark complete.\n");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\n❌ Benchmark failed: ${err.message}`);
      console.error(err.stack);
      process.exit(1);
    });
}

export { runCapabilitySelectionBenchmark };