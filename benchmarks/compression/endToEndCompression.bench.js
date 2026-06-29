// benchmarks/compression/endToEndCompression.bench.js
//
// Category: Engine (Category A)
// Target: Full compression pipeline (server.js stage order)
//
// Measures token savings and latency for each compression stage individually,
// then verifies: sum(stage savings) ≈ overall savings (accounting regression check).
//
// Stage order matches server.js exactly:
//   1.  minimizeToolSchemas          (always-on)
//   2.  deduplicateSystemMessages    (always-on)
//   3.  scrubToolResults             (hasCompressibleContent)
//   4.  pruneToolResults             (hasCompressibleContent)
//   5.  tagToolResults               (hasCompressibleContent, async)
//   6.  applySemanticDedup           (hasCompressibleContent, async)
//   7.  sliceJsonToolResults         (hasCompressibleContent)
//   8.  compressCodeToolResults      (hasCompressibleContent, async)
//   9.  interceptAndVaultMassiveToolResults (hasCompressibleContent)
//   10. applyCCRPipeline             (always)
//   11. alignCachePrefix             (always)
//
// Inputs:
//   - benchmarks/fixtures/payloads/40-tools.json      (tool schema minimizer)
//   - benchmarks/fixtures/payloads/large-tool-result.json (full pipeline)
//
// Outputs:
//   - Per-stage: tokens before, tokens after, delta, latency ms
//   - Overall: baseline tokens, final tokens, compression ratio
//   - Accounting check: sum(stage deltas) vs overall delta (warns if >5% drift)

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

import { runBenchmark, runSuite } from "../benchmarkRunner.js";
import { loadJsonFixture, PAYLOAD_FIXTURES, requireFixture } from "../fixtures/index.js";

// ── Compression pipeline imports (same as server.js) ──
import { countTokens } from "../../src/compression/compressionHelper.js";
import { minimizeToolSchemas } from "../../src/proxy/translator.js";
import { deduplicateSystemMessages } from "../../src/proxy/systemMessages.js";
import { scrubToolResults, tagToolResults } from "../../src/compression/toolScrubber.js";
import { pruneToolResults } from "../../src/compression/pruner.js";
import { applySemanticDedup } from "../../src/compression/semanticDedup.js";
import { sliceJsonToolResults } from "../../src/compression/jsonSlicer.js";
import { compressCodeToolResults } from "../../src/compression/astCompressor.js";
import { interceptAndVaultMassiveToolResults } from "../../src/compression/fatCatch.js";
import { applyCCRPipeline } from "../../src/ccr/index.js";
import { alignCachePrefix } from "../../src/compression/cacheAligner.js";
import { getPolicyForModel } from "../../src/compression/compressionPolicy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// hasCompressibleContent — exact condition from server.js
// ─────────────────────────────────────────────────────────────────────────────

function hasCompressibleContent(payload) {
  return (
    payload.messages?.some(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        m.content.length > 800 &&
        !m._cf_vaulted &&
        !m._dedupVaultId &&
        !m._cf_deduped &&
        !m._compressedVaultId &&
        !m.content.includes("[CF_VAULT:")
    ) ?? false
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage runner
//
// Wraps a single pipeline stage. Returns:
//   { tokensBefore, tokensAfter, delta, latencyMs, skipped }
//
// If the stage is guarded (e.g. hasCompressibleContent) and the guard is false,
// skipped=true and payload passes through unchanged.
// ─────────────────────────────────────────────────────────────────────────────

async function runStage(name, payload, fn, guard = true) {
  if (!guard) {
    return {
      stage: name,
      tokensBefore: countTokens(payload),
      tokensAfter: countTokens(payload),
      delta: 0,
      latencyMs: 0,
      skipped: true,
    };
  }

  const tokensBefore = countTokens(payload);
  const start = performance.now();
  const result = await Promise.resolve(fn(payload));
  const latencyMs = performance.now() - start;

  // fn may return a new payload object or mutate in place
  const nextPayload = result !== undefined && result !== null ? result : payload;
  const tokensAfter = countTokens(nextPayload);

  return {
    stage: name,
    tokensBefore,
    tokensAfter,
    delta: tokensBefore - tokensAfter, // positive = savings, negative = inflation
    latencyMs: parseFloat(latencyMs.toFixed(3)),
    skipped: false,
    payload: nextPayload,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounting check
//
// sum(stage savings) should approximately equal overall savings.
// Drift > 5% indicates a stage is consuming tokens without being measured,
// or a measurement point is in the wrong place.
// ─────────────────────────────────────────────────────────────────────────────

function checkAccounting(stageResults, overallSavings) {
  const sumStageDeltas = stageResults.reduce((acc, s) => acc + s.delta, 0);
  const drift = Math.abs(sumStageDeltas - overallSavings);
  const driftPct =
    overallSavings !== 0 ? (drift / Math.abs(overallSavings)) * 100 : 0;

  return {
    sumStageDeltas,
    overallSavings,
    drift,
    driftPct: parseFloat(driftPct.toFixed(1)),
    ok: driftPct <= 5.0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Print stage table
// ─────────────────────────────────────────────────────────────────────────────

function printStageTable(stageResults) {
  console.log("\n  Stage-by-stage breakdown:");
  console.log(
    "  | Stage                          | Before | After  | Saved  | Latency  | Status  |"
  );
  console.log(
    "  |--------------------------------|--------|--------|--------|----------|---------|"
  );

  for (const s of stageResults) {
    const name = s.stage.padEnd(30);
    const before = String(s.tokensBefore).padStart(6);
    const after = String(s.tokensAfter).padStart(6);
    const saved = (s.delta >= 0 ? "↓" + s.delta : "↑" + Math.abs(s.delta)).padStart(6);
    const latency = (s.latencyMs.toFixed(1) + "ms").padStart(8);
    const status = s.skipped ? "SKIPPED" : s.delta > 0 ? "✓" : s.delta < 0 ? "⚠ INFLAT" : "─";

    console.log(
      `  | ${name} | ${before} | ${after} | ${saved} | ${latency} | ${status.padEnd(7)} |`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark 1: Tool schema minimizer across 5/20/40/80 tools
// ─────────────────────────────────────────────────────────────────────────────

async function benchmarkToolSchemas() {
  const fixturePath = PAYLOAD_FIXTURES["40-tools"];
  requireFixture(fixturePath, "40-tools payload");
  const fixture40 = loadJsonFixture(fixturePath);

  const TOOL_COUNTS = [5, 20, 40, 80];
  const results = [];

  console.log("\n[ToolSchemas] Tool Schema Minimizer across tool counts:");
  console.log(
    "  | Tools | Before (tok) | After (tok) | Saved | Saved % | Latency  |"
  );
  console.log(
    "  |-------|--------------|-------------|-------|---------|----------|"
  );

  for (const count of TOOL_COUNTS) {
    // Slice or repeat tools to hit target count
    const baseTools = fixture40.tools ?? [];
    let tools = [];
    while (tools.length < count) {
      tools = tools.concat(baseTools);
    }
    tools = tools.slice(0, count);

    const payload = {
      ...fixture40,
      tools,
      messages: fixture40.messages ?? [{ role: "user", content: "test" }],
    };

    const stageResult = await runStage(
      `minimizeToolSchemas(${count})`,
      payload,
      (p) => minimizeToolSchemas(p)
    );

    const savedPct =
      stageResult.tokensBefore > 0
        ? ((stageResult.delta / stageResult.tokensBefore) * 100).toFixed(1)
        : "0.0";

    console.log(
      `  | ${String(count).padStart(5)} | ${String(stageResult.tokensBefore).padStart(12)} | ${String(stageResult.tokensAfter).padStart(11)} | ${String(stageResult.delta).padStart(5)} | ${(savedPct + "%").padStart(7)} | ${(stageResult.latencyMs.toFixed(2) + "ms").padStart(8)} |`
    );

    results.push({
      tool_count: count,
      tokens_before: stageResult.tokensBefore,
      tokens_after: stageResult.tokensAfter,
      tokens_saved: stageResult.delta,
      saved_pct: parseFloat(savedPct),
      latency_ms: stageResult.latencyMs,
    });
  }

  return { tool_schema_results: results };
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark 2: Full compression pipeline (large-tool-result fixture)
// ─────────────────────────────────────────────────────────────────────────────

async function benchmarkFullPipeline() {
  const fixturePath = PAYLOAD_FIXTURES["large-tool-result"];
  requireFixture(fixturePath, "large-tool-result payload");

  // Deep clone — pipeline mutates in place
  let payload = JSON.parse(JSON.stringify(loadJsonFixture(fixturePath)));

  const trueBaselineTokens = countTokens(payload);
  const compressible = hasCompressibleContent(payload);

  console.log(`\n[EndToEnd] Full pipeline on large-tool-result fixture`);
  console.log(`  True baseline:       ${trueBaselineTokens} tokens`);
  console.log(`  Compressible stages: ${compressible ? "ACTIVE" : "SKIPPED"}`);

  // Attach policy (required by stage 9 — interceptAndVaultMassiveToolResults)
  const policy = getPolicyForModel(payload.model || "");
  Object.defineProperty(payload, "__policy", {
    value: policy,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const stageResults = [];

  // ── Stage 1: minimizeToolSchemas ──
  let s = await runStage("minimizeToolSchemas", payload, (p) => {
    const out = minimizeToolSchemas(p);
    return out;
  });
  payload = s.payload ?? payload;
  stageResults.push(s);

  // ── Stage 2: deduplicateSystemMessages ──
  s = await runStage("deduplicateSystemMessages", payload, (p) => {
    const out = deduplicateSystemMessages(p);
    return out;
  });
  payload = s.payload ?? payload;
  stageResults.push(s);

  const afterAlwaysOnTokens = countTokens(payload);

  // ── Stage 3: scrubToolResults ──
  s = await runStage(
    "scrubToolResults",
    payload,
    (p) => scrubToolResults(p),
    compressible
  );
  payload = s.payload ?? payload;
  stageResults.push(s);

  // ── Stage 4: pruneToolResults ──
  s = await runStage(
    "pruneToolResults",
    payload,
    (p) => pruneToolResults(p),
    compressible
  );
  payload = s.payload ?? payload;
  stageResults.push(s);

  // ── Stage 5: tagToolResults ──
  s = await runStage(
    "tagToolResults",
    payload,
    async (p) => await tagToolResults(p),
    compressible
  );
  payload = s.payload ?? payload;
  stageResults.push(s);

  // ── Stage 6: applySemanticDedup ──
  s = await runStage(
    "applySemanticDedup",
    payload,
    async (p) => await applySemanticDedup(p),
    compressible
  );
  payload = s.payload ?? payload;
  stageResults.push(s);

  // ── Stage 7: sliceJsonToolResults ──
  s = await runStage(
    "sliceJsonToolResults",
    payload,
    (p) => sliceJsonToolResults(p),
    compressible
  );
  payload = s.payload ?? payload;
  stageResults.push(s);

  // ── Stage 8: compressCodeToolResults ──
  s = await runStage(
    "compressCodeToolResults",
    payload,
    async (p) => await compressCodeToolResults(p),
    compressible
  );
  payload = s.payload ?? payload;
  stageResults.push(s);

  // ── Stage 9: interceptAndVaultMassiveToolResults ──
  s = await runStage(
    "interceptAndVault",
    payload,
    (p) =>
      interceptAndVaultMassiveToolResults(p, policy.singleMsgVaultThreshold),
    compressible
  );
  payload = s.payload ?? payload;
  stageResults.push(s);

  // ── Stage 10: applyCCRPipeline ──
  s = await runStage("applyCCRPipeline", payload, (p) => {
    const hasVault = p.messages?.some((m) => {
      if (typeof m.content === "string" && m.content.includes("[CF_VAULT:"))
        return true;
      if (Array.isArray(m.content))
        return m.content.some(
          (b) =>
            typeof b.content === "string" && b.content.includes("[CF_VAULT:")
        );
      return false;
    });
    const ccrBaseline = hasVault ? Infinity : afterAlwaysOnTokens;
    return applyCCRPipeline(p, ccrBaseline);
  });
  payload = s.payload ?? payload;
  stageResults.push(s);

  // ── Stage 11: alignCachePrefix ──
  s = await runStage("alignCachePrefix", payload, (p) =>
    alignCachePrefix(p, "openai")
  );
  payload = s.payload ?? payload;
  stageResults.push(s);

  // ── Final measurements ──
  const finalTokens = countTokens(payload);
  const overallSavings = trueBaselineTokens - finalTokens;
  const compressionRatio =
    trueBaselineTokens > 0
      ? parseFloat(((overallSavings / trueBaselineTokens) * 100).toFixed(1))
      : 0;

  const accounting = checkAccounting(stageResults, overallSavings);
  const totalPipelineLatency = stageResults.reduce(
    (acc, s) => acc + s.latencyMs,
    0
  );

  printStageTable(stageResults);

  console.log(`\n  Overall:`);
  console.log(`    Baseline tokens:   ${trueBaselineTokens}`);
  console.log(`    Final tokens:      ${finalTokens}`);
  console.log(`    Tokens saved:      ${overallSavings}`);
  console.log(`    Compression ratio: ${compressionRatio}%`);
  console.log(
    `    Pipeline latency:  ${totalPipelineLatency.toFixed(1)}ms`
  );

  console.log(`\n  Accounting check:`);
  console.log(`    Sum(stage deltas): ${accounting.sumStageDeltas}`);
  console.log(`    Overall savings:   ${accounting.overallSavings}`);
  console.log(`    Drift:             ${accounting.drift} tokens (${accounting.driftPct}%)`);

  if (!accounting.ok) {
    console.warn(
      `  ⚠️  Accounting drift ${accounting.driftPct}% exceeds 5% threshold — ` +
        `a pipeline stage may be saving tokens without being measured.`
    );
  } else {
    console.log(`    Status:            ✓ within 5% tolerance`);
  }

  return {
    baseline_tokens: trueBaselineTokens,
    final_tokens: finalTokens,
    tokens_saved: overallSavings,
    compression_ratio_pct: compressionRatio,
    pipeline_latency_ms: parseFloat(totalPipelineLatency.toFixed(1)),
    accounting_drift_pct: accounting.driftPct,
    accounting_ok: accounting.ok,
    compressible_stages_active: compressible,
    stages: stageResults.map((s) => ({
      stage: s.stage,
      tokens_before: s.tokensBefore,
      tokens_after: s.tokensAfter,
      delta: s.delta,
      latency_ms: s.latencyMs,
      skipped: s.skipped,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite entry point
// ─────────────────────────────────────────────────────────────────────────────

async function runEndToEndCompressionBenchmarks() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("Compression Benchmark Suite");
  console.log("═══════════════════════════════════════════════════════════");

  const results = await runSuite({
    name: "compression",
    bail: false,
    benchmarks: [
      {
        name: "compression-tool-schemas",
        category: "compression",
        description:
          "Tool schema minimizer token savings across 5/20/40/80 tools",
        warmup: 2,
        iterations: 10,
        benchmark: benchmarkToolSchemas,
        silent: false,
        saveResult: true,
      },
      {
        name: "compression-end-to-end",
        category: "compression",
        description:
          "Full 11-stage pipeline token savings and latency on large-tool-result fixture",
        warmup: 1,
        iterations: 5,
        benchmark: benchmarkFullPipeline,
        silent: false,
        saveResult: true,
      },
    ],
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run if invoked directly
// ─────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  runEndToEndCompressionBenchmarks()
    .then(() => {
      console.log("\n✅ Compression benchmarks complete.\n");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\n❌ Benchmark failed: ${err.message}`);
      console.error(err.stack);
      process.exit(1);
    });
}

export { runEndToEndCompressionBenchmarks };