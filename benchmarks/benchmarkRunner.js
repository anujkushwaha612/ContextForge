// benchmarks/benchmarkRunner.js
//
// ContextForge Benchmark Runner — the single reusable harness for all benchmarks.
//
// Design principles:
//   - Every benchmark calls runBenchmark() with the same interface
//   - Results are always written to benchmarks/results/ as JSON
//   - Statistics are always computed the same way (no per-benchmark math)
//   - Mock vs live provider is controlled by environment, not benchmark code
//   - The runner never knows what the benchmark measures — pure infrastructure
//
// Inspired by: SQLite's speedtest1.c, ripgrep's benchsuite, Redis's redis-benchmark

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const RESULTS_DIR = path.join(__dirname, "results");
const PROVIDER_MODE = process.env.CF_BENCHMARK_MODE || "mock"; // "mock" | "live"

// ─────────────────────────────────────────────────────────────────────────────
// System metadata
//
// FIX: Removed the broken async IIFE that used `await` inside a non-async
// arrow function. os is now a direct ESM import at the top of the file —
// no dynamic import, no createRequire fallback, no dead code.
//
// Captured once at startup — attached to every result file for reproducibility.
// ─────────────────────────────────────────────────────────────────────────────

function captureSystemMetadata() {
  let gitCommit = "unknown";
  let gitBranch = "unknown";

  try {
    gitCommit = execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim();
    gitBranch = execSync("git rev-parse --abbrev-ref HEAD", { stdio: "pipe" }).toString().trim();
  } catch {
    // Not a git repo or git not available — acceptable in CI containers
  }

  const cpuInfo = os.cpus();

  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu_model: cpuInfo[0]?.model ?? "unknown",
    cpu_cores: cpuInfo.length,
    ram_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    provider_mode: PROVIDER_MODE,
    git_commit: gitCommit,
    git_branch: gitBranch,
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Statistics
// All math is in one place — no benchmark file ever does its own statistics.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute full statistics from an array of millisecond timings.
 *
 * @param {number[]} samples - Raw timing samples in milliseconds
 * @returns {BenchmarkStats}
 */
function computeStats(samples) {
  if (samples.length === 0) {
    throw new Error("Cannot compute stats from empty samples array");
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;

  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / n;

  // Population variance and standard deviation
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);

  // Percentile — linear interpolation (matches numpy default)
  function percentile(p) {
    if (n === 1) return sorted[0];
    const index = (p / 100) * (n - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    const fraction = index - lower;
    return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
  }

  return {
    n,
    min_ms: round(sorted[0]),
    max_ms: round(sorted[n - 1]),
    mean_ms: round(mean),
    median_ms: round(percentile(50)),
    p75_ms: round(percentile(75)),
    p95_ms: round(percentile(95)),
    p99_ms: round(percentile(99)),
    stddev_ms: round(stddev),
    // Coefficient of variation — lower = more stable benchmark
    cv_pct: round((stddev / mean) * 100),
  };
}

/**
 * Compute throughput given a stats object and optional payload size.
 */
function computeThroughput(stats, opts = {}) {
  const { itemsPerIteration = 1 } = opts;
  const opsPerSec = round(1000 / stats.median_ms);
  const itemsPerSec = round(opsPerSec * itemsPerIteration);
  return { ops_per_sec: opsPerSec, items_per_sec: itemsPerSec };
}

function round(n, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result persistence
// ─────────────────────────────────────────────────────────────────────────────

function ensureResultsDir() {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

/**
 * Save a benchmark result to benchmarks/results/<name>-<timestamp>.json
 * and append a line to benchmarks/results/history.ndjson for trend analysis.
 *
 * history.ndjson uses newline-delimited JSON (not a JSON array) so that:
 *   - Appends are atomic single-line writes (no parse-modify-rewrite cycle)
 *   - The file is readable with grep/jq without loading the entire history
 *   - Concurrent benchmark runs cannot corrupt the file
 */
function saveResult(result) {
  ensureResultsDir();

  // Individual result — one file per run, never overwritten
  const safeName = result.benchmark.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(RESULTS_DIR, `${safeName}-${ts}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");

  // Append to history for trend analysis across commits
  const historyPath = path.join(RESULTS_DIR, "history.ndjson");
  fs.appendFileSync(
    historyPath,
    JSON.stringify({
      benchmark: result.benchmark,
      category: result.category,
      median_ms: result.stats?.median_ms ?? null,
      p95_ms: result.stats?.p95_ms ?? null,
      git_commit: result.system.git_commit,
      timestamp: result.system.timestamp,
    }) + "\n",
    "utf-8"
  );

  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal output
// ─────────────────────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function printResult(result) {
  const { benchmark, category, stats, throughput, custom_metrics, warnings } = result;

  console.log(`\n${BOLD}${CYAN}▶ ${benchmark}${RESET} ${DIM}[${category}]${RESET}`);
  console.log("─".repeat(60));

  // Core timing table
  const rows = [
    ["Iterations", `${stats.n}`],
    ["Min", `${stats.min_ms} ms`],
    ["Median", `${BOLD}${stats.median_ms} ms${RESET}`],
    ["Mean", `${stats.mean_ms} ms`],
    ["P95", `${stats.p95_ms} ms`],
    ["P99", `${stats.p99_ms} ms`],
    ["Max", `${stats.max_ms} ms`],
    ["StdDev", `${stats.stddev_ms} ms`],
    [
      "CV",
      `${stats.cv_pct}% ${
        stats.cv_pct > 10 ? YELLOW + "⚠ unstable" + RESET : GREEN + "✓ stable" + RESET
      }`,
    ],
  ];

  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(14)} ${value}`);
  }

  // Throughput (optional)
  if (throughput) {
    console.log(`  ${"─".repeat(40)}`);
    console.log(`  ${"Ops/sec".padEnd(14)} ${throughput.ops_per_sec}`);
    if (throughput.items_per_sec !== throughput.ops_per_sec) {
      console.log(`  ${"Items/sec".padEnd(14)} ${throughput.items_per_sec}`);
    }
  }

  // Custom metrics — domain-specific numbers (tokens saved, accuracy %, etc.)
  if (custom_metrics && Object.keys(custom_metrics).length > 0) {
    console.log(`  ${"─".repeat(40)}`);
    for (const [key, value] of Object.entries(custom_metrics)) {
      const label = key.replace(/_/g, " ");
      const display = label.charAt(0).toUpperCase() + label.slice(1);

      let formatted;
      if (value === null || value === undefined) {
        formatted = "–";
      } else if (Array.isArray(value)) {
        formatted = `[${value.length} items]`;
      } else if (typeof value === "object") {
        // Inline for small objects, skip for large ones
        const keys = Object.keys(value);
        if (keys.length <= 4) {
          formatted = keys.map((k) => `${k}=${value[k]}`).join(", ");
        } else {
          formatted = `{${keys.length} keys}`;
        }
      } else {
        formatted = String(value);
      }

      console.log(`  ${display.padEnd(22)} ${formatted}`);
    }
  }

  // Stability warnings
  if (warnings && warnings.length > 0) {
    console.log(`  ${"─".repeat(40)}`);
    for (const w of warnings) {
      console.log(`  ${YELLOW}⚠ ${w}${RESET}`);
    }
  }

  console.log();
}

function printSuiteHeader(suiteName) {
  console.log(`\n${BOLD}ContextForge Benchmark Suite${RESET}`);
  console.log(`Suite: ${CYAN}${suiteName}${RESET}`);
  console.log(`Mode:  ${PROVIDER_MODE === "live" ? GREEN + "LIVE" : DIM + "mock"}${RESET}`);
  console.log("═".repeat(60));
}

function printSuiteSummary(results) {
  console.log(`\n${BOLD}Summary${RESET}`);
  console.log("═".repeat(60));

  const passed = results.filter((r) => !r.failed);
  const failed = results.filter((r) => r.failed);

  for (const r of passed) {
    console.log(
      `  ${GREEN}✓${RESET} ${r.benchmark.padEnd(40)} ` +
        `${String(r.stats?.median_ms ?? "–").padStart(8)} ms  ` +
        `p95=${r.stats?.p95_ms ?? "–"} ms`
    );
  }

  for (const r of failed) {
    console.log(
      `  ${RED}✗${RESET} ${r.benchmark.padEnd(40)} ` + `${RED}FAILED: ${r.error}${RESET}`
    );
  }

  console.log(`\n  ${passed.length} passed, ${failed.length} failed, ` + `${results.length} total`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stability analysis
// Emits warnings when benchmark results are unreliable.
// ─────────────────────────────────────────────────────────────────────────────

function analyzeStability(stats, opts) {
  const warnings = [];

  if (stats.cv_pct > 15) {
    warnings.push(
      `High variance (CV=${stats.cv_pct}%). Results may be unreliable. ` +
        `Consider increasing iterations or isolating the benchmark process.`
    );
  }

  if (stats.median_ms < 0.01) {
    warnings.push(
      `Median < 0.01ms — benchmark may be measuring a no-op or cached result. ` +
        `Verify the benchmark body is actually executing.`
    );
  }

  if (opts.warmup === 0) {
    warnings.push(
      `No warmup iterations. First measured iteration may include ` +
        `JIT compilation and module initialization overhead.`
    );
  }

  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} BenchmarkOptions
 * @property {string}   name               - Human-readable benchmark name
 * @property {string}   [category]         - "micro" | "workflow" | "repository"
 * @property {string}   [description]      - What this benchmark measures
 * @property {number}   [warmup=5]         - Iterations to discard before measuring
 * @property {number}   [iterations=100]   - Measured iterations
 * @property {Function} benchmark          - async () => void | object
 * @property {Function} [setup]            - async () => void — runs once before warmup
 * @property {Function} [teardown]         - async () => void — runs once after all
 * @property {object}   [throughput]       - { itemsPerIteration: number }
 * @property {boolean}  [silent=false]     - Suppress terminal output
 * @property {boolean}  [saveResult=true]  - Write JSON to results/
 */

/**
 * Run a single benchmark and return the full result object.
 *
 * custom_metrics behavior:
 *   The benchmark function may return a plain object with domain-specific
 *   metrics (e.g. { tokens_saved: 18432, accuracy_pct: 97.4 }).
 *
 *   FIX: The runner now REPLACES custom_metrics on each iteration rather
 *   than merging. Merging accumulated stale keys when a benchmark
 *   conditionally returned different fields across iterations, making
 *   the final custom_metrics object a union of all iterations' keys.
 *   Replace semantics give the last iteration's values — which is correct
 *   because custom metrics (token counts, accuracy) are stable across
 *   iterations by design. If they vary, the benchmark should average them
 *   in its own body and return the averaged value.
 *
 * @param {BenchmarkOptions} opts
 * @returns {Promise<BenchmarkResult>}
 */
export async function runBenchmark(opts) {
  const {
    name,
    category = "micro",
    description = "",
    warmup = 5,
    iterations = 100,
    benchmark,
    setup,
    teardown,
    throughput: throughputOpts,
    silent = false,
    saveResult: shouldSave = true,
  } = opts;

  if (!name) throw new Error("runBenchmark: name is required");
  if (typeof benchmark !== "function") {
    throw new Error("runBenchmark: benchmark must be a function");
  }

  const system = captureSystemMetadata();

  let failed = false;
  let errorMessage = null;
  const samples = [];

  // FIX: replace not merge — last iteration's custom_metrics wins
  let lastCustomMetrics = {};

  try {
    // ── Setup ──
    if (setup) {
      await setup();
    }

    // ── Warmup ──
    if (!silent && warmup > 0) {
      process.stdout.write(`  Warming up (${warmup} iterations)...`);
    }
    for (let i = 0; i < warmup; i++) {
      await benchmark();
    }
    if (!silent && warmup > 0) {
      process.stdout.write(" done\n");
    }

    // ── Measured iterations ──
    if (!silent) {
      process.stdout.write(`  Running (${iterations} iterations)...`);
    }

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const result = await benchmark();
      const elapsed = performance.now() - start;

      samples.push(elapsed);

      // FIX: replace, not merge — avoids stale key accumulation
      if (result && typeof result === "object" && !Array.isArray(result)) {
        lastCustomMetrics = result;
      }
    }

    if (!silent) {
      process.stdout.write(" done\n");
    }

    // ── Teardown ──
    if (teardown) {
      await teardown();
    }
  } catch (err) {
    failed = true;
    errorMessage = err.message;
    console.error(`\n${RED}[BenchmarkRunner] ✗ ${name} failed: ${err.message}${RESET}`);
    if (process.env.CF_BENCHMARK_DEBUG === "1") {
      console.error(err.stack);
    }
  }

  if (failed) {
    const failResult = {
      benchmark: name,
      category,
      description,
      failed: true,
      error: errorMessage,
      system,
    };
    if (shouldSave) saveResult(failResult);
    return failResult;
  }

  // ── Statistics ──
  const stats = computeStats(samples);
  const warnings = analyzeStability(stats, { warmup });
  const throughput = throughputOpts ? computeThroughput(stats, throughputOpts) : null;

  const result = {
    benchmark: name,
    category,
    description,
    failed: false,
    iterations,
    warmup,
    stats,
    throughput,
    custom_metrics: lastCustomMetrics,
    warnings,
    system,
  };

  if (!silent) printResult(result);
  if (shouldSave) saveResult(result);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} SuiteOptions
 * @property {string}              name        - Suite name
 * @property {BenchmarkOptions[]}  benchmarks  - Benchmark option objects
 * @property {boolean}             [bail=false] - Stop on first failure
 */

/**
 * Run a suite of benchmarks and write a suite-level summary JSON.
 *
 * @param {SuiteOptions} suiteOpts
 * @returns {Promise<BenchmarkResult[]>}
 */
export async function runSuite(suiteOpts) {
  const { name, benchmarks, bail = false } = suiteOpts;

  printSuiteHeader(name);

  const results = [];

  for (const benchOpts of benchmarks) {
    const result = await runBenchmark(benchOpts);
    results.push(result);

    if (result.failed && bail) {
      console.log(`${RED}Bailing on first failure.${RESET}`);
      break;
    }
  }

  printSuiteSummary(results);

  // Suite-level summary JSON
  ensureResultsDir();
  const safeName = name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = path.join(RESULTS_DIR, `suite-${safeName}-${ts}.json`);

  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        suite: name,
        provider_mode: PROVIDER_MODE,
        system: captureSystemMetadata(),
        results: results.map((r) => ({
          benchmark: r.benchmark,
          category: r.category,
          failed: r.failed,
          error: r.error ?? null,
          median_ms: r.stats?.median_ms ?? null,
          p95_ms: r.stats?.p95_ms ?? null,
          custom_metrics: r.custom_metrics ?? {},
        })),
      },
      null,
      2
    ),
    "utf-8"
  );

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider mode helpers
// Benchmarks use these to conditionally skip or adapt behavior.
// ─────────────────────────────────────────────────────────────────────────────

export function isLiveMode() {
  return PROVIDER_MODE === "live";
}

export function isMockMode() {
  return PROVIDER_MODE === "mock";
}

/**
 * Returns true and prints a skip message when running in mock mode.
 * Use at the top of any benchmark that requires real LLM responses.
 *
 * Usage:
 *   if (requiresLive("My Benchmark")) return;
 */
export function requiresLive(benchmarkName) {
  if (isMockMode()) {
    console.log(
      `${DIM}  ⏭ ${benchmarkName} requires live provider — skipping in mock mode. ` +
        `Run with CF_BENCHMARK_MODE=live to include.${RESET}`
    );
    return true;
  }
  return false;
}

/**
 * Returns true and prints a skip message when a session stub is detected.
 * Workflow benchmarks call this after loading a session fixture.
 *
 * Usage:
 *   const session = loadSession("rename-function");
 *   if (requiresRecordedSession(session, "Rename Function")) return;
 */
export function requiresRecordedSession(session, benchmarkName) {
  if (session?._stub === true) {
    console.log(
      `${DIM}  ⏭ ${benchmarkName} requires a recorded session fixture. ` +
        `Run with CF_BENCHMARK_MODE=live --record to capture one.${RESET}`
    );
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export { computeStats, computeThroughput, PROVIDER_MODE, RESULTS_DIR };
