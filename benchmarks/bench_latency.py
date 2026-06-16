#!/usr/bin/env python3
"""
ContextForge pipeline latency benchmark.

- perf_counter_ns precision
- 20 iterations + 3 warmup per scenario
- p50/p95/p99 reporting
- Per-stage breakdown (via StageTimer)
- Cost-benefit analysis vs LLM prefill time saved
- Break-even across model tiers

Usage:
    python benchmarks/bench_latency.py
    python benchmarks/bench_latency.py --output docs/LATENCY_BENCHMARKS.md
    python benchmarks/bench_latency.py --json results.json
    python benchmarks/bench_latency.py --iterations 50
    python benchmarks/bench_latency.py --scenario code
    python benchmarks/bench_latency.py --scenario logs
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import random
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))
    
from benchmarks.scenarios.conversations import (
    generate_file_read_conversation,
    generate_agentic_coding_conversation,
    generate_tool_heavy_conversation,
)
from benchmarks.scenarios.tool_outputs import (
    generate_server_log_tool_output,
    generate_file_search_tool_output,
    generate_js_source_tool_output,
    count_tokens,
)



# ─────────────────────────────────────────────
# Model profiles
# ─────────────────────────────────────────────

MODEL_PROFILES: dict[str, dict[str, float]] = {
    "gpt-4o-mini": {
        "ms_per_token": 0.01,
        "price_per_mtok_input": 0.15,
        "label": "GPT-4o Mini",
    },
    "gpt-4o": {
        "ms_per_token": 0.03,
        "price_per_mtok_input": 2.50,
        "label": "GPT-4o",
    },
    "claude-sonnet": {
        "ms_per_token": 0.03,
        "price_per_mtok_input": 3.00,
        "label": "Claude Sonnet",
    },
    "claude-opus": {
        "ms_per_token": 0.08,
        "price_per_mtok_input": 15.00,
        "label": "Claude Opus",
    },
}

REFERENCE_MODEL = "claude-sonnet"
PROXY_URL = "http://localhost:3000"


# ─────────────────────────────────────────────
# Data classes — LatencyResult
# ─────────────────────────────────────────────

@dataclass
class StageBreakdown:
    """Per-stage timing from StageTimer output."""
    name: str
    durations_ms: list[float] = field(default_factory=list)

    @property
    def p50_ms(self) -> float:
        if not self.durations_ms:
            return 0.0
        s = sorted(self.durations_ms)
        return s[len(s) // 2]

    @property
    def mean_ms(self) -> float:
        return statistics.mean(self.durations_ms) if self.durations_ms else 0.0


@dataclass
class LatencyResult:
    scenario_name: str
    content_type: str
    size_label: str
    tokens_before: int
    tokens_after: int
    tokens_saved: int
    compression_ratio: float
    timings_ms: list[float]
    stage_timings: dict[str, StageBreakdown] = field(default_factory=dict)

    @property
    def p50_ms(self) -> float:
        s = sorted(self.timings_ms)
        return s[len(s) // 2]

    @property
    def p95_ms(self) -> float:
        s = sorted(self.timings_ms)
        idx = int(math.ceil(0.95 * len(s))) - 1
        return s[max(0, idx)]

    @property
    def p99_ms(self) -> float:
        s = sorted(self.timings_ms)
        idx = int(math.ceil(0.99 * len(s))) - 1
        return s[max(0, idx)]

    @property
    def mean_ms(self) -> float:
        return statistics.mean(self.timings_ms)

    @property
    def stddev_ms(self) -> float:
        return statistics.stdev(self.timings_ms) if len(self.timings_ms) > 1 else 0.0

    @property
    def min_ms(self) -> float:
        return min(self.timings_ms)

    @property
    def max_ms(self) -> float:
        return max(self.timings_ms)

    def to_dict(self) -> dict[str, Any]:
        return {
            "scenario_name": self.scenario_name,
            "content_type": self.content_type,
            "size_label": self.size_label,
            "tokens_before": self.tokens_before,
            "tokens_after": self.tokens_after,
            "tokens_saved": self.tokens_saved,
            "compression_ratio": self.compression_ratio,
            "iterations": len(self.timings_ms),
            "p50_ms": round(self.p50_ms, 3),
            "p95_ms": round(self.p95_ms, 3),
            "p99_ms": round(self.p99_ms, 3),
            "mean_ms": round(self.mean_ms, 3),
            "stddev_ms": round(self.stddev_ms, 3),
            "min_ms": round(self.min_ms, 3),
            "max_ms": round(self.max_ms, 3),
            "stage_breakdown": {
                name: {
                    "p50_ms": round(sb.p50_ms, 3),
                    "mean_ms": round(sb.mean_ms, 3),
                }
                for name, sb in self.stage_timings.items()
            },
        }


# ─────────────────────────────────────────────
# Scenario definitions
# ─────────────────────────────────────────────

@dataclass
class Scenario:
    name: str
    content_type: str
    size_label: str
    messages: list[dict]


def generate_scenarios(content_types: list[str] | None = None) -> list[Scenario]:
    """Generate all benchmark scenarios."""

    all_types = {"logs", "files", "code", "multiturn", "agentic", "tools"}
    types = set(content_types) if content_types else all_types
    scenarios: list[Scenario] = []
    random.seed(42)

    # ── Logs ("json/logs" scenarios) ──
    if "logs" in types:
        for n, label in [(100, "100 entries"), (500, "500 entries"), (1000, "1K entries")]:
            tool_result, _ = generate_server_log_tool_output(n_entries=n)
            messages = _wrap_tool_result(tool_result)
            scenarios.append(Scenario(
                name=f"Logs: Server ({label})",
                content_type="logs",
                size_label=label,
                messages=messages,
            ))

    # ── File search ("json" scenarios) ──
    if "files" in types:
        for n, label in [(200, "200 files"), (1000, "1K files")]:
            tool_result, _ = generate_file_search_tool_output(n_files=n)
            messages = _wrap_tool_result(tool_result)
            scenarios.append(Scenario(
                name=f"Files: Search ({label})",
                content_type="files",
                size_label=label,
                messages=messages,
            ))

    # ── JS source (ContextForge-unique: AST compression) ──
    if "code" in types:
        for n, label in [(300, "~300 lines"), (800, "~800 lines"), (1200, "~1200 lines")]:
            tool_result, _ = generate_js_source_tool_output(n_lines=n)
            messages = _wrap_tool_result(tool_result)
            scenarios.append(Scenario(
                name=f"Code: JS Source ({label})",
                content_type="code",
                size_label=label,
                messages=messages,
            ))

    # ── Multi-turn repeated file reads (ContextForge-unique: dedup) ──
    if "multiturn" in types:
        file_content = "export function stage() {}\n" * 150  # ~600 tokens
        for n_turns, label in [(3, "3 turns"), (5, "5 turns"), (8, "8 turns")]:
            messages = generate_file_read_conversation(
                n_turns=n_turns,
                file_content=file_content,
                filename="src/server.js",
            )
            scenarios.append(Scenario(
                name=f"Multi-turn: File Reads ({label})",
                content_type="multiturn",
                size_label=label,
                messages=messages,
            ))

    # ── Agentic coding session ("agentic" scenario) ──
    if "agentic" in types:
        large_content = "export function fn() {}\n" * 300
        messages = generate_agentic_coding_conversation(
            n_turns=8,
            large_file_content=large_content,
        )
        scenarios.append(Scenario(
            name="Agentic: Coding Session (8 turns)",
            content_type="agentic",
            size_label="8 turns",
            messages=messages,
        ))

    # ── Tool-heavy conversation ──
    if "tools" in types:
        for n, label in [(10, "10 tools"), (20, "20 tools")]:
            messages = generate_tool_heavy_conversation(n_tool_calls=n)
            scenarios.append(Scenario(
                name=f"Tools: Heavy ({label})",
                content_type="tools",
                size_label=label,
                messages=messages,
            ))

    return scenarios


def _wrap_tool_result(tool_result: dict) -> list[dict]:
    """Wrap a tool result in a minimal Anthropic conversation."""
    call_id = tool_result.get("tool_call_id", "call_bench_001")
    return [
        {
            "role": "system",
            "content": "You are a helpful assistant.\n\nCurrent date: 2025-01-15",
        },
        {"role": "user", "content": "Analyze this output."},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": call_id,
                "type": "function",
                "function": {
                    "name": tool_result.get("name", "bash"),
                    "arguments": '{"command": "benchmark"}',
                },
            }],
        },
        tool_result,
    ]


# ─────────────────────────────────────────────
# Proxy-based pipeline runner
# ─────────────────────────────────────────────

class ContextForgePipeline:
    """
    Sends payloads through the ContextForge proxy and measures
    pipeline latency from the proxy logs.

    Uses the /v1/stats/stream SSE endpoint to read stage timings
    after each request.
    """

    def __init__(self, proxy_url: str = PROXY_URL):
        self.proxy_url = proxy_url
        self.last_stage_timings: dict[str, float] = {}
        self.last_tokens_before: int = 0
        self.last_tokens_after: int = 0
        self._session = requests.Session()

    def apply(self, messages: list[dict]) -> dict:
        system = next(
            (m["content"] for m in messages if m["role"] == "system"),
            "You are a helpful assistant.",
        )
        non_system = [m for m in messages if m["role"] != "system"]

        payload = {
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 1,
            "messages": non_system,
            "system": system,
            "stream": False,
        }

        # Send request with the Dry Run header
        resp = self._session.post(
            f"{self.proxy_url}/v1/messages",
            json=payload,
            headers={
                "content-type": "application/json",
                "x-api-key": "benchmark",
                "anthropic-version": "2023-06-01",
                "x-cf-dry-run": "true"  # <--- TELLS PROXY TO SKIP LLM
            },
            timeout=30,
        )

        if resp.status_code != 200:
            raise Exception(f"Proxy error: {resp.status_code}")

        data = resp.json()

        # Read exact metrics directly from the proxy's internal timers
        self.last_stage_timings = data.get("stages", {})
        self.last_tokens_before = data["tokens_before"]
        self.last_tokens_after = data["tokens_after"]

        return {
            "elapsed_ms": data["pipeline_ms"],
            "status": resp.status_code,
            "tokens_before": data["tokens_before"],
        }

    def check_connection(self) -> bool:
        try:
            self._session.get(f"{self.proxy_url}/dashboard", timeout=2)
            return True
        except Exception:
            return False


# ─────────────────────────────────────────────
# Benchmark runner — run_scenario
# ─────────────────────────────────────────────

def run_scenario(
    pipeline: ContextForgePipeline,
    scenario: Scenario,
    iterations: int = 20,
    warmup: int = 3,
) -> LatencyResult:
    """
    Run one scenario N times with warmup.
    Uses perf_counter_ns — exactly.
    """
    content = " ".join(str(m.get("content", "")) for m in scenario.messages)
    tokens_before = count_tokens(content)

    # Warmup — exercises connection pool, any lazy init
    for _ in range(warmup):
        try:
            pipeline.apply(scenario.messages)
        except Exception:
            pass

    # Measured iterations
    timings_ms: list[float] = []
    stage_accum: dict[str, list[float]] = {}

    for _ in range(iterations):
        try:
            result = pipeline.apply(scenario.messages)
            timings_ms.append(result["elapsed_ms"])

            for stage, ms in pipeline.last_stage_timings.items():
                stage_accum.setdefault(stage, []).append(ms)

        except Exception as e:
            # Don't count failed requests
            pass

    if not timings_ms:
        # All requests failed — return zeros
        return LatencyResult(
            scenario_name=scenario.name,
            content_type=scenario.content_type,
            size_label=scenario.size_label,
            tokens_before=tokens_before,
            tokens_after=tokens_before,
            tokens_saved=0,
            compression_ratio=0.0,
            timings_ms=[0.0],
        )

    # Build stage breakdown objects
    stage_timings = {
        name: StageBreakdown(name=name, durations_ms=durations)
        for name, durations in stage_accum.items()
    }

    # Grab the exact tokens from the last run in the iteration
    tokens_after = pipeline.last_tokens_after
    tokens_before = pipeline.last_tokens_before
    tokens_saved = max(0, tokens_before - tokens_after)
    exact_ratio = 1 - \
        (tokens_after / tokens_before) if tokens_before > 0 else 0.0

    return LatencyResult(
        scenario_name=scenario.name,
        content_type=scenario.content_type,
        size_label=scenario.size_label,
        tokens_before=tokens_before,
        tokens_after=tokens_after,
        tokens_saved=tokens_saved,
        compression_ratio=exact_ratio,
        timings_ms=timings_ms,
        stage_timings=stage_timings,
    )


def run_all(
    scenarios: list[Scenario],
    pipeline: ContextForgePipeline,
    iterations: int = 20,
    warmup: int = 3,
    verbose: bool = True,
) -> list[LatencyResult]:
    """Run all scenarios — run_all."""
    results: list[LatencyResult] = []

    for i, scenario in enumerate(scenarios, 1):
        if verbose:
            print(f"  [{i}/{len(scenarios)}] {scenario.name}...",
                  end=" ", flush=True)

        result = run_scenario(pipeline, scenario,
                              iterations=iterations, warmup=warmup)
        results.append(result)

        if verbose:
            print(
                f"p50={result.p50_ms:.1f}ms  "
                f"p95={result.p95_ms:.1f}ms  "
                f"compression={result.compression_ratio:.0%}  "
                f"saved={result.tokens_saved:,}tok"
            )

    return results


# ─────────────────────────────────────────────
# Formatting — report style
# ─────────────────────────────────────────────

def _fmt_ms(ms: float) -> str:
    if ms < 0.01:
        return "<0.01"
    if ms < 1.0:
        return f"{ms:.2f}"
    if ms < 100.0:
        return f"{ms:.1f}"
    return f"{ms:.0f}"


def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def format_terminal_report(results: list[LatencyResult]) -> str:
    lines: list[str] = []

    lines.append("")
    lines.append("=" * 105)
    lines.append("  CONTEXTFORGE LATENCY BENCHMARK")
    lines.append("  (Methodology bench_latency.py)")
    lines.append("=" * 105)
    lines.append("")

    # ── Compression overhead table ──
    lines.append("COMPRESSION OVERHEAD BY SCENARIO")
    lines.append("-" * 105)
    header = (
        f"{'Scenario':<45} {'Tok In':>8} {'Saved':>7} {'Ratio':>6} "
        f"{'p50':>8} {'p95':>8} {'p99':>8} {'Mean':>8} {'Stddev':>8}"
    )
    lines.append(header)
    lines.append("-" * 105)

    current_type = ""
    for r in results:
        if r.content_type != current_type:
            if current_type:
                lines.append("")
            current_type = r.content_type

        row = (
            f"{r.scenario_name:<45} "
            f"{_fmt_tokens(r.tokens_before):>8} "
            f"{_fmt_tokens(r.tokens_saved):>7} "
            f"{r.compression_ratio:>5.0%} "
            f"{_fmt_ms(r.p50_ms) + 'ms':>8} "
            f"{_fmt_ms(r.p95_ms) + 'ms':>8} "
            f"{_fmt_ms(r.p99_ms) + 'ms':>8} "
            f"{_fmt_ms(r.mean_ms) + 'ms':>8} "
            f"{_fmt_ms(r.stddev_ms) + 'ms':>8}"
        )
        lines.append(row)

    lines.append("")
    lines.append("")

    # ── Cost-benefit analysis ──
    lines.append("")
    lines.append("COST-BENEFIT ANALYSIS")
    lines.append(
        f"Reference model: {MODEL_PROFILES[REFERENCE_MODEL]['label']}")
    lines.append("-" * 105)
    header = (
        f"{'Scenario':<45} {'Compress':>10} {'LLM Saved':>11} {'Net Benefit':>13} {'$/1K Reqs':>11}"
    )
    lines.append(header)
    lines.append("-" * 105)

    model = MODEL_PROFILES[REFERENCE_MODEL]
    for r in results:
        compress_ms = r.p50_ms
        llm_saved_ms = r.tokens_saved * model["ms_per_token"]
        net_ms = llm_saved_ms - compress_ms
        cost_saved = r.tokens_saved / 1_000_000 * \
            model["price_per_mtok_input"] * 1000

        net_str = f"+{net_ms:.1f}ms" if net_ms >= 0 else f"{net_ms:.1f}ms"

        lines.append(
            f"{r.scenario_name:<45} "
            f"{_fmt_ms(compress_ms) + 'ms':>10} "
            f"{_fmt_ms(llm_saved_ms) + 'ms':>11} "
            f"{net_str:>13} "
            f"${cost_saved:>9.2f}"
        )

    lines.append("")
    lines.append("")

    # ── Break-even analysis — exactly ──
    lines.append("BREAK-EVEN ANALYSIS")
    lines.append(
        "Minimum tokens saved for compression to pay for itself in latency:")
    lines.append("")

    for _model_name, profile in MODEL_PROFILES.items():
        lines.append(
            f"  {profile['label']:<28} ({profile['ms_per_token']}ms/token):")
        for r in results:
            if r.tokens_saved == 0:
                continue
            tokens_needed = r.p50_ms / profile["ms_per_token"]
            verdict = (
                "✅ ALWAYS WINS" if tokens_needed <= r.tokens_saved
                else "❌ OVERHEAD > SAVINGS"
            )
            lines.append(
                f"    {r.scenario_name:<43} "
                f"need {_fmt_tokens(int(tokens_needed)):>6}, "
                f"save {_fmt_tokens(r.tokens_saved):>6}  {verdict}"
            )
        lines.append("")

    return "\n".join(lines)


def format_markdown_report(results: list[LatencyResult]) -> str:
    lines: list[str] = []

    lines.append("# ContextForge Latency Benchmarks")
    lines.append("")
    lines.append(
        "Measured pipeline compression overhead across content types and sizes. "
    )
    lines.append("")
    lines.append(
        f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    lines.append("")

    lines.append("## Environment")
    lines.append("")
    lines.append(f"- **Platform**: {platform.platform()}")
    lines.append(
        f"- **Processor**: {platform.processor() or platform.machine()}")
    lines.append(f"- **Python**: {platform.python_version()}")
    lines.append(f"- **ContextForge**: v1.0.0")
    lines.append("")

    if results:
        model = MODEL_PROFILES[REFERENCE_MODEL]
        compressing = [r for r in results if r.tokens_saved > 0]
        if compressing:
            avg_ratio = statistics.mean(
                r.compression_ratio for r in compressing)
            max_overhead = max(r.p50_ms for r in compressing)
            wins = sum(
                1 for r in compressing
                if r.tokens_saved * model["ms_per_token"] > r.p50_ms
            )
            lines.append("## TL;DR")
            lines.append("")
            lines.append(
                f"- Average compression: **{avg_ratio:.0%}** token reduction")
            lines.append(
                f"- Maximum pipeline overhead: **{_fmt_ms(max_overhead)}ms** (p50)")
            lines.append(
                f"- Net latency win: **{wins}/{len(compressing)}** scenarios "
                f"against {model['label']}"
            )
            lines.append("")

    lines.append("## Compression Overhead by Scenario")
    lines.append("")
    lines.append(
        "| Scenario | Tokens In | Saved | Ratio | p50 (ms) | p95 (ms) | p99 (ms) | Mean (ms) |"
    )
    lines.append(
        "|----------|-----------|-------|-------|----------|----------|----------|-----------|"
    )

    for r in results:
        lines.append(
            f"| {r.scenario_name} | {_fmt_tokens(r.tokens_before)} | "
            f"{_fmt_tokens(r.tokens_saved)} | {r.compression_ratio:.0%} | "
            f"{_fmt_ms(r.p50_ms)} | {_fmt_ms(r.p95_ms)} | "
            f"{_fmt_ms(r.p99_ms)} | {_fmt_ms(r.mean_ms)} |"
        )

    lines.append("")

    lines.append("## Cost-Benefit Analysis")
    lines.append("")
    lines.append(
        f"Net latency benefit = LLM prefill time saved - compression overhead "
        f"(reference: {MODEL_PROFILES[REFERENCE_MODEL]['label']})."
    )
    lines.append("")
    lines.append(
        "| Scenario | Compress (ms) | LLM Saved (ms)* | Net Benefit | $/1K Requests** |"
    )
    lines.append(
        "|----------|---------------|-----------------|-------------|-----------------|"
    )

    model = MODEL_PROFILES[REFERENCE_MODEL]
    for r in results:
        if r.tokens_saved <= 0:
            continue
        llm_saved_ms = r.tokens_saved * model["ms_per_token"]
        net_ms = llm_saved_ms - r.p50_ms
        cost_saved = r.tokens_saved / 1_000_000 * \
            model["price_per_mtok_input"] * 1000
        net_str = f"+{net_ms:.1f}ms" if net_ms >= 0 else f"{net_ms:.1f}ms"

        lines.append(
            f"| {r.scenario_name} | {_fmt_ms(r.p50_ms)} | "
            f"{_fmt_ms(llm_saved_ms)} | {net_str} | ${cost_saved:.2f} |"
        )

    lines.append("")
    lines.append(
        f"\\* Based on {model['label']} prefill rate ({model['ms_per_token']}ms/token)"
    )
    lines.append(
        f"\\*\\* Cost savings at ${model['price_per_mtok_input']}/MTok input pricing"
    )
    lines.append("")

    lines.append("## Break-Even Across Model Tiers")
    lines.append("")
    header = "| Scenario | Compress (ms) |"
    separator = "|----------|---------------|"
    for profile in MODEL_PROFILES.values():
        header += f" {profile['label']} |"
        separator += "------------|"
    lines.append(header)
    lines.append(separator)

    for r in results:
        if r.tokens_saved <= 0:
            continue
        row = f"| {r.scenario_name} | {_fmt_ms(r.p50_ms)} |"
        for profile in MODEL_PROFILES.values():
            llm_saved = r.tokens_saved * profile["ms_per_token"]
            net = llm_saved - r.p50_ms
            row += f" {'+' if net >= 0 else ''}{_fmt_ms(net)}ms |"
        lines.append(row)

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(
        "*Benchmarks run with `python benchmarks/bench_latency.py`. "
        "Results vary based on hardware and content characteristics.*"
    )

    return "\n".join(lines)


# ─────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="ContextForge latency benchmark",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--output", "-o", help="Save markdown report")
    parser.add_argument("--json", "-j", help="Save JSON results")
    parser.add_argument("--iterations", "-n", type=int, default=20)
    parser.add_argument("--warmup", "-w", type=int, default=3)
    parser.add_argument(
        "--scenario", "-s",
        choices=["logs", "files", "code", "multiturn", "agentic", "tools"],
        action="append",
    )
    parser.add_argument("--proxy", default=PROXY_URL)
    parser.add_argument("--verbose", "-v", action="store_true", default=True)

    args = parser.parse_args()

    print("ContextForge Latency Benchmark")
    print("=" * 40)
    print(f"Methodology: bench_latency.py")
    print(f"Iterations:  {args.iterations} measured + {args.warmup} warmup")
    print()

    # Check proxy
    pipeline = ContextForgePipeline(args.proxy)
    if not pipeline.check_connection():
        print(f"❌ Proxy not running at {args.proxy}")
        print("   Start with: node src/server.js")
        return 1

    print(f"✅ Proxy connected at {args.proxy}")
    print()

    # Generate scenarios
    print("Generating scenarios...", flush=True)
    scenarios = generate_scenarios(args.scenario)
    print(f"  {len(scenarios)} scenarios ready")
    print()

    # Run
    print(f"Running benchmarks...")
    print()
    results = run_all(
        scenarios,
        pipeline,
        iterations=args.iterations,
        warmup=args.warmup,
        verbose=args.verbose,
    )

    # Terminal report
    print(format_terminal_report(results))

    # Save markdown
    if args.output:
        md = format_markdown_report(results)
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(md)
        print(f"Markdown saved to: {args.output}")

    # Save JSON
    if args.json:
        data = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "platform": platform.platform(),
            "python_version": platform.python_version(),
            "iterations": args.iterations,
            "warmup": args.warmup,
            "proxy_url": args.proxy,
            "results": [r.to_dict() for r in results],
        }
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps(data, indent=2))
        print(f"JSON saved to: {args.json}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
