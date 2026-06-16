#!/usr/bin/env python3
"""
bench_adversarial_realworld.py

Adversarial benchmark — messy, unstructured real-world data.

Tests the Content Router and Fat Catch thresholds on realistic noise:
  Scenario A: Massive git log -p output (hundreds of commits + inline diffs)
  Scenario B: Raw grep -rn output (multiple directories, context lines)
  Scenario C: Chaotic production log (Java Spring + Nginx + Kubernetes interleaved)

Usage:
    python benchmarks/bench_adversarial_realworld.py
    python benchmarks/bench_adversarial_realworld.py --proxy http://localhost:3000
    python benchmarks/bench_adversarial_realworld.py --timeout 10
"""

from __future__ import annotations

import argparse
import random
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import requests

_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from benchmarks.scenarios.tool_outputs import count_tokens

PROXY_URL = "http://localhost:3000"
random.seed(42)


# ─────────────────────────────────────────────
# Result type
# ─────────────────────────────────────────────

@dataclass
class AdversarialResult:
    scenario: str
    tokens_before: int
    tokens_after: int
    compression_ratio: float
    pipeline_ms: float
    chars: int
    passed: bool
    note: str = ""
    error: str = ""


# ─────────────────────────────────────────────
# Proxy client
# ─────────────────────────────────────────────

def send_dry_run(
    content: str,
    tool_name: str = "bash",
    proxy_url: str = PROXY_URL,
    timeout: float = 30.0,
) -> dict:
    """
    Send content through the pipeline in dry-run mode.
    Returns the raw proxy JSON response.
    """
    call_id = f"call_{uuid.uuid4().hex[:8]}"
    payload = {
        "model": "claude-3-5-sonnet-20241022",
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
                        "arguments": '{"command": "benchmark"}',
                    },
                }],
            },
            {
                "role": "tool",
                "tool_call_id": call_id,
                "name": tool_name,
                "content": content,
            },
        ],
    }

    resp = requests.post(
        f"{proxy_url}/v1/messages",
        json=payload,
        headers={
            "content-type": "application/json",
            "x-api-key": "benchmark",
            "anthropic-version": "2023-06-01",
            "x-cf-dry-run": "true",
        },
        timeout=timeout,
    )
    return resp.json()


def run_scenario(
    name: str,
    content: str,
    tool_name: str,
    proxy_url: str,
    timeout: float,
) -> AdversarialResult:
    """Run a single scenario and return structured result."""
    tokens_before = count_tokens(content)
    chars = len(content)

    start = time.perf_counter()
    try:
        data = send_dry_run(content, tool_name, proxy_url, timeout)
        wall_ms = (time.perf_counter() - start) * 1000

        if data.get("type") == "error" or "error" in data:
            return AdversarialResult(
                scenario=name,
                tokens_before=tokens_before,
                tokens_after=tokens_before,
                compression_ratio=0.0,
                pipeline_ms=wall_ms,
                chars=chars,
                passed=False,
                error=str(data.get("error", data)),
            )

        tokens_after  = data.get("tokens_after",  tokens_before)
        pipeline_ms   = data.get("pipeline_ms",   wall_ms)
        compression   = 1.0 - (tokens_after / tokens_before) if tokens_before > 0 else 0.0

        return AdversarialResult(
            scenario=name,
            tokens_before=tokens_before,
            tokens_after=tokens_after,
            compression_ratio=compression,
            pipeline_ms=pipeline_ms,
            chars=chars,
            passed=True,
            note=_describe_result(chars, compression, tokens_before, tokens_after),
        )

    except requests.exceptions.Timeout:
        wall_ms = (time.perf_counter() - start) * 1000
        return AdversarialResult(
            scenario=name,
            tokens_before=tokens_before,
            tokens_after=tokens_before,
            compression_ratio=0.0,
            pipeline_ms=wall_ms,
            chars=chars,
            passed=False,
            error=f"TIMEOUT after {timeout:.0f}s — possible infinite loop in pipeline",
        )
    except Exception as e:
        wall_ms = (time.perf_counter() - start) * 1000
        return AdversarialResult(
            scenario=name,
            tokens_before=tokens_before,
            tokens_after=tokens_before,
            compression_ratio=0.0,
            pipeline_ms=wall_ms,
            chars=chars,
            passed=False,
            error=str(e),
        )


def _describe_result(
    chars: int,
    ratio: float,
    tokens_before: int,
    tokens_after: int,
) -> str:
    if chars > 15_000 and ratio > 0.85:
        return "Fat Catch vaulted"
    elif ratio > 0.5:
        return "pipeline compressed"
    elif ratio > 0.0:
        return "light compression"
    elif tokens_after > tokens_before:
        return f"negative compression (+{tokens_after - tokens_before} tool tax)"
    else:
        return "passthrough"


# ─────────────────────────────────────────────
# Scenario A: Massive git log -p output
# ─────────────────────────────────────────────

def generate_git_log_output(n_commits: int = 80) -> str:
    """
    Simulate `git log -p` output with N commits, each containing
    realistic commit metadata and inline unified diffs.

    Adversarial properties:
      - Mixes structured (diff headers) and unstructured (commit messages)
      - Contains @@-markers, +/- prefixes, binary file notices
      - Huge volume — realistic git log can be 100k+ chars
    """
    files = [
        "src/server.js",
        "src/helper.js",
        "src/compression/astCompressor.js",
        "src/proxy/compressionDecision.js",
        "src/logging/cacheDb.js",
        "src/memory/memoryHandler.js",
        "benchmarks/bench_compression.py",
        "README.md",
        "package.json",
    ]

    authors = [
        "Alice Chen <alice@example.com>",
        "Bob Kumar <bob@example.com>",
        "Carol White <carol@example.com>",
        "Dave Singh <dave@example.com>",
    ]

    commit_messages = [
        "fix: resolve race condition in vault retrieval",
        "feat: add SimHash near-duplicate detection",
        "refactor: extract compression policy to separate module",
        "perf: cache tool schema minimization results",
        "fix: handle empty tool result content gracefully",
        "feat: implement Ghost Interceptor retry loop",
        "chore: update dependencies",
        "fix: correct token count estimation for unicode",
        "feat: add predictive injection for error patterns",
        "refactor: move Fat Catch threshold to policy config",
        "test: add regression suite for vault round-trip",
        "fix: prevent double-vaulting on retry",
        "perf: use BM25 sparse index for hybrid retrieval",
        "feat: expose /v1/vault/:id read endpoint",
        "fix: CCR session workspace hash collision",
    ]

    chunks = []
    base_sha = 0xA1B2C3D4E5

    for i in range(n_commits):
        sha      = format(base_sha + i, "010x")
        parent   = format(base_sha + i - 1, "010x")
        author   = random.choice(authors)
        message  = random.choice(commit_messages)
        file_a   = random.choice(files)
        file_b   = random.choice(files)
        day      = random.randint(1, 28)
        hour     = random.randint(0, 23)
        minute   = random.randint(0, 59)

        n_added   = random.randint(2, 25)
        n_removed = random.randint(1, 15)
        hunk_start = random.randint(10, 500)

        # Commit header
        chunks.append(
            f"commit {sha}\n"
            f"Author: {author}\n"
            f"Date:   Mon Jan {day:02d} {hour:02d}:{minute:02d}:00 2025 +0000\n"
            f"\n"
            f"    {message}\n"
            f"\n"
            f"    Signed-off-by: {author}\n"
        )

        # Diff for file_a
        chunks.append(
            f"diff --git a/{file_a} b/{file_a}\n"
            f"index {sha[:7]}..{parent[:7]} 100644\n"
            f"--- a/{file_a}\n"
            f"+++ b/{file_a}\n"
            f"@@ -{hunk_start},{n_removed + 3} +{hunk_start},{n_added + 3} @@\n"
        )
        for _ in range(3):
            chunks.append(f" const ctx_{random.randint(1000,9999)} = getContext();\n")
        for _ in range(n_removed):
            chunks.append(f"-  const old_{random.randint(1000,9999)} = processLegacy();\n")
        for _ in range(n_added):
            chunks.append(
                f"+  const new_{random.randint(1000,9999)} = "
                f"processModern(payload_{random.randint(100,999)});\n"
            )

        # Occasionally add a binary file notice
        if i % 12 == 0:
            chunks.append(
                f"\ndiff --git a/assets/icon_{i}.png b/assets/icon_{i}.png\n"
                f"Binary files a/assets/icon_{i}.png and b/assets/icon_{i}.png differ\n"
            )

        chunks.append("\n")

    return "".join(chunks)


# ─────────────────────────────────────────────
# Scenario B: Raw grep -rn output
# ─────────────────────────────────────────────

def generate_grep_output(n_matches: int = 600) -> str:
    """
    Simulate `grep -rn 'TODO\|FIXME\|HACK' --include='*.js' -A 2 -B 1 .`

    Adversarial properties:
      - Interleaved file paths, line numbers, context lines
      - Separator lines (--) between match groups
      - Highly repetitive structure confuses content router
      - No clear semantic structure for the pruner
    """
    files = [
        "src/server.js",
        "src/helper.js",
        "src/compression/astCompressor.js",
        "src/compression/semanticDedup.js",
        "src/proxy/compressionDecision.js",
        "src/proxy/stageTimer.js",
        "src/logging/cacheDb.js",
        "src/memory/memoryHandler.js",
        "src/memory/embedder.js",
        "src/graph/workspaceMapper.js",
        "src/graph/graphTools.js",
        "src/ccr/index.js",
        "src/vaultRetriever.js",
    ]

    tags = ["TODO", "FIXME", "HACK", "XXX", "OPTIMIZE", "REVIEW"]

    comments = [
        "handle the edge case where vault returns null",
        "this needs proper error handling",
        "refactor when we have time",
        "temporary workaround for upstream bug",
        "measure actual token count instead of char estimate",
        "add retry logic here",
        "consolidate with similar function in helper.js",
        "this regex is too greedy, needs tightening",
        "consider using WeakMap to avoid memory leak",
        "async version of this needs proper cancellation",
        "validate input before passing to native module",
        "the timeout here is arbitrary — needs profiling",
    ]

    context_before = [
        "const result = await processPayload(msg);",
        "if (!payload.messages || !Array.isArray(payload.messages)) return payload;",
        "const tokens = countTokens(content);",
        "for (const msg of payload.messages) {",
        "try {",
    ]

    context_after = [
        "  return { kept: text, vaulted: false };",
        "  const vaultId = saveToVault(text);",
        "  console.log(`[Stage] processed ${tokens} tokens`);",
        "}",
        "} catch (err) { console.error(err.message); }",
    ]

    lines = []
    for i in range(n_matches):
        f       = random.choice(files)
        lineno  = random.randint(10, 2000)
        tag     = random.choice(tags)
        comment = random.choice(comments)

        # Context before (1 line with -B 1)
        lines.append(f"{f}-{lineno - 1}-{random.choice(context_before)}")
        # Match line
        lines.append(f"{f}:{lineno}:  // {tag}: {comment}")
        # Context after (2 lines with -A 2)
        lines.append(f"{f}-{lineno + 1}-{random.choice(context_after)}")
        lines.append(f"{f}-{lineno + 2}-{random.choice(context_after)}")
        # Group separator
        lines.append("--")

    return "\n".join(lines)


# ─────────────────────────────────────────────
# Scenario C: Chaotic interleaved production log
# ─────────────────────────────────────────────

def generate_chaotic_production_log(n_entries: int = 400) -> str:
    """
    Interleave Java Spring stack traces, Nginx access logs,
    and Kubernetes pod eviction warnings — as they would appear
    if you ran `kubectl logs -f --all-containers=true` on a mixed pod.

    Adversarial properties:
      - Three completely different log formats in one stream
      - Stack traces span multiple lines (breaks line-based parsers)
      - High noise ratio — most lines are irrelevant
      - Random ordering defeats time-based pruning heuristics
    """
    lines = []

    def java_error() -> list[str]:
        errors = [
            "org.springframework.dao.DataAccessException: Unable to acquire JDBC Connection",
            "java.lang.NullPointerException: Cannot invoke method on null reference",
            "com.example.service.PaymentService: Transaction rolled back due to timeout",
            "org.hibernate.exception.JDBCConnectionException: Could not open connection",
        ]
        classes = [
            "com.example.api.UserController",
            "com.example.service.PaymentService",
            "com.example.repository.OrderRepository",
            "org.springframework.web.servlet.DispatcherServlet",
        ]
        err = random.choice(errors)
        result = [
            f"2025-01-15 {random.randint(10,23):02d}:{random.randint(0,59):02d}:"
            f"{random.randint(0,59):02d}.{random.randint(100,999)} ERROR "
            f"[http-nio-8080-exec-{random.randint(1,20)}] "
            f"{random.choice(classes)} - {err}"
        ]
        for j in range(random.randint(3, 8)):
            cls = random.choice(classes)
            method = random.choice(["processRequest", "handleGet", "save", "findById"])
            lineno = random.randint(10, 500)
            result.append(f"    at {cls}.{method}({cls.split('.')[-1]}.java:{lineno})")
        if random.random() > 0.5:
            result.append(
                f"Caused by: java.sql.SQLException: "
                f"Timeout waiting for connection from pool after {random.randint(5, 30)}s"
            )
        return result

    def nginx_line() -> str:
        methods  = ["GET", "POST", "PUT", "DELETE", "PATCH"]
        paths    = [
            "/api/v2/users", "/api/v2/orders", "/api/v2/payments",
            "/health", "/metrics", "/api/v1/legacy",
        ]
        statuses = [200, 200, 200, 201, 400, 401, 403, 404, 500, 502]
        ip       = f"10.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}"
        method   = random.choice(methods)
        path     = random.choice(paths)
        status   = random.choice(statuses)
        size     = random.randint(100, 50000)
        ms       = random.randint(1, 5000)
        return (
            f'{ip} - - [15/Jan/2025:{random.randint(10,23):02d}:'
            f'{random.randint(0,59):02d}:{random.randint(0,59):02d} +0000] '
            f'"{method} {path} HTTP/1.1" {status} {size} "-" '
            f'"Mozilla/5.0" rt={ms / 1000:.3f}'
        )

    def k8s_event() -> str:
        events = [
            ("Warning", "FailedScheduling",
             f"pod/api-server-{uuid.uuid4().hex[:8]}",
             "0/3 nodes are available: 3 Insufficient memory"),
            ("Warning", "Evicted",
             f"pod/worker-{uuid.uuid4().hex[:8]}",
             "The node was low on resource: memory. Threshold quantity: 100Mi"),
            ("Normal", "Pulled",
             f"pod/redis-{uuid.uuid4().hex[:8]}",
             'Successfully pulled image "redis:7.0" in 2.3s'),
            ("Warning", "BackOff",
             f"pod/cronjob-{uuid.uuid4().hex[:8]}",
             "Back-off restarting failed container"),
            ("Warning", "NodeNotReady",
             f"node/node-{random.randint(1,5)}",
             "Node status is now: NodeNotReady"),
        ]
        ns     = random.choice(["default", "kube-system", "monitoring", "production"])
        age    = f"{random.randint(1, 120)}m"
        etype, reason, obj, msg = random.choice(events)
        return f"{ns:<12} {age:<10} {etype:<8} {reason:<22} {obj:<45} {msg}"

    log_type_weights = [0.3, 0.5, 0.2]   # java, nginx, k8s

    for _ in range(n_entries):
        choice = random.random()
        if choice < log_type_weights[0]:
            lines.extend(java_error())
        elif choice < log_type_weights[0] + log_type_weights[1]:
            lines.append(nginx_line())
        else:
            lines.append(k8s_event())

    return "\n".join(lines)


# ─────────────────────────────────────────────
# Report
# ─────────────────────────────────────────────

def print_report(results: list[AdversarialResult]) -> None:
    print("\n" + "=" * 80)
    print("  ADVERSARIAL BENCHMARK — REAL-WORLD DATA")
    print("  Testing Content Router and Fat Catch on realistic noise")
    print("=" * 80)

    print(
        f"\n  {'Scenario':<38} {'Chars':>8} {'Tok Before':>10} "
        f"{'Tok After':>10} {'Ratio':>7} {'Pipeline':>10}  Status"
    )
    print("  " + "-" * 95)

    for r in results:
        status = "✓" if r.passed else "✗"
        ratio_str = f"{r.compression_ratio:.1%}" if r.passed else "ERROR"
        print(
            f"  {r.scenario:<38} "
            f"{r.chars:>8,} "
            f"{r.tokens_before:>10,} "
            f"{r.tokens_after:>10,} "
            f"{ratio_str:>7} "
            f"{r.pipeline_ms:>8.1f}ms  "
            f"{status}"
        )
        if r.note:
            print(f"  {'':38} → {r.note}")
        if r.error:
            print(f"  {'':38} ❌ {r.error}")

    print()
    passed = sum(1 for r in results if r.passed)
    print(f"  Scenarios: {passed}/{len(results)} completed without error or timeout")

    if all(r.passed for r in results):
        print("\n  ✅ All real-world adversarial scenarios handled gracefully")
    else:
        failed = [r.scenario for r in results if not r.passed]
        print(f"\n  ❌ Failed: {', '.join(failed)}")

    print()
    print("  Architecture observations:")
    for r in results:
        if r.passed:
            if r.chars > 15_000 and r.compression_ratio > 0.85:
                print(
                    f"  • {r.scenario}: Fat Catch fired correctly "
                    f"({r.tokens_before:,} → {r.tokens_after:,} tokens)"
                )
            elif r.compression_ratio > 0.3:
                print(
                    f"  • {r.scenario}: Pipeline compressed "
                    f"({r.compression_ratio:.0%} reduction)"
                )
            else:
                print(
                    f"  • {r.scenario}: Low compression ({r.compression_ratio:.0%}) "
                    f"— content may lack compressible structure"
                )
    print()


# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Adversarial benchmark — real-world messy data"
    )
    parser.add_argument("--proxy",   default=PROXY_URL)
    parser.add_argument("--timeout", type=float, default=30.0,
                        help="Per-scenario timeout in seconds (default: 30)")
    parser.add_argument("--output",  "-o", help="Save JSON results to file")
    args = parser.parse_args()

    # Connection check
    try:
        requests.get(f"{args.proxy}/dashboard", timeout=2)
    except Exception:
        print(f"❌ Proxy not running at {args.proxy}")
        print("   Start with: node src/server.js")
        return 1

    print(f"✅ Proxy connected at {args.proxy}")
    print(f"   Timeout per scenario: {args.timeout}s\n")

    scenarios = [
        (
            "A: git log -p (80 commits)",
            lambda: generate_git_log_output(n_commits=80),
            "git",
        ),
        (
            "A: git log -p (200 commits)",
            lambda: generate_git_log_output(n_commits=200),
            "git",
        ),
        (
            "B: grep -rn (600 matches)",
            lambda: generate_grep_output(n_matches=600),
            "grep",
        ),
        (
            "B: grep -rn (1500 matches)",
            lambda: generate_grep_output(n_matches=1500),
            "grep",
        ),
        (
            "C: Chaotic prod log (400 entries)",
            lambda: generate_chaotic_production_log(n_entries=400),
            "bash",
        ),
        (
            "C: Chaotic prod log (1000 entries)",
            lambda: generate_chaotic_production_log(n_entries=1000),
            "bash",
        ),
    ]

    results: list[AdversarialResult] = []

    for name, generator, tool_name in scenarios:
        print(f"  Generating {name}...", end=" ", flush=True)
        content = generator()
        print(f"{len(content):,} chars", end=" → ", flush=True)

        result = run_scenario(name, content, tool_name, args.proxy, args.timeout)
        results.append(result)

        if result.passed:
            print(f"{result.compression_ratio:.1%} compression in {result.pipeline_ms:.0f}ms")
        else:
            print(f"FAILED: {result.error[:60]}")

    print_report(results)

    if args.output:
        import json
        data = {
            "benchmark": "bench_adversarial_realworld",
            "proxy_url": args.proxy,
            "timeout_s": args.timeout,
            "results": [
                {
                    "scenario":          r.scenario,
                    "chars":             r.chars,
                    "tokens_before":     r.tokens_before,
                    "tokens_after":      r.tokens_after,
                    "compression_ratio": r.compression_ratio,
                    "pipeline_ms":       r.pipeline_ms,
                    "passed":            r.passed,
                    "note":              r.note,
                    "error":             r.error,
                }
                for r in results
            ],
        }
        with open(args.output, "w") as f:
            json.dump(data, f, indent=2)
        print(f"Results saved to {args.output}")

    failed = sum(1 for r in results if not r.passed)
    return failed


if __name__ == "__main__":
    sys.exit(main())