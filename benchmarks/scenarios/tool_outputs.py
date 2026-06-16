"""
Realistic tool output generators for ContextForge benchmarks.

Produces Anthropic-format tool results that actually flow through our pipeline.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Literal


@dataclass
class Question:
    """A question about tool output content with ground truth."""
    text: str
    ground_truth: str
    answer_location: Literal["early", "middle", "late", "scattered"]
    difficulty: Literal["easy", "medium", "hard"]


def count_tokens(text: str) -> int:
    """Approximate token count — 4 chars per token"""
    return len(text) // 4


def make_tool_result(tool_call_id: str, content: str, tool_name: str = "bash") -> dict:
    """Wrap content in Anthropic tool result format."""
    return {
        "role": "tool",
        "tool_call_id": tool_call_id,
        "name": tool_name,
        "content": content,
        "_filename": None,
    }


def generate_server_log_tool_output(
    n_entries: int = 500,
    error_positions: list[int] | None = None,
) -> tuple[dict, list[Question]]:
    """
    Generate a tool result containing server logs.
    """
    if error_positions is None:
        error_positions = [3, n_entries // 2, n_entries - 5]

    # Convert to set for O(1) lookup
    error_pos_set = set(error_positions)

    log_templates = [
        "INFO  [api-gateway] Health check passed",
        "INFO  [api-gateway] Request processed successfully in 23ms",
        "INFO  [redis] Cache hit for user session abc123",
        "INFO  [postgres] Query completed in 12ms rows=45",
        "INFO  [auth] Authentication successful user=system",
        "DEBUG [postgres] Connection pool: active=5 idle=15",
    ]

    error_templates = [
        "ERROR [payment-processor] Connection refused to payment-service:8080 - ECONNREFUSED error_code=PAYMENT_SERVICE_DOWN trace_id=abc123",
        "ERROR [order-processor] Timeout waiting for inventory-service after 30000ms error_code=INVENTORY_TIMEOUT trace_id=def456",
        "CRITICAL [recommendation-engine] Out of memory: Java heap space - killing process error_code=OOM_KILLED trace_id=ghi789",
    ]

    lines = []
    error_idx = 0

    for i in range(n_entries):
        hour = 10 + (i // 60)
        minute = i % 60
        ts = f"2024-01-15T{hour:02d}:{minute:02d}:00Z"

        if i in error_pos_set and error_idx < len(error_templates):
            line = f"{ts} {error_templates[error_idx]}"
            error_idx += 1
        else:
            line = f"{ts} {random.choice(log_templates)}"
        lines.append(line)

    content = "\n".join(lines)
    tool_result = make_tool_result("call_logs_001", content, "bash")

    questions = [
        Question(
            text="What error code was returned by the payment service?",
            ground_truth="PAYMENT_SERVICE_DOWN",
            answer_location="early",
            difficulty="easy",
        ),
        Question(
            text="Which service experienced a timeout and what was its trace ID?",
            ground_truth="order-processor with trace_id def456",
            answer_location="middle",
            difficulty="medium",
        ),
        Question(
            text="What critical error occurred near the end of the logs?",
            ground_truth="OOM_KILLED in recommendation-engine",
            answer_location="late",
            difficulty="medium",
        ),
        Question(
            text="How many distinct error types appear in total?",
            ground_truth="3",
            answer_location="scattered",
            difficulty="hard",
        ),
    ]

    return tool_result, questions


def generate_file_search_tool_output(
    n_files: int = 1000,
) -> tuple[dict, list[Question]]:
    """Generate a tool result from a large file search."""

    dirs = [
        "src/api", "src/services", "src/utils", "src/models",
        "src/controllers", "src/middleware", "tests/unit",
        "tests/integration", "lib/core", "lib/helpers",
    ]

    special_files = {
        50:  ("src/auth/jwt_handler.js",          "JWT token validation and refresh"),
        250: ("src/services/payment_processor.js", "Stripe payment integration"),
        500: ("src/middleware/rate_limiter.js",    "Redis-based rate limiting"),
        750: ("config/database.js",               "PostgreSQL connection settings"),
        999: ("src/api/health_check.js",          "Kubernetes health endpoints"),
    }

    lines = []
    for i in range(n_files):
        if i in special_files:
            path, desc = special_files[i]
            lines.append(f"{path}  # {desc}")
        else:
            d = random.choice(dirs)
            lines.append(f"{d}/module_{i}.js")

    content = "\n".join(lines)
    tool_result = make_tool_result("call_find_001", content, "bash")

    questions = [
        Question(
            text="Which file handles JWT token operations?",
            ground_truth="src/auth/jwt_handler.js",
            answer_location="early",
            difficulty="easy",
        ),
        Question(
            text="What file contains the Stripe payment integration?",
            ground_truth="src/services/payment_processor.js",
            answer_location="middle",
            difficulty="medium",
        ),
        Question(
            text="Which file implements rate limiting?",
            ground_truth="src/middleware/rate_limiter.js",
            answer_location="middle",
            difficulty="medium",
        ),
        Question(
            text="What is the last special file and what does it do?",
            ground_truth="src/api/health_check.js - Kubernetes health endpoints",
            answer_location="late",
            difficulty="hard",
        ),
    ]

    return tool_result, questions


def generate_js_source_tool_output(n_lines: int = 1200) -> tuple[dict, list[Question]]:
    """
    Generate a large JS source file tool output.
    """

    # ── Imports block — this is the only initial chunk ──
    imports_block = """import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
"""

    # ── Function templates ──
    # Uses {{}} to escape braces that should appear literally in the output
    # Uses {i} as the only format variable
    small_fn = """
export function countTokens(text) {{
  return Math.ceil(text.length / 4);
}}
"""

    medium_fn = """
export function parseToolResult_{i}(result) {{
  if (!result || typeof result !== 'object') return null;
  const {{ role, content, tool_call_id }} = result;
  if (role !== 'tool') return null;
  return {{
    id: tool_call_id,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    parsed: true,
  }};
}}
"""

    large_fn = """
export async function executeRequest_{i}(payload, retryCount = 0) {{
  const startTime = performance.now();
  if (!payload || typeof payload !== 'object') {{
    throw new Error('Invalid payload');
  }}
  payload = {{ ...payload, model: 'target-model' }};
  delete payload.max_completion_tokens;

  const body = JSON.stringify(payload);
  const headers = {{
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  }};

  return new Promise((resolve, reject) => {{
    const req = http.request(
      {{ hostname: 'localhost', port: 11434, path: '/v1/chat/completions', method: 'POST', headers }},
      (res) => {{
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {{
          try {{
            const json = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode >= 400) {{
              reject(new Error(`Upstream error ${{res.statusCode}}`));
            }} else {{
              resolve(json);
            }}
          }} catch (err) {{
            reject(err);
          }}
        }});
      }}
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  }});
}}
"""

    function_templates = [small_fn, medium_fn, large_fn]

    # ── Build content ──
    # Start with imports, count only those lines
    chunks = [imports_block]
    current_lines = len(imports_block.split("\n"))  # ← FIX: only chunks[0] exists here
    i = 0

    while current_lines < n_lines:
        template = random.choice(function_templates)
        fn = template.format(i=i)
        chunks.append(fn)
        current_lines += len(fn.split("\n"))
        i += 1

    # Plant a known secret function near the end
    secret_fn = """
function calculateContextForgeSecretEntropy(seed) {
  // CAUTION: synthetic testing only
  const magicSalt = "X-77-ALPHA-PROXY";
  return `Entropy using salt:${magicSalt}`;
}
"""
    chunks.append(secret_fn)

    content = "".join(chunks)
    tool_result = make_tool_result("call_read_001", content, "read_file")
    tool_result["_filename"] = "src/server.js"
    tool_result["_cf_type"] = "code"

    questions = [
        Question(
            text="What does the countTokens function return?",
            ground_truth="Math.ceil(text.length / 4)",
            answer_location="early",
            difficulty="easy",
        ),
        Question(
            text="What model does executeRequest override the payload with?",
            ground_truth="target-model",
            answer_location="middle",
            difficulty="medium",
        ),
        Question(
            text="What is the hardcoded magicSalt value?",
            ground_truth="X-77-ALPHA-PROXY",
            answer_location="late",
            difficulty="hard",
        ),
    ]

    return tool_result, questions