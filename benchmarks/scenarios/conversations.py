"""
Multi-turn conversation generators for ContextForge benchmarks.

These produce realistic agentic conversation histories that exercise
our multi-turn dedup and prefix cache
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field


@dataclass
class Turn:
    """A single conversation turn (user + assistant + tool results)."""
    user_message: str
    assistant_message: str
    tool_calls: list[dict] = field(default_factory=list)
    tool_results: list[dict] = field(default_factory=list)


def make_anthropic_message(role: str, content) -> dict:
    return {"role": role, "content": content}


def make_tool_call(name: str, arguments: dict, call_id: str | None = None) -> dict:
    return {
        "id": call_id or f"call_{uuid.uuid4().hex[:8]}",
        "type": "function",
        "function": {
            "name": name,
            "arguments": str(arguments).replace("'", '"'),
        },
    }


def generate_file_read_conversation(
    n_turns: int = 5,
    file_content: str = "",
    filename: str = "src/server.js",
) -> list[dict]:
    """
    Generate a conversation where the same file is read multiple times.

    This is the core ContextForge use case:
    - Turn 1: Read file → full content injected
    - Turn 2+: File read again → semantic dedup catches it, saves 8k+ tokens

    """
    if not file_content:
        file_content = "// placeholder\n" * 100

    messages = []

    system = {
        "role": "system",
        "content": "You are a helpful coding assistant. Use tools to read and analyze code.",
    }
    messages.append(system)

    for turn_idx in range(n_turns):
        call_id = f"call_{uuid.uuid4().hex[:8]}"

        # User message
        messages.append({
            "role": "user",
            "content": f"Turn {turn_idx + 1}: Analyze src/server.js and tell me about the compression pipeline.",
        })

        # Assistant decides to read the file
        messages.append({
            "role": "assistant",
            "content": None,
            "tool_calls": [make_tool_call("read_file", {"path": filename}, call_id)],
        })

        # Tool result — same file content every turn
        messages.append({
            "role": "tool",
            "tool_call_id": call_id,
            "name": "read_file",
            "content": file_content,
            "_filename": filename,
            "_cf_type": "code",
        })

        # Assistant response
        messages.append({
            "role": "assistant",
            "content": f"I've analyzed the file. The compression pipeline has 12 stages. [Turn {turn_idx + 1} response]",
        })

    return messages


def generate_agentic_coding_conversation(
    n_turns: int = 8,
    large_file_content: str = "",
) -> list[dict]:
    """
    Generate a realistic agentic coding session.

    Simulates Claude Code reading multiple files, running bash commands,
    editing files — the exact workload ContextForge is built for.
    """
    if not large_file_content:
        large_file_content = "export function placeholder() {}\n" * 200

    messages = [
        {
            "role": "system",
            "content": "You are Claude, an AI coding assistant. Analyze and improve the codebase.",
        }
    ]

    # Turn 1: Initial exploration
    call_id_1 = f"call_{uuid.uuid4().hex[:8]}"
    messages.extend([
        {"role": "user", "content": "Read src/server.js and identify performance bottlenecks."},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [make_tool_call("read_file", {"path": "src/server.js"}, call_id_1)],
        },
        {
            "role": "tool",
            "tool_call_id": call_id_1,
            "name": "read_file",
            "content": large_file_content,
            "_filename": "src/server.js",
            "_cf_type": "code",
        },
        {"role": "assistant", "content": "I can see several bottlenecks in the pipeline stages."},
    ])

    # Turn 2: Bash command (different content type)
    call_id_2 = f"call_{uuid.uuid4().hex[:8]}"
    messages.extend([
        {"role": "user", "content": "Run the benchmarks to measure current performance."},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [make_tool_call("bash", {"command": "npm run bench"}, call_id_2)],
        },
        {
            "role": "tool",
            "tool_call_id": call_id_2,
            "name": "bash",
            "content": "Benchmark results:\n  Pipeline latency: 145ms\n  Token compression: 78%\n  Cache hit rate: 50%\n",
            "_cf_type": "text",
        },
        {"role": "assistant", "content": "The benchmarks show 145ms pipeline latency."},
    ])

    # Turns 3-8: Re-read same file (dedup territory) + edits
    for i in range(2, min(n_turns, 8)):
        call_id = f"call_{uuid.uuid4().hex[:8]}"
        messages.extend([
            {"role": "user", "content": f"Step {i + 1}: Continue analysis of server.js."},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [make_tool_call("read_file", {"path": "src/server.js"}, call_id)],
            },
            {
                "role": "tool",
                "tool_call_id": call_id,
                "name": "read_file",
                "content": large_file_content,   # same file — dedup should fire
                "_filename": "src/server.js",
                "_cf_type": "code",
            },
            {"role": "assistant", "content": f"Step {i + 1} analysis complete."},
        ])

    return messages


def generate_tool_heavy_conversation(n_tool_calls: int = 20) -> list[dict]:
    """
    Generate a conversation with many different tool results.

    Tests tool minimization, scrubbing, and CCR pipeline.
    Each tool call returns different content to prevent dedup.
    """
    messages = [
        {
            "role": "system",
            "content": "You are an AI assistant with access to many tools.",
        }
    ]

    messages.append({"role": "user", "content": "Please explore the entire codebase systematically."})

    for i in range(n_tool_calls):
        call_id = f"call_{uuid.uuid4().hex[:8]}"
        filename = f"src/module_{i:03d}.js"

        messages.extend([
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [make_tool_call("read_file", {"path": filename}, call_id)],
            },
            {
                "role": "tool",
                "tool_call_id": call_id,
                "name": "read_file",
                "content": f"// {filename}\nexport function module{i}Function() {{\n  // Implementation {i}\n  return {i};\n}}\n",
                "_filename": filename,
                "_cf_type": "code",
            },
        ])

    messages.append({"role": "assistant", "content": "I've explored all modules."})
    return messages