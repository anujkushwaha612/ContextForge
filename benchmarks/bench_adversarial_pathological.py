#!/usr/bin/env python3
"""
bench_adversarial_pathological.py

Adversarial benchmark — hostile data designed to break parsers.

Tests pipeline behavior with inputs that target specific architectural
components with worst-case data:

  Scenario A: Deeply Nested JSON (150 levels deep)
              Target: JSON Slicer recursive descent
              Goal:   Hit max recursion depth or timeout

  Scenario B: Extreme Minified Code (50,000 chars, single line)
              Target: C++ Tree-sitter AST Compressor
              Goal:   Hang, crash, or gracefully skip on
                      a horizontally massive syntax tree

  Scenario C: Binary/Hex Dump (10,000 lines of base64 + hex)
              Target: Content Router binary detection
              Goal:   Immediate Fat Catch vault without
                      attempting semantic analysis

Usage:
    python benchmarks/bench_adversarial_pathological.py
    python benchmarks/bench_adversarial_pathological.py --proxy http://localhost:3000
    python benchmarks/bench_adversarial_pathological.py --timeout 10
"""

from __future__ import annotations

import argparse
import base64
import json
import os
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
class PathologicalResult:
    scenario: str
    chars: int
    tokens_before: int
    tokens_after: int
    compression_ratio: float
    pipeline_ms: float
    passed: bool
    timed_out: bool = False
    crashed: bool = False
    note: str = ""
    error: str = ""
    architectural_finding: str = ""


# ─────────────────────────────────────────────
# Proxy helper
# ─────────────────────────────────────────────

def send_dry_run(
    content: str,
    tool_name: str = "bash",
    filename: str | None = None,
    cf_type: str | None = None,
    proxy_url: str = PROXY_URL,
    timeout: float = 10.0,
) -> dict:
    """
    Send content through the pipeline in dry-run mode.
    Tight timeout by default — pathological inputs may hang the pipeline.
    """
    call_id = f"call_{uuid.uuid4().hex[:8]}"

    tool_msg: dict = {
        "role": "tool",
        "tool_call_id": call_id,
        "name": tool_name,
        "content": content,
    }
    if filename:
        tool_msg["_filename"] = filename
    if cf_type:
        tool_msg["_cf_type"] = cf_type

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
            tool_msg,
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
    filename: str | None = None,
    cf_type: str | None = None,
    expected_behavior: str = "",
) -> PathologicalResult:
    """
    Run a single pathological scenario.

    Wraps the proxy call in a tight timeout to catch infinite loops.
    Distinguishes between timeout, crash, and graceful handling.
    """
    tokens_before = count_tokens(content)
    chars = len(content)

    start = time.perf_counter()
    try:
        data = send_dry_run(
            content,
            tool_name=tool_name,
            filename=filename,
            cf_type=cf_type,
            proxy_url=proxy_url,
            timeout=timeout,
        )
        wall_ms = (time.perf_counter() - start) * 1000

        if data.get("type") == "error" or "error" in data:
            return PathologicalResult(
                scenario=name,
                chars=chars,
                tokens_before=tokens_before,
                tokens_after=tokens_before,
                compression_ratio=0.0,
                pipeline_ms=wall_ms,
                passed=False,
                crashed=True,
                error=str(data.get("error", data))[:200],
                architectural_finding=(
                    f"Pipeline returned error response — "
                    f"check proxy logs for stage that threw. "
                    f"Expected: {expected_behavior}"
                ),
            )

        tokens_after = data.get("tokens_after",  tokens_before)
        pipeline_ms  = data.get("pipeline_ms",   wall_ms)
        compression  = (
            1.0 - (tokens_after / tokens_before)
            if tokens_before > 0 else 0.0
        )

        note = _classify_result(chars, compression, tokens_before, tokens_after)
        finding = _derive_finding(
            name, chars, compression, tokens_before,
            tokens_after, pipeline_ms, expected_behavior,
        )

        return PathologicalResult(
            scenario=name,
            chars=chars,
            tokens_before=tokens_before,
            tokens_after=tokens_after,
            compression_ratio=compression,
            pipeline_ms=pipeline_ms,
            passed=True,
            note=note,
            architectural_finding=finding,
        )

    except requests.exceptions.Timeout:
        wall_ms = (time.perf_counter() - start) * 1000
        return PathologicalResult(
            scenario=name,
            chars=chars,
            tokens_before=tokens_before,
            tokens_after=tokens_before,
            compression_ratio=0.0,
            pipeline_ms=wall_ms,
            passed=False,
            timed_out=True,
            error=f"TIMEOUT after {timeout:.0f}s",
            architectural_finding=(
                f"⚠️  Pipeline hung for >{timeout:.0f}s. "
                f"Likely infinite loop in recursive stage. "
                f"Expected: {expected_behavior}"
            ),
        )
    except Exception as e:
        wall_ms = (time.perf_counter() - start) * 1000
        return PathologicalResult(
            scenario=name,
            chars=chars,
            tokens_before=tokens_before,
            tokens_after=tokens_before,
            compression_ratio=0.0,
            pipeline_ms=wall_ms,
            passed=False,
            crashed=True,
            error=str(e)[:200],
            architectural_finding=(
                f"Pipeline threw exception: {type(e).__name__}. "
                f"Expected: {expected_behavior}"
            ),
        )


def _classify_result(
    chars: int,
    ratio: float,
    tokens_before: int,
    tokens_after: int,
) -> str:
    if chars > 15_000 and ratio > 0.85:
        return "Fat Catch vaulted — correct"
    elif tokens_after > tokens_before:
        return f"negative compression (+{tokens_after - tokens_before} tool tax)"
    elif ratio > 0.5:
        return "pipeline compressed"
    elif ratio > 0.0:
        return "light compression"
    else:
        return "passthrough"


def _derive_finding(
    name: str,
    chars: int,
    ratio: float,
    tokens_before: int,
    tokens_after: int,
    pipeline_ms: float,
    expected: str,
) -> str:
    if "JSON" in name:
        if pipeline_ms > 5000:
            return (
                f"⚠️  JSON Slicer took {pipeline_ms:.0f}ms — "
                f"possible recursion slowdown on 150-level nesting"
            )
        elif ratio > 0.5:
            return (
                f"✅ JSON Slicer handled 150-level nesting in {pipeline_ms:.0f}ms "
                f"({ratio:.0%} compression)"
            )
        else:
            return (
                f"✅ JSON Slicer gracefully skipped or passed through "
                f"({pipeline_ms:.0f}ms, {ratio:.0%} compression)"
            )

    elif "Minified" in name:
        if pipeline_ms > 5000:
            return (
                f"⚠️  AST Compressor took {pipeline_ms:.0f}ms on single-line "
                f"50k-char input — possible tree traversal hang"
            )
        elif ratio > 0.3:
            return (
                f"✅ AST Compressor handled single-line minified code "
                f"({ratio:.0%} compression, {pipeline_ms:.0f}ms)"
            )
        else:
            return (
                f"✅ AST Compressor gracefully skipped single-line input "
                f"({pipeline_ms:.0f}ms) — line-count guard fired"
            )

    elif "Binary" in name or "Hex" in name:
        if chars > 15_000 and ratio > 0.85:
            return (
                f"✅ Binary/hex content correctly routed to Fat Catch vault "
                f"({pipeline_ms:.0f}ms) — no semantic analysis attempted"
            )
        elif ratio > 0.3:
            return (
                f"⚠️  Binary content partially compressed — "
                f"Content Router may have misclassified as text"
            )
        else:
            return (
                f"⚠️  Binary content passed through without vaulting "
                f"({tokens_before:,} tokens on wire) — "
                f"Fat Catch threshold may not have been met"
            )

    return f"Pipeline completed in {pipeline_ms:.0f}ms ({ratio:.0%} compression)"


# ─────────────────────────────────────────────
# Scenario A: Deeply Nested JSON
# ─────────────────────────────────────────────

def generate_deeply_nested_json(depth: int = 150) -> str:
    """
    Generate a JSON object nested `depth` levels deep.

    Structure:
      { "level_0": { "level_1": { ... { "level_149": {
          "value": "needle",
          "data": [1, 2, 3, ..., 100]
      } ... } } } }

    Adversarial properties:
      - Recursive JSON Slicer must traverse 150 levels of nesting
      - Python default recursion limit is 1000 — Node.js has no hard limit
        but stack depth matters
      - Leaf node contains the only meaningful data (needle)
      - All intermediate nodes are structurally identical → no scoring signal
    """
    # Build from the inside out
    needle_uuid = str(uuid.uuid4())
    inner: dict = {
        "value":       "needle_data",
        "needle_uuid": needle_uuid,
        "metrics": {
            "latency_p99_ms": 2847,
            "error_rate":     0.032,
            "throughput_rps": 1250,
        },
        "data": list(range(50)),
        "tags": ["critical", "production", "alert"],
    }

    current = inner
    for i in range(depth - 1, -1, -1):
        current = {
            f"level_{i}": current,
            f"meta_{i}":  f"metadata_at_depth_{i}",
            f"count_{i}": i * 7,
        }

    # Wrap in a tool-result-like structure
    wrapper = {
        "tool": "get_nested_config",
        "timestamp": "2025-01-15T12:00:00Z",
        "request_id": str(uuid.uuid4()),
        "result": current,
        "status": "ok",
    }

    return json.dumps(wrapper, indent=2)


def generate_wide_nested_json(n_keys: int = 500, depth: int = 8) -> str:
    """
    Alternative: wide JSON tree (many siblings at each level).
    Tests the leaf-node extraction on a broad tree.
    """
    def build_level(d: int) -> dict:
        if d == 0:
            return {
                "value":   random.randint(0, 10000),
                "label":   f"leaf_{uuid.uuid4().hex[:6]}",
                "enabled": random.random() > 0.5,
            }
        return {
            f"key_{j:03d}": build_level(d - 1)
            for j in range(max(2, n_keys // (2 ** d)))
        }

    return json.dumps({
        "tool":      "get_config_tree",
        "timestamp": "2025-01-15T12:00:00Z",
        "config":    build_level(depth),
    }, indent=2)


# ─────────────────────────────────────────────
# Scenario B: Extreme Minified Code
# ─────────────────────────────────────────────

def generate_minified_react_app(target_chars: int = 50_000) -> str:
    """
    Generate a plausible React application minified onto a single line.

    Real minified React bundles look like this — thousands of tokens
    on one line, no whitespace, deeply chained function calls.

    Adversarial properties:
      - Single line → Tree-sitter must build a horizontally massive CST
      - No newlines → line-count guards (< 10 lines) may trigger early exit
      - Valid JavaScript syntax → parser cannot bail out early
      - Mixture of arrow functions, ternaries, template literals
    """
    # Seed components that look like real minified React
    components = [
        'var React=require("react");',
        'var ReactDOM=require("react-dom");',
        'function e(e,t,n){return t in e?Object.defineProperty(e,t,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[t]=n,e}',
        'function n(e){return(n="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(e){return typeof e}:function(e){return e&&"function"==typeof Symbol&&e.constructor===Symbol&&e!==Symbol.prototype?"symbol":typeof e})(e)}',
        'var o=Object.assign||function(e){for(var t=1;t<arguments.length;t++){var n=arguments[t];for(var r in n)Object.prototype.hasOwnProperty.call(n,r)&&(e[r]=n[r])}return e};',
        'function r(e,t){if(!(e instanceof t))throw new TypeError("Cannot call a class as a function")}',
        'function i(e,t){for(var n=0;n<t.length;n++){var r=t[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(e,r.key,r)}}',
    ]

    # Function body patterns
    fn_patterns = [
        lambda i: (
            f'var f{i}=function(a{i},b{i}){{return a{i}&&b{i}?'
            f'a{i}.map(function(x){{return x*b{i}+{i}}}):'
            f'[];}},'
        ),
        lambda i: (
            f'function g{i}(props){{return React.createElement("div",'
            f'{{className:"component-{i}",key:{i}}},'
            f'props.children,React.createElement("span",null,"{i}"));}},'
        ),
        lambda i: (
            f'var h{i}=(0,_redux.connect)(function(s){{return{{val{i}:s.reducer{i % 5}.value,'
            f'items{i}:s.reducer{i % 5}.items}}}},function(d){{return{{action{i}:function(x)'
            f'{{return d({{type:"ACTION_{i}",payload:x}})}}}}}})(Component{i % 10});'
        ),
        lambda i: (
            f'exports.handler{i}=async function(event,ctx){{try{{const r=await fetch('
            f'"https://api.example.com/endpoint/{i}",{{method:"POST",'
            f'body:JSON.stringify(event),headers:{{"Content-Type":"application/json"}}}});'
            f'return r.json()}}catch(e){{console.error(e);throw e}}}};'
        ),
    ]

    parts = list(components)
    i = 0
    while sum(len(p) for p in parts) < target_chars:
        pattern = fn_patterns[i % len(fn_patterns)]
        parts.append(pattern(i))
        i += 1

    # Join everything onto ONE LINE — this is the adversarial property
    single_line = "".join(parts)

    # Trim or pad to exact target
    if len(single_line) > target_chars:
        single_line = single_line[:target_chars]
    else:
        # Pad with valid JS — variable assignments
        while len(single_line) < target_chars:
            single_line += f'var _pad{i}={i};'
            i += 1
        single_line = single_line[:target_chars]

    return single_line


def generate_minified_variants() -> list[tuple[str, str, str]]:
    """
    Return (label, content, filename) tuples for different minified sizes.
    Tests at 10k, 30k, 50k chars to find the threshold where AST
    compressor slows down or gives up.
    """
    return [
        (
            "Minified JS 10k chars (1 line)",
            generate_minified_react_app(10_000),
            "bundle.min.js",
        ),
        (
            "Minified JS 30k chars (1 line)",
            generate_minified_react_app(30_000),
            "bundle.min.js",
        ),
        (
            "Minified JS 50k chars (1 line)",
            generate_minified_react_app(50_000),
            "bundle.min.js",
        ),
    ]


# ─────────────────────────────────────────────
# Scenario C: Binary / Hex Dump
# ─────────────────────────────────────────────

def generate_hex_dump(n_lines: int = 5000) -> str:
    """
    Generate realistic `xxd` / `hexdump -C` output.

    Format mirrors real hexdump output:
      00000000: 7f45 4c46 0201 0100 0000 0000 0000 0000  .ELF............

    Adversarial properties:
      - High entropy content — no semantic compressibility
      - Content Router should classify as binary/hex
      - Fat Catch should vault without semantic analysis
      - Pruner/dedup should skip (no key, no structure)
    """
    lines = []
    offset = 0

    for _ in range(n_lines):
        # 16 bytes per line — standard hexdump format
        raw_bytes = os.urandom(16)
        hex_pairs = " ".join(
            f"{raw_bytes[j]:02x}{raw_bytes[j+1]:02x}"
            for j in range(0, 16, 2)
        )
        ascii_repr = "".join(
            chr(b) if 32 <= b < 127 else "."
            for b in raw_bytes
        )
        lines.append(
            f"{offset:08x}: {hex_pairs}  {ascii_repr}"
        )
        offset += 16

    return "\n".join(lines)


def generate_base64_dump(n_lines: int = 5000) -> str:
    """
    Generate base64-encoded binary data — as it would appear
    in a tool output from reading a compiled binary or encrypted blob.

    Adversarial properties:
      - Pure base64 alphabet — no natural language tokens
      - Token boundaries don't align with base64 chunk boundaries
      - BPE tokenizer produces very high token density (few tokens/char)
      - Semantic dedup cannot fingerprint meaningfully
    """
    lines = []
    for i in range(n_lines):
        # 57 bytes → 76 base64 chars per line (PEM standard)
        raw = os.urandom(57)
        lines.append(base64.b64encode(raw).decode("ascii"))

    return "\n".join(lines)


def generate_mixed_binary_log(n_lines: int = 2000) -> str:
    """
    Mix hex dumps with error log lines — as would appear if
    a tool output captured both binary frames and text logs together.

    Tests whether Content Router correctly classifies mixed content
    and whether Fat Catch fires on the overall payload size.
    """
    lines = []
    offset = 0

    for i in range(n_lines):
        if i % 5 == 0:
            # Text log line interspersed
            lines.append(
                f"2025-01-15T12:{i // 60 % 60:02d}:{i % 60:02d}Z "
                f"[TRACE] frame_id={i:06d} bytes_read={random.randint(64, 4096)}"
            )
        else:
            # Hex dump line
            raw = os.urandom(16)
            hex_pairs = " ".join(
                f"{raw[j]:02x}{raw[j+1]:02x}"
                for j in range(0, 16, 2)
            )
            ascii_repr = "".join(
                chr(b) if 32 <= b < 127 else "."
                for b in raw
            )
            lines.append(f"{offset:08x}: {hex_pairs}  {ascii_repr}")
            offset += 16

    return "\n".join(lines)


# ─────────────────────────────────────────────
# Report
# ─────────────────────────────────────────────

def print_report(
    results: list[PathologicalResult],
    timeout: float,
) -> None:
    print("\n" + "=" * 90)
    print("  ADVERSARIAL BENCHMARK — PATHOLOGICAL DATA")
    print("  Hostile inputs designed to break parsers, cause hangs, or corrupt output")
    print("=" * 90)

    print(
        f"\n  {'Scenario':<42} {'Chars':>8} {'Tok In':>8} "
        f"{'Tok Out':>8} {'Ratio':>7} {'Pipeline':>10}  Status"
    )
    print("  " + "-" * 100)

    for r in results:
        if r.timed_out:
            status = f"⏱ TIMEOUT (>{timeout:.0f}s)"
            ratio_str = "—"
            tok_out_str = "—"
        elif r.crashed:
            status = "💥 CRASH"
            ratio_str = "—"
            tok_out_str = "—"
        else:
            status = "✓ handled"
            ratio_str = f"{r.compression_ratio:.1%}"
            tok_out_str = f"{r.tokens_after:>8,}"

        print(
            f"  {r.scenario:<42} "
            f"{r.chars:>8,} "
            f"{r.tokens_before:>8,} "
            f"{tok_out_str:>8} "
            f"{ratio_str:>7} "
            f"{r.pipeline_ms:>8.0f}ms  "
            f"{status}"
        )

    # ── Architectural findings ──
    print()
    print("=" * 90)
    print("  ARCHITECTURAL FINDINGS")
    print("=" * 90)
    print()

    for r in results:
        if r.architectural_finding:
            print(f"  [{r.scenario}]")
            print(f"    {r.architectural_finding}")
            if r.error:
                print(f"    Error detail: {r.error}")
            print()

    # ── Summary ──
    passed   = sum(1 for r in results if r.passed)
    timeouts = sum(1 for r in results if r.timed_out)
    crashes  = sum(1 for r in results if r.crashed)

    print("=" * 90)
    print(f"  Summary: {passed}/{len(results)} handled gracefully | "
          f"{timeouts} timeout(s) | {crashes} crash(es)")

    if timeouts > 0:
        print()
        print("  ⚠️  Timeout(s) detected — these represent real architectural risks:")
        for r in results:
            if r.timed_out:
                print(f"     • {r.scenario}: {r.error}")

    if crashes > 0:
        print()
        print("  💥 Crash(es) detected — pipeline returned error response:")
        for r in results:
            if r.crashed:
                print(f"     • {r.scenario}: {r.error[:80]}")

    if passed == len(results):
        print()
        print("  ✅ All pathological inputs handled without timeout or crash.")
        print("     The pipeline correctly vaulted, skipped, or compressed each.")

    print()


# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Adversarial benchmark — pathological data"
    )
    parser.add_argument("--proxy",   default=PROXY_URL)
    parser.add_argument(
        "--timeout", type=float, default=10.0,
        help="Per-scenario timeout in seconds (default: 10 — tight to catch hangs)",
    )
    parser.add_argument("--output", "-o", help="Save JSON results to file")
    args = parser.parse_args()

    # Connection check
    try:
        requests.get(f"{args.proxy}/dashboard", timeout=2)
    except Exception:
        print(f"❌ Proxy not running at {args.proxy}")
        print("   Start with: node src/server.js")
        return 1

    print(f"✅ Proxy connected at {args.proxy}")
    print(f"   Timeout per scenario: {args.timeout}s (tight — pathological inputs)")
    print()

    results: list[PathologicalResult] = []

    # ── Scenario A: Deeply Nested JSON ──
    print("Generating Scenario A: Deeply Nested JSON...")

    nested_scenarios = [
        (
            "JSON 150-level deep nesting",
            lambda: generate_deeply_nested_json(depth=150),
            "json",
            "get_config",
            "JSON Slicer should traverse or gracefully abort at depth limit",
        ),
        (
            "JSON 50-level deep nesting",
            lambda: generate_deeply_nested_json(depth=50),
            "json",
            "get_config",
            "JSON Slicer should handle comfortably",
        ),
        (
            "JSON wide tree (50 keys, 4 levels)",
            lambda: generate_wide_nested_json(n_keys=50, depth=4),
            "json",
            "get_config",
            "JSON Slicer should extract leaf nodes and slice",
        ),
    ]

    for name, generator, cf_type, tool_name, expected in nested_scenarios:
        print(f"  Generating {name}...", end=" ", flush=True)
        content = generator()
        print(f"{len(content):,} chars → ", end="", flush=True)

        result = run_scenario(
            name=name,
            content=content,
            tool_name=tool_name,
            proxy_url=args.proxy,
            timeout=args.timeout,
            cf_type=cf_type,
            expected_behavior=expected,
        )
        results.append(result)

        if result.timed_out:
            print(f"⏱ TIMEOUT")
        elif result.crashed:
            print(f"💥 CRASH: {result.error[:50]}")
        else:
            print(f"{result.compression_ratio:.0%} in {result.pipeline_ms:.0f}ms")

    # ── Scenario B: Extreme Minified Code ──
    print("\nGenerating Scenario B: Extreme Minified Code (single line)...")

    for label, content, filename in generate_minified_variants():
        print(f"  Generating {label}...", end=" ", flush=True)
        print(f"{len(content):,} chars, 1 line → ", end="", flush=True)

        result = run_scenario(
            name=label,
            content=content,
            tool_name="read_file",
            proxy_url=args.proxy,
            timeout=args.timeout,
            filename=filename,
            cf_type="code",
            expected_behavior=(
                "AST Compressor should gracefully skip single-line file "
                "or handle without hanging — Fat Catch should vault if >15k chars"
            ),
        )
        results.append(result)

        if result.timed_out:
            print(f"⏱ TIMEOUT — AST Compressor may have hung on single-line input")
        elif result.crashed:
            print(f"💥 CRASH")
        else:
            print(f"{result.compression_ratio:.0%} in {result.pipeline_ms:.0f}ms")

    # ── Scenario C: Binary / Hex Dump ──
    print("\nGenerating Scenario C: Binary/Hex Dump...")

    binary_scenarios = [
        (
            "Hex dump 5k lines (xxd format)",
            lambda: generate_hex_dump(n_lines=5000),
            "xxd",
            "bash",
            "Content Router should skip semantic analysis; Fat Catch should vault",
        ),
        (
            "Base64 dump 5k lines",
            lambda: generate_base64_dump(n_lines=5000),
            "base64",
            "bash",
            "High entropy content; Fat Catch should vault; dedup should skip",
        ),
        (
            "Mixed hex+log 2k lines",
            lambda: generate_mixed_binary_log(n_lines=2000),
            "bash",
            "bash",
            "Mixed content; Content Router classification tested",
        ),
        (
            "Hex dump 10k lines (xxd format)",
            lambda: generate_hex_dump(n_lines=10_000),
            "xxd",
            "bash",
            "Large binary; Fat Catch must vault; pipeline must not tokenize hex",
        ),
    ]

    for name, generator, tool_name, cf_type, expected in binary_scenarios:
        print(f"  Generating {name}...", end=" ", flush=True)
        content = generator()
        print(f"{len(content):,} chars → ", end="", flush=True)

        result = run_scenario(
            name=name,
            content=content,
            tool_name=tool_name,
            proxy_url=args.proxy,
            timeout=args.timeout,
            expected_behavior=expected,
        )
        results.append(result)

        if result.timed_out:
            print(f"⏱ TIMEOUT")
        elif result.crashed:
            print(f"💥 CRASH")
        else:
            print(f"{result.compression_ratio:.0%} in {result.pipeline_ms:.0f}ms")

    # ── Print full report ──
    print_report(results, timeout=args.timeout)

    # ── JSON output ──
    if args.output:
        data = {
            "benchmark":  "bench_adversarial_pathological",
            "proxy_url":  args.proxy,
            "timeout_s":  args.timeout,
            "results": [
                {
                    "scenario":               r.scenario,
                    "chars":                  r.chars,
                    "tokens_before":          r.tokens_before,
                    "tokens_after":           r.tokens_after,
                    "compression_ratio":      r.compression_ratio,
                    "pipeline_ms":            r.pipeline_ms,
                    "passed":                 r.passed,
                    "timed_out":              r.timed_out,
                    "crashed":                r.crashed,
                    "note":                   r.note,
                    "error":                  r.error,
                    "architectural_finding":  r.architectural_finding,
                }
                for r in results
            ],
        }
        with open(args.output, "w") as f:
            json.dump(data, f, indent=2)
        print(f"Results saved to {args.output}")

    # Exit code: number of non-graceful failures
    bad = sum(1 for r in results if r.timed_out or r.crashed)
    return bad


if __name__ == "__main__":
    sys.exit(main())