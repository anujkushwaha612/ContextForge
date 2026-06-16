"""
ContextForge Compression Benchmark.

Measures what the pipeline actually does:
- Compression ratio (tokens before vs after)
- Pipeline latency (dry-run mode, no LLM call)
- Accuracy: not measured here — requires E2E evaluation (ccr_regression_benchmark.py)

Run:
    python benchmarks/bench_compression.py
"""

from __future__ import annotations
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from benchmarks.scenarios.tool_outputs import (
    Question,
    generate_file_search_tool_output,
    generate_js_source_tool_output,
    generate_server_log_tool_output,
    count_tokens,
)


try:
    import requests
    CF_PROXY_URL = "http://localhost:3000"
    CF_AVAILABLE = True
except ImportError:
    CF_AVAILABLE = False


# ─────────────────────────────────────────────
# Result types
# ─────────────────────────────────────────────

@dataclass
class CompressionResult:
    approach: str
    scenario: str
    tokens_original: int
    tokens_after: int
    compression_ratio: float
    latency_ms: float
    notes: str = ""


# ─────────────────────────────────────────────
# ContextForge compressor
# ─────────────────────────────────────────────

class ContextForgeCompressor:
    """
    Measures compression by sending payloads through the proxy pipeline
    using x-cf-dry-run mode.

    Dry-run sends the full pipeline without hitting the LLM upstream.
    Returns real token counts from the pipeline report, not estimates.

    What this measures:
        - tokens_before: tokens entering the pipeline
        - tokens_after:  tokens exiting the pipeline
        - compression_ratio: 1 - (tokens_after / tokens_before)
        - latency_ms: pipeline-only latency, no LLM call

    What this does NOT measure:
        - Accuracy — Ghost Interceptor retrieval happens in a subsequent
          turn. Run ccr_regression_benchmark.py for E2E accuracy.
    """

    def __init__(self, proxy_url: str = "http://localhost:3000"):
        self.proxy_url = proxy_url
        self._session = requests.Session()

    def compress_single_tool_result(
        self,
        tool_result: dict,
        model: str = "claude-3-5-sonnet-20241022",
    ) -> tuple[str, dict]:
        """
        Send a tool result through the pipeline in dry-run mode.

        Returns (original_content, metadata) with real token counts
        from the pipeline report.

        x-cf-dry-run=true causes the proxy to:
          1. Run all pipeline stages (translation → cache_align)
          2. Return pipeline metrics as JSON
          3. Skip the upstream LLM call entirely
        """
        original_content = tool_result.get("content", "")
        original_tokens = count_tokens(original_content)

        call_id = tool_result.get("tool_call_id", "call_bench_001")
        tool_name = tool_result.get("name", "bash")

        clean_tool_result = {
            k: v for k, v in tool_result.items()
            if not k.startswith("_")
        }

        payload = {
            "model": model,
            "max_tokens": 1,
            "stream": False,
            "system": "You are a helpful assistant.",
            "messages": [
                {"role": "user", "content": "Analyze this output."},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": '{"command": "cat file"}',
                        },
                    }],
                },
                clean_tool_result,
            ],
        }

        start = time.perf_counter()
        try:
            resp = self._session.post(
                f"{self.proxy_url}/v1/messages",
                json=payload,
                headers={
                    "content-type": "application/json",
                    "x-api-key": "benchmark",
                    "anthropic-version": "2023-06-01",
                    "x-cf-dry-run": "true",
                },
                timeout=30,
            )
            pipeline_latency_ms = (time.perf_counter() - start) * 1000

            if resp.status_code >= 400:
                return original_content, {
                    "tokens_original": original_tokens,
                    "tokens_after": original_tokens,
                    "compression_ratio": 0.0,
                    "latency_ms": pipeline_latency_ms,
                    "error": f"HTTP {resp.status_code}: {resp.text[:200]}",
                    "pipeline_ran": False,
                }

            try:
                data = resp.json()
            except Exception as e:
                return original_content, {
                    "tokens_original": original_tokens,
                    "tokens_after": original_tokens,
                    "compression_ratio": 0.0,
                    "latency_ms": pipeline_latency_ms,
                    "error": f"JSON parse failed: {e}",
                    "pipeline_ran": False,
                }

            tokens_before = data.get("tokens_before", original_tokens)
            tokens_after = data.get("tokens_after", original_tokens)
            pipeline_ms = data.get("pipeline_ms", pipeline_latency_ms)
            stages = data.get("stages", {})

            if tokens_before > 0:
                compression_ratio = 1.0 - (tokens_after / tokens_before)
            else:
                compression_ratio = 0.0

            dominant_stage = max(
                stages, key=stages.get) if stages else "unknown"

            chars = len(original_content)
            if chars > 15_000 and compression_ratio > 0.85:
                note = "vaulted (Fat Catch)"
            elif dominant_stage == "code_compress":
                note = "AST compressed"
            elif dominant_stage == "prune":
                note = "log pruned"
            elif compression_ratio > 0.5:
                note = "pipeline compressed"
            elif compression_ratio > 0.0:
                note = "light compression"
            else:
                note = "passthrough"

            return original_content, {
                "tokens_original": tokens_before,
                "tokens_after": tokens_after,
                "compression_ratio": compression_ratio,
                "latency_ms": pipeline_ms,
                "pipeline_ran": True,
                "note": note,
                "stages": stages,
            }

        except Exception as e:
            pipeline_latency_ms = (time.perf_counter() - start) * 1000
            return original_content, {
                "tokens_original": original_tokens,
                "tokens_after": original_tokens,
                "compression_ratio": 0.0,
                "latency_ms": pipeline_latency_ms,
                "error": str(e),
                "pipeline_ran": False,
            }

    def check_connection(self) -> bool:
        try:
            self._session.get(f"{self.proxy_url}/dashboard", timeout=2)
            return True
        except Exception:
            return False


# ─────────────────────────────────────────────
# Baselines
# ─────────────────────────────────────────────

def baseline_no_compression(tool_result: dict) -> tuple[str, dict]:
    """Return content unchanged — the reference baseline."""
    content = tool_result.get("content", "")
    tokens = count_tokens(content)
    return content, {
        "tokens_original": tokens,
        "tokens_after": tokens,
        "compression_ratio": 0.0,
        "latency_ms": 0.0,
    }


def baseline_truncation(
    tool_result: dict,
    max_chars: int = 4000,
) -> tuple[str, dict]:
    """Truncate to first max_chars characters."""
    content = tool_result.get("content", "")
    original_tokens = count_tokens(content)

    start = time.perf_counter()
    truncated = content[:max_chars]
    if len(content) > max_chars:
        truncated += f"\n... [{len(content) - max_chars} chars truncated]"
    latency_ms = (time.perf_counter() - start) * 1000

    compressed_tokens = count_tokens(truncated)
    return truncated, {
        "tokens_original": original_tokens,
        "tokens_after": compressed_tokens,
        "compression_ratio": (
            1 - compressed_tokens / original_tokens
            if original_tokens > 0 else 0
        ),
        "latency_ms": latency_ms,
    }


# ─────────────────────────────────────────────
# Scenario runner
# ─────────────────────────────────────────────

def run_scenario(
    name: str,
    tool_result: dict,
    cf: ContextForgeCompressor | None,
) -> list[CompressionResult]:
    """Run all approaches on a single scenario."""

    results = []
    original_content = tool_result.get("content", "")
    original_tokens = count_tokens(original_content)

    print(f"\n{'=' * 60}")
    print(f"Scenario: {name}")
    print(
        f"Original: {original_tokens:,} tokens ({len(original_content):,} chars)")
    print(f"{'=' * 60}")

    # ── Baseline ──
    _, meta = baseline_no_compression(tool_result)
    results.append(CompressionResult(
        approach="no_compression",
        scenario=name,
        tokens_original=original_tokens,
        tokens_after=meta["tokens_after"],
        compression_ratio=0.0,
        latency_ms=0.0,
        notes="Baseline — no compression applied",
    ))
    print(
        f"  [baseline]         {original_tokens:>6,} → {meta['tokens_after']:>6,} tokens"
    )

    # ── Truncation ──
    _, meta = baseline_truncation(tool_result, max_chars=4000)
    results.append(CompressionResult(
        approach="truncation_4k",
        scenario=name,
        tokens_original=original_tokens,
        tokens_after=meta["tokens_after"],
        compression_ratio=meta["compression_ratio"],
        latency_ms=meta["latency_ms"],
        notes="Keep first 4000 chars — lossy, data after cutoff is permanently gone",
    ))
    print(
        f"  [truncation]       {original_tokens:>6,} → {meta['tokens_after']:>6,} tokens | "
        f"ratio={meta['compression_ratio']:.1%} | "
        f"{meta['latency_ms']:.2f}ms"
    )

    # ── ContextForge ──
    if cf is None:
        print(
            f"  [contextforge]     SKIPPED — proxy not running at {CF_PROXY_URL}")
        return results

    cf_content, cf_meta = cf.compress_single_tool_result(tool_result)
    error = cf_meta.get("error")

    if error:
        print(f"  [contextforge]     ERROR: {error}")
        return results

    cf_latency = cf_meta.get("latency_ms", 0.0)
    cf_tokens = cf_meta.get("tokens_after", original_tokens)
    cf_ratio = cf_meta.get("compression_ratio", 0.0)
    pipeline_note = cf_meta.get("note", "")
    stages = cf_meta.get("stages", {})

    results.append(CompressionResult(
        approach="contextforge",
        scenario=name,
        tokens_original=original_tokens,
        tokens_after=cf_tokens,
        compression_ratio=cf_ratio,
        latency_ms=cf_latency,
        notes=f"12-stage pipeline ({pipeline_note})",
    ))

    stages_str = ""
    if stages:
        top2 = sorted(stages.items(), key=lambda x: x[1], reverse=True)[:2]
        stages_str = " | stages: " + ", ".join(
            f"{s}={ms:.1f}ms" for s, ms in top2
        )

    print(
        f"  [contextforge]     {original_tokens:>6,} → {cf_tokens:>6,} tokens | "
        f"ratio={cf_ratio:.1%} | "
        f"{cf_latency:.0f}ms pipeline  [{pipeline_note}]{stages_str}"
    )

    return results


# ─────────────────────────────────────────────
# Full benchmark suite
# ─────────────────────────────────────────────

def run_full_benchmark(proxy_url: str = "http://localhost:3000") -> dict:
    """Run all compression benchmark scenarios."""

    print("\n" + "=" * 70)
    print("CONTEXTFORGE COMPRESSION BENCHMARK")
    print("Measures: compression ratio, pipeline latency")
    print("Does not measure: accuracy (run ccr_regression_benchmark.py)")
    print("=" * 70)

    cf = None
    try:
        cf_test = ContextForgeCompressor(proxy_url)
        if cf_test.check_connection():
            cf = cf_test
            print(f"\n✅ ContextForge proxy connected at {proxy_url}")
        else:
            raise Exception("no response")
    except Exception:
        print(f"\n⚠️  ContextForge proxy not running at {proxy_url}")
        print("   Compression results will be skipped.")
        print("   Start proxy: node src/server.js")

    all_results: list[CompressionResult] = []

    # ── Scenario 1: Server logs (500 entries) ──
    print("\nGenerating scenario data...")
    tool_result, _ = generate_server_log_tool_output(
        n_entries=500,
        error_positions=[3, 250, 495],
    )
    results = run_scenario("Server Logs (500 entries)", tool_result, cf)
    all_results.extend(results)

    # ── Scenario 2: File search (1000 files) ──
    tool_result, _ = generate_file_search_tool_output(n_files=1000)
    results = run_scenario("Code Search (1000 files)", tool_result, cf)
    all_results.extend(results)

    # ── Scenario 3: JS source file (1200 lines) ──
    tool_result, _ = generate_js_source_tool_output(n_lines=1200)
    results = run_scenario("JS Source File (1200 lines)", tool_result, cf)
    all_results.extend(results)

    # ── Summary ──
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("Metrics shown: compression ratio, pipeline latency")
    print("Accuracy is not shown — it is not measured by this script")
    print("=" * 70)

    approaches = sorted({r.approach for r in all_results})

    print(f"\n{'Approach':<20} {'Avg Compression':>16} {'Avg Latency':>12}")
    print("-" * 50)

    summary_rows = []
    for approach in approaches:
        rows = [r for r in all_results if r.approach == approach]
        avg_ratio = sum(r.compression_ratio for r in rows) / len(rows)
        avg_lat = sum(r.latency_ms for r in rows) / len(rows)

        print(
            f"  {approach:<18} {avg_ratio:>15.1%} {avg_lat:>10.1f}ms"
        )
        summary_rows.append({
            "approach": approach,
            "avg_compression_ratio": avg_ratio,
            "avg_latency_ms": avg_lat,
        })

    print()
    print("  Note on latency:")
    print("  Pipeline latency is measured in dry-run mode (no LLM call).")
    print("  Full request latency includes LLM inference time on top of this.")
    print()
    print("  Note on truncation:")
    print("  Truncation is lossy — data after the cutoff is permanently gone.")
    print("  ContextForge vaults data and retrieves it via Ghost Interceptor.")
    print("  Whether retrieval preserves accuracy: run ccr_regression_benchmark.py")
    print()

    return {
        "results": [
            {
                "approach": r.approach,
                "scenario": r.scenario,
                "tokens_original": r.tokens_original,
                "tokens_after": r.tokens_after,
                "compression_ratio": r.compression_ratio,
                "latency_ms": r.latency_ms,
                "notes": r.notes,
            }
            for r in all_results
        ],
        "summary": summary_rows,
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="ContextForge compression benchmark")
    parser.add_argument("--proxy", default="http://localhost:3000")
    parser.add_argument("--output", "-o", help="Save JSON results to file")
    args = parser.parse_args()

    results = run_full_benchmark(args.proxy)

    if args.output:
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\nResults saved to {args.output}")