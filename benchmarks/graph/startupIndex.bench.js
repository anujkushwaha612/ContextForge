// benchmarks/graph/startupIndex.bench.js
//
// Category: Engine (Category A)
// Target: src/graph/workspaceMapper.js
//
// Measures Tree-sitter indexing speed, memory usage, and graph density
// across synthetic repository fixtures of varying sizes.
//
// Outputs:
//   - Files indexed
//   - Nodes extracted
//   - Edges extracted (imports + calls + routes)
//   - Indexing latency (ms)
//   - Nodes per file (density metric)
//   - Memory delta (RSS before/after)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { runBenchmark } from "../benchmarkRunner.js";
import { requireFixture, REPO_FIXTURES } from "../fixtures/index.js";
import { indexWorkspace } from "../../src/graph/workspaceMapper.js";
import { getGraphStats, clearGraph } from "../../src/graph/graphDb.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadRepoManifest(repoSize) {
  const repoPath = REPO_FIXTURES[repoSize];
  const manifestPath = path.join(repoPath, "_manifest.json");
  requireFixture(manifestPath, `${repoSize} repository manifest`);
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

function getMemoryUsageMB() {
  const usage = process.memoryUsage();
  return Math.round(usage.rss / 1024 / 1024);
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark: Index synthetic repository
// ─────────────────────────────────────────────────────────────────────────────

async function benchmarkRepoIndex(repoSize) {
  const repoPath = REPO_FIXTURES[repoSize];
  requireFixture(repoPath, `${repoSize} repository`);

  const manifest = loadRepoManifest(repoSize);

  console.log(`\n[StartupIndex] Indexing ${repoSize} repository: ${repoPath}`);
  console.log(
    `  Expected: ${manifest.files} files, ~${manifest.nodes_expected} nodes, ~${manifest.edges_expected} edges`
  );

  // ── Clear previous repo's data before indexing this one ──
  // graphDb is a singleton — without this, stats accumulate across
  // all three repo sizes and getGraphStats() returns the total, not
  // the current repo's count.
  clearGraph();

  const memBefore = getMemoryUsageMB();
  const start = performance.now();

  const stats = await indexWorkspace(repoPath, {
    force: true,
    onProgress: null,
  });

  const elapsed = performance.now() - start;
  const memAfter = getMemoryUsageMB();
  const memDelta = memAfter - memBefore;

  const graphStats = getGraphStats();

  console.log(
    `  Actual:   ${stats.indexed} files indexed, ${stats.skipped} skipped, ${stats.errors} errors`
  );
  console.log(`  Graph:    ${graphStats.node_count} nodes, ${graphStats.edge_count} edges`);
  console.log(
    `            (${graphStats.calls_count} calls, ${graphStats.imports_count} imports, ${graphStats.routes_count} routes)`
  );
  console.log(`  Latency:  ${elapsed.toFixed(2)}ms`);
  console.log(`  Memory:   ${memBefore}MB → ${memAfter}MB (Δ ${memDelta}MB)`);

  // Verify expectations (within ±10% margin — synthetic fixtures may vary slightly)
  const nodeMargin = manifest.nodes_expected * 0.1;
  const edgeMargin = manifest.edges_expected * 0.1;
  const nodeMatch = Math.abs(graphStats.node_count - manifest.nodes_expected) <= nodeMargin;
  const edgeMatch = Math.abs(graphStats.edge_count - manifest.edges_expected) <= edgeMargin;

  if (!nodeMatch || !edgeMatch) {
    console.warn(`  ⚠️  Graph stats deviate from manifest expectations by >10%`);
    console.warn(`      Nodes: expected ${manifest.nodes_expected}, got ${graphStats.node_count}`);
    console.warn(`      Edges: expected ${manifest.edges_expected}, got ${graphStats.edge_count}`);
  }

  return {
    repo_size: repoSize,
    files_indexed: stats.indexed,
    files_skipped: stats.skipped,
    files_errors: stats.errors,
    nodes_extracted: graphStats.node_count,
    edges_extracted: graphStats.edge_count,
    edges_calls: graphStats.calls_count,
    edges_imports: graphStats.imports_count,
    edges_routes: graphStats.routes_count,
    latency_ms: Math.round(elapsed),
    memory_delta_mb: memDelta,
    nodes_per_file: stats.indexed > 0 ? (graphStats.node_count / stats.indexed).toFixed(1) : 0,
    edges_per_node:
      graphStats.node_count > 0 ? (graphStats.edge_count / graphStats.node_count).toFixed(2) : 0,
    expected_nodes: manifest.nodes_expected,
    expected_edges: manifest.edges_expected,
    expectation_match: nodeMatch && edgeMatch,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark definitions
// ─────────────────────────────────────────────────────────────────────────────

const REPO_SIZES = ["small", "medium", "large"];

async function runAllIndexBenchmarks() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("Graph Startup Index Benchmark Suite");
  console.log("═══════════════════════════════════════════════════════════\n");

  const results = [];

  for (const size of REPO_SIZES) {
    const result = await runBenchmark({
      name: `graph-startup-index-${size}`,
      category: "graph",
      warmup: 1, // warmup clears + indexes once; measured iterations start clean
      iterations: 5,
      setup: async () => {
        clearGraph(); // ensure DB is empty before warmup
      },
      benchmark: async () => {
        return await benchmarkRepoIndex(size); // clearGraph() still inside here
      },
      silent: false, // show per-iteration logs
      saveResult: true,
    });

    results.push(result);

    // Give GC a chance to clean up between repo sizes
    if (global.gc) {
      global.gc();
      await new Promise((r) => setTimeout(r, 500));
    } else {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("Index Benchmark Summary");
  console.log("─────────────────────────────────────────────────────────────\n");

  console.log("| Repo Size | Files | Nodes | Edges | Latency (ms) | Nodes/File | Memory (MB) |");
  console.log("|-----------|-------|-------|-------|--------------|------------|-------------|");

  for (const r of results) {
    if (r.failed) {
      console.log(`| ${r.benchmark.padEnd(9)} | FAILED: ${r.error} |`);
      continue;
    }

    const metrics = r.custom_metrics;
    const size = metrics.repo_size.padEnd(9);
    const files = String(metrics.files_indexed).padStart(5);
    const nodes = String(metrics.nodes_extracted).padStart(5);
    const edges = String(metrics.edges_extracted).padStart(5);
    const latency = String(r.stats.median_ms).padStart(12);
    const density = String(metrics.nodes_per_file).padStart(10);
    const mem = String(metrics.memory_delta_mb).padStart(11);

    console.log(`| ${size} | ${files} | ${nodes} | ${edges} | ${latency} | ${density} | ${mem} |`);
  }

  console.log("\n");

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run if invoked directly
// ─────────────────────────────────────────────────────────────────────────────

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()
) {
  runAllIndexBenchmarks()
    .then(() => {
      console.log("✅ Graph startup index benchmarks complete.\n");
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\n❌ Benchmark suite failed: ${err.message}`);
      console.error(err.stack);
      process.exit(1);
    });
}

export { runAllIndexBenchmarks };
