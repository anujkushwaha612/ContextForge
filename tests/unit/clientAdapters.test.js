// tests/unit/clientAdapters.test.js
//
// Tests the CLIENT-SIDE adapter layer only.
// This is the ingress path — how ContextForge normalizes
// incoming requests from AI clients into internal format.
//
// Current supported ingress clients:
//   - Claude Code (Anthropic format)
//   - OpenAI-compatible clients (default fallback)
//
// NOT tested here:
//   - Upstream provider adapters (see providers.test.js)
//   - Gemini client (not in launch scope)

import { detectAdapter }    from "../../src/adapters/index.js";
import { AnthropicAdapter } from "../../src/adapters/anthropic.js";
import { OpenAIAdapter }    from "../../src/adapters/openai.js";

// ── detectAdapter ────────────────────────────────────────────────────────────

describe("detectAdapter — Claude Code / Anthropic ingress", () => {
  test("detects anthropic from /v1/messages URL", () => {
    const { adapter } = detectAdapter("/v1/messages", {});
    expect(adapter.name).toBe("anthropic");
  });

  test("detects anthropic from anthropic-version header", () => {
    const { adapter } = detectAdapter("/v1/chat/completions", {
      "anthropic-version": "2023-06-01",
    });
    expect(adapter.name).toBe("anthropic");
  });

  test("detects anthropic from x-api-key header without Gemini key", () => {
    const { adapter } = detectAdapter("/v1/messages", {
      "x-api-key": "sk-ant-some-key",
    });
    expect(adapter.name).toBe("anthropic");
  });

  test("detects anthropic from /v1/messages with query params", () => {
    const { adapter } = detectAdapter("/v1/messages?beta=true", {
      "anthropic-version": "2023-06-01",
    });
    expect(adapter.name).toBe("anthropic");
  });
});

describe("detectAdapter — OpenAI default fallback", () => {
  test("defaults to openai for /v1/chat/completions with no special headers", () => {
    const { adapter } = detectAdapter("/v1/chat/completions", {
      "content-type": "application/json",
    });
    expect(adapter.name).toBe("openai");
  });

  test("defaults to openai for unknown paths", () => {
    const { adapter } = detectAdapter("/v1/unknown", {});
    expect(adapter.name).toBe("openai");
  });
});

// ── AnthropicAdapter.toInternal ──────────────────────────────────────────────
// This is the most critical path — Claude Code sends Anthropic format
// and toInternal() must normalize it correctly for the pipeline.

describe("AnthropicAdapter.toInternal — Claude Code request normalization", () => {
  let adapter;

  beforeEach(() => {
    const { adapter: detected } = detectAdapter("/v1/messages", {
      "anthropic-version": "2023-06-01",
    });
    adapter = detected;
  });

  test("returns a payload object", () => {
    const result = adapter.toInternal(
      { model: "claude-sonnet-4", messages: [] },
      {}
    );
    expect(result).toHaveProperty("payload");
    expect(result).toHaveProperty("translationCtx");
  });

  test("normalizes simple user message", () => {
    const claudePayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Rename the authenticate function" }
      ],
    };
    const { payload } = adapter.toInternal(claudePayload, {});
    expect(payload.messages).toBeDefined();
    expect(Array.isArray(payload.messages)).toBe(true);

    const userMsg = payload.messages.find(m => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toContain("Rename the authenticate function");
  });

  test("handles system prompt from Anthropic top-level field", () => {
    const claudePayload = {
      model: "claude-sonnet-4",
      system: "You are a senior TypeScript engineer.",
      messages: [
        { role: "user", content: "Fix the bug" }
      ],
    };
    const { payload } = adapter.toInternal(claudePayload, {});
    const systemMsg = payload.messages.find(m => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain("You are a senior TypeScript engineer.");
  });

  test("handles system as array of content blocks", () => {
    const claudePayload = {
      model: "claude-sonnet-4",
      system: [
        { type: "text", text: "You are a helpful assistant." }
      ],
      messages: [
        { role: "user", content: "Hello" }
      ],
    };
    const { payload } = adapter.toInternal(claudePayload, {});
    const systemMsg = payload.messages.find(m => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain("You are a helpful assistant.");
  });

  test("preserves model field", () => {
    const claudePayload = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "test" }],
    };
    const { payload } = adapter.toInternal(claudePayload, {});
    expect(payload.model).toBe("claude-sonnet-4-5");
  });

  test("preserves max_tokens", () => {
    const claudePayload = {
      model: "claude-sonnet-4",
      max_tokens: 2048,
      messages: [{ role: "user", content: "test" }],
    };
    const { payload } = adapter.toInternal(claudePayload, {});
    expect(payload.max_tokens).toBe(2048);
  });

  test("handles multi-turn conversation", () => {
    const claudePayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Find the authenticate function" },
        { role: "assistant", content: "Found it in src/auth/handler.ts" },
        { role: "user", content: "Now rename it to verifyUser" },
      ],
    };
    const { payload } = adapter.toInternal(claudePayload, {});
    expect(payload.messages.length).toBeGreaterThanOrEqual(3);
  });

  test("handles tool_use in assistant message", () => {
    const claudePayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Find authenticate" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_123",
              name: "find_symbol",
              input: { target: "authenticate" },
            }
          ],
        },
      ],
    };
    const { payload } = adapter.toInternal(claudePayload, {});
    expect(payload.messages).toBeDefined();
    expect(payload.messages.length).toBeGreaterThan(0);
  });

  test("handles tool_result in user message", () => {
    const claudePayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Find authenticate" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_123",
              name: "find_symbol",
              input: { target: "authenticate" },
            }
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_123",
              content: "Found at src/auth/handler.ts:47",
            }
          ],
        },
      ],
    };
    const { payload } = adapter.toInternal(claudePayload, {});
    expect(payload.messages).toBeDefined();
    const toolMsg = payload.messages.find(m => m.role === "tool");
    expect(toolMsg).toBeDefined();
  });

  test("does not mutate original payload", () => {
    const original = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "test" }],
    };
    const originalStr = JSON.stringify(original);
    adapter.toInternal(original, {});
    expect(JSON.stringify(original)).toBe(originalStr);
  });

  test("sets stream from header when not in body", () => {
    const claudePayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "test" }],
    };
    const { payload } = adapter.toInternal(claudePayload, {
      "x-cf-streaming": "true",
    });
    expect(payload.stream).toBe(true);
  });
});

// ── OpenAIAdapter.toInternal ─────────────────────────────────────────────────
// Smaller test surface — OpenAI adapter is mostly passthrough

describe("OpenAIAdapter.toInternal — normalization", () => {
  let adapter;

  beforeEach(() => {
    const { adapter: detected } = detectAdapter("/v1/chat/completions", {});
    adapter = detected;
  });

  test("returns payload and translationCtx", () => {
    const result = adapter.toInternal(
      { model: "gpt-4o", messages: [] },
      {}
    );
    expect(result).toHaveProperty("payload");
    expect(result).toHaveProperty("translationCtx");
  });

  test("strips unsupported OpenAI fields", () => {
    const payload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "test" }],
      logprobs: true,
      store: true,
      metadata: { user: "test" },
      seed: 42,
    };
    const { payload: result } = adapter.toInternal(payload, {});
    expect(result.logprobs).toBeUndefined();
    expect(result.store).toBeUndefined();
    expect(result.metadata).toBeUndefined();
    expect(result.seed).toBeUndefined();
  });

  test("normalizes max_completion_tokens to max_tokens", () => {
    const payload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "test" }],
      max_completion_tokens: 1024,
    };
    const { payload: result } = adapter.toInternal(payload, {});
    expect(result.max_tokens).toBe(1024);
    expect(result.max_completion_tokens).toBeUndefined();
  });

  test("normalizes max_output_tokens to max_tokens", () => {
    const payload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "test" }],
      max_output_tokens: 512,
    };
    const { payload: result } = adapter.toInternal(payload, {});
    expect(result.max_tokens).toBe(512);
    expect(result.max_output_tokens).toBeUndefined();
  });

  test("does not mutate original messages array", () => {
    const original = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "test" }],
    };
    const originalLength = original.messages.length;
    adapter.toInternal(original, {});
    expect(original.messages.length).toBe(originalLength);
  });
});