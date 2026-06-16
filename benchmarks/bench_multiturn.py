"""
Multi-turn deduplication benchmark.

Demonstrates ContextForge's stateful vault + stub architecture across
multiple turns reading the same file.

Architecture being tested:
  Turn 1: File sent → Fat Catch vaults content → stub injected on wire
           Tool schemas (contextforge_retrieve, graph) added to session
  Turn 2+: Identical file detected by SimHash registry → exact duplicate
            stub replaces full content → near-zero wire tokens

This is a "Vault + Stub" architecture, not lossy inline compression.
The full content is always retrievable via Ghost Interceptor.

Baseline comparison: Standard stateless API usage (no proxy, full content
every turn) vs ContextForge stateful proxy.
"""

from __future__ import annotations

import sys
import requests
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from benchmarks.scenarios.tool_outputs import count_tokens


@dataclass
class MultiTurnResult:
    turn: int
    approach: str
    tokens_sent: int
    tokens_saved_this_turn: int
    tokens_saved_cumulative: int
    compression_ratio: float
    note: str = ""


def simulate_stateless_baseline(
    file_content: str,
    n_turns: int,
) -> list[MultiTurnResult]:
    """
    Baseline: standard stateless API usage.

    Represents a caller that sends the full file content on every turn
    with no proxy, no dedup, no vault — exactly what any LLM API call
    looks like without a compression layer.
    """
    file_tokens = count_tokens(file_content)
    results = []

    for turn in range(1, n_turns + 1):
        results.append(MultiTurnResult(
            turn=turn,
            approach="stateless_baseline",
            tokens_sent=file_tokens,
            tokens_saved_this_turn=0,
            tokens_saved_cumulative=0,
            compression_ratio=0.0,
            note="full content sent every turn",
        ))

    return results


def simulate_contextforge_dedup(
    file_content: str,
    n_turns: int,
    proxy_url: str = "http://localhost:3000",
) -> list[MultiTurnResult]:
    """
    ContextForge stateful vault + stub benchmark.

    Sends N consecutive requests through the proxy's dry-run pipeline.
    The SimHash registry tracks content across turns and deduplicates.

    Turn 1 mechanics:
      - Fat Catch vaults the file content (threshold=15k chars)
      - contextforge_retrieve tool schema injected into payload
      - Graph tool schema injected into payload
      - Wire token count is HIGHER than file alone due to tool tax
      - This overhead is a one-time session establishment cost

    Turn 2+ mechanics:
      - SimHash detects exact duplicate content
      - Full file content replaced by a ~20-token stub reference
      - Tool schemas already cached — minimizer skips rebuild
      - Wire tokens drop dramatically vs baseline
    """
    file_tokens = count_tokens(file_content)
    results = []
    cumulative_saved = 0
    session = requests.Session()

    for turn in range(1, n_turns + 1):
        payload = {
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 1,
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": f"Turn {turn}: Read and analyze this file.",
                },
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": f"call_bench_{turn:03d}",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": '{"path": "src/stage.js"}',
                        },
                    }],
                },
                {
                    "role": "tool",
                    "tool_call_id": f"call_bench_{turn:03d}",
                    "name": "read_file",
                    "content": file_content,
                    "_filename": "src/stage.js",
                },
            ],
        }

        try:
            resp = session.post(
                f"{proxy_url}/v1/messages",
                json=payload,
                headers={
                    "content-type": "application/json",
                    "anthropic-version": "2023-06-01",
                    "x-api-key": "benchmark",
                    "x-cf-dry-run": "true",    # real pipeline, no LLM cost
                },
                timeout=15,
            )
            data = resp.json()

            tokens_after = data.get("tokens_after", file_tokens)

            # Savings are measured against the stateless baseline (full file
            # every turn). If Turn 1 has overhead, saved_this_turn may be
            # negative — this is correct and expected (tool tax).
            saved_this_turn = file_tokens - tokens_after

        except Exception as e:
            print(f"  ⚠️  Proxy failed on turn {turn}: {e}")
            tokens_after   = file_tokens
            saved_this_turn = 0

        cumulative_saved += saved_this_turn

        # ── Determine note for this turn ──
        if turn == 1 and tokens_after > file_tokens:
            note = (
                f"Turn 1 tool tax: +{tokens_after - file_tokens:,} tokens "
                f"(contextforge_retrieve + graph schemas injected)"
            )
        elif turn == 1:
            note = "Turn 1: vaulted, tool schemas injected"
        elif saved_this_turn > 0:
            ratio = saved_this_turn / file_tokens
            note = f"exact duplicate stub ({ratio:.0%} saved)"
        else:
            note = "passthrough"

        results.append(MultiTurnResult(
            turn=turn,
            approach="contextforge_vault_stub",
            tokens_sent=tokens_after,
            tokens_saved_this_turn=saved_this_turn,
            tokens_saved_cumulative=cumulative_saved,
            compression_ratio=max(0.0, saved_this_turn / file_tokens)
                if file_tokens > 0 else 0.0,
            note=note,
        ))

    return results


def run_multiturn_benchmark(
    n_turns: int = 8,
    proxy_url: str = "http://localhost:3000",
) -> dict:
    """
    Compare multi-turn token usage:
      - Stateless baseline: full file content every turn
      - ContextForge vault + stub: stateful dedup registry
    """

    print("\n" + "=" * 70)
    print("MULTI-TURN DEDUPLICATION BENCHMARK")
    print("Architecture: Vault + Stub (not lossy inline compression)")
    print("=" * 70)

    # ~300 lines, ~1200 tokens — representative mid-size source file
    file_content = "\n".join([
        "export function stage1(payload) {",
        "  // Stage 1 implementation",
        "  return payload;",
        "}",
        "",
    ] * 60)

    file_tokens = count_tokens(file_content)

    print(f"\nFile: src/stage.js")
    print(f"Size: {file_tokens:,} tokens ({len(file_content):,} chars)")
    print(f"Turns: {n_turns}")
    print()
    print("Architecture notes:")
    print("  Turn 1 — File vaulted. Tool schemas (retrieve + graph) injected.")
    print("           Wire token count may EXCEED file size due to tool tax.")
    print("           This overhead is a one-time session establishment cost.")
    print("  Turn 2+ — SimHash detects exact duplicate. Stub replaces full")
    print("            content. Original always retrievable via Ghost Interceptor.")

    baseline = simulate_stateless_baseline(file_content, n_turns)
    cf_dedup  = simulate_contextforge_dedup(file_content, n_turns, proxy_url)

    print(f"\n{'Turn':<6} {'Baseline':>10} {'CF Proxy':>10} {'Saved':>8} "
          f"{'Cumulative':>12}  Note")
    print("-" * 80)

    for nd, cf in zip(baseline, cf_dedup):
        saved_str = (
            f"{cf.tokens_saved_this_turn:>+8,}"
            if cf.tokens_saved_this_turn < 0
            else f"{cf.tokens_saved_this_turn:>8,}"
        )
        print(
            f"  {nd.turn:<4} "
            f"{nd.tokens_sent:>9,} "
            f"{cf.tokens_sent:>9,} "
            f"{saved_str} "
            f"{cf.tokens_saved_cumulative:>11,}  "
            f"{cf.note}"
        )

    total_baseline = sum(r.tokens_sent for r in baseline)
    total_cf       = sum(r.tokens_sent for r in cf_dedup)
    total_saved    = total_baseline - total_cf
    net_ratio      = total_saved / total_baseline if total_baseline > 0 else 0.0

    print(f"\n{'TOTAL':<6} {total_baseline:>9,} {total_cf:>9,} "
          f"{total_saved:>8,}")

    print()
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print()
    print(f"  Stateless baseline total:    {total_baseline:>10,} tokens")
    print(f"  ContextForge proxy total:    {total_cf:>10,} tokens")
    print(f"  Net tokens saved:            {total_saved:>10,} tokens ({net_ratio:.1%})")
    print()
    print("  How savings are achieved:")
    print("  ┌─ Turn 1: Content vaulted to local SQLite store.")
    print("  │          Stub reference (~20 tokens) sent on wire.")
    print("  │          Tool schemas add one-time overhead (~200-400 tokens).")
    print("  └─ Turn 2+: SimHash registry detects identical content (distance=0).")
    print("             Full content replaced by stub. Vault always readable")
    print("             via Ghost Interceptor — zero information loss.")
    print()
    print("  This is lossless Vault + Stub architecture, not text summarization.")
    print("  The LLM can always retrieve the original file on demand.")
    print()

    # ── Turn 1 overhead callout ──
    if cf_dedup and cf_dedup[0].tokens_sent > file_tokens:
        overhead = cf_dedup[0].tokens_sent - file_tokens
        print(f"  ⚠️  Turn 1 tool tax: {overhead:,} extra tokens")
        print(f"     These are tool schema injections (contextforge_retrieve,")
        print(f"     graph query tool) required to establish the stateful session.")
        print(f"     This cost is amortized across all subsequent turns.")
        if n_turns > 1:
            amortized = total_saved / (n_turns - 1) if n_turns > 1 else 0
            print(f"     Amortized savings (turns 2–{n_turns}): "
                  f"~{amortized:,.0f} tokens/turn")
        print()

    return {
        "file_tokens":               file_tokens,
        "n_turns":                   n_turns,
        "total_tokens_baseline":     total_baseline,
        "total_tokens_contextforge": total_cf,
        "total_tokens_saved":        total_saved,
        "net_savings_ratio":         net_ratio,
        "turn1_tool_tax": max(
            0, cf_dedup[0].tokens_sent - file_tokens
        ) if cf_dedup else 0,
        "per_turn": [
            {
                "turn":              cf.turn,
                "baseline_tokens":   nd.tokens_sent,
                "cf_tokens":         cf.tokens_sent,
                "saved_this_turn":   cf.tokens_saved_this_turn,
                "cumulative_saved":  cf.tokens_saved_cumulative,
                "note":              cf.note,
            }
            for nd, cf in zip(baseline, cf_dedup)
        ],
    }


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description="ContextForge multi-turn deduplication benchmark"
    )
    parser.add_argument("--turns", "-n", type=int, default=8,
                        help="Number of turns to simulate (default: 8)")
    parser.add_argument("--proxy", default="http://localhost:3000",
                        help="Proxy URL (default: http://localhost:3000)")
    parser.add_argument("--output", "-o",
                        help="Save JSON results to file")
    args = parser.parse_args()

    results = run_multiturn_benchmark(n_turns=args.turns, proxy_url=args.proxy)

    if args.output:
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2)
        print(f"Results saved to {args.output}")