// tests/unit/providers.test.js
//
// Tests the UPSTREAM PROVIDER adapter layer.
// These adapters shape the outgoing request to the actual LLM provider
// after ContextForge has finished processing.
//
// Current supported upstream providers:
//   - Ollama (default, OpenAI-compatible)
//   - OpenAI
//   - Anthropic
//
// NOT tested here:
//   - Groq (not in launch scope)
//   - Gemini (not in launch scope)
//   - Client/ingress adapters (see clientAdapters.test.js)

import { OllamaAdapter }    from "../../src/providers/ollama.js";
import { OpenAIAdapter }    from "../../src/providers/openai.js";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { ProviderFactory }  from "../../src/providers/index.js";

// ── Shared helpers ───────────────────────────────────────────────────────────

// Headers that Claude Code sends — these must be stripped before
// forwarding to any upstream provider that is not Anthropic.
const CLAUDE_CODE_HEADERS = {
  "content-type":      "application/json",
  "authorization":     "Bearer client-forwarded-key",
  "content-length":    "1500",
  "accept-encoding":   "gzip",
  "connection":        "keep-alive",
  "anthropic-version": "2023-06-01",
  "anthropic-beta":    "tools-2024-04-04",
  "x-api-key":         "sk-ant-client-key",
};

function makeHeaders(overrides = {}) {
  return { ...CLAUDE_CODE_HEADERS, ...overrides };
}

// ── ProviderFactory ──────────────────────────────────────────────────────────

describe("ProviderFactory", () => {
  test("returns ollama adapter for 'ollama'", () => {
    const adapter = ProviderFactory.getAdapter("ollama");
    expect(adapter.name).toBe("ollama");
  });

  test("returns openai adapter for 'openai'", () => {
    const adapter = ProviderFactory.getAdapter("openai");
    expect(adapter.name).toBe("openai");
  });

  test("returns anthropic adapter for 'anthropic'", () => {
    const adapter = ProviderFactory.getAdapter("anthropic");
    expect(adapter.name).toBe("anthropic");
  });

  test("throws a clear error for unknown providers", () => {
    expect(() => ProviderFactory.getAdapter("fakeprovider"))
      .toThrow(/Unknown provider/i);
  });

  test("all supported adapters have required interface", () => {
    for (const name of ["ollama", "openai", "anthropic"]) {
      const adapter = ProviderFactory.getAdapter(name);
      expect(typeof adapter.name).toBe("string");
      expect(typeof adapter.hostname).toBe("string");
      expect(typeof adapter.port).toBe("number");
      expect(typeof adapter.protocol).toBe("string");
      expect(["http", "https"]).toContain(adapter.protocol);
      expect(typeof adapter.transformHeaders).toBe("function");
      expect(typeof adapter.transformPath).toBe("function");
    }
  });
});

// ── OllamaAdapter ────────────────────────────────────────────────────────────
// Most critical provider — this is the default upstream.
// Claude Code sends Anthropic headers that Ollama does not understand.
// OllamaAdapter MUST strip all of them.

describe("OllamaAdapter", () => {
  test("has correct default connection values", () => {
    expect(OllamaAdapter.hostname).toBe("127.0.0.1");
    expect(OllamaAdapter.port).toBe(11434);
    expect(OllamaAdapter.protocol).toBe("http");
  });

  test("sets host header with port", () => {
    const result = OllamaAdapter.transformHeaders(makeHeaders());
    expect(result.host).toBe("127.0.0.1:11434");
  });

  test("strips anthropic-version header", () => {
    const result = OllamaAdapter.transformHeaders(makeHeaders());
    expect(result["anthropic-version"]).toBeUndefined();
  });

  test("strips anthropic-beta header", () => {
    const result = OllamaAdapter.transformHeaders(makeHeaders());
    expect(result["anthropic-beta"]).toBeUndefined();
  });

  test("strips x-api-key header", () => {
    const result = OllamaAdapter.transformHeaders(makeHeaders());
    expect(result["x-api-key"]).toBeUndefined();
  });

  test("strips hop-by-hop headers", () => {
    const result = OllamaAdapter.transformHeaders(makeHeaders());
    expect(result["content-length"]).toBeUndefined();
    expect(result["accept-encoding"]).toBeUndefined();
    expect(result["connection"]).toBeUndefined();
  });

  test("preserves content-type", () => {
    const result = OllamaAdapter.transformHeaders(makeHeaders());
    expect(result["content-type"]).toBe("application/json");
  });

  test("maps /v1/messages to /v1/chat/completions", () => {
    expect(OllamaAdapter.transformPath("/v1/messages"))
      .toBe("/v1/chat/completions");
  });

  test("maps /v1/messages?beta=true to /v1/chat/completions", () => {
    expect(OllamaAdapter.transformPath("/v1/messages?beta=true"))
      .toBe("/v1/chat/completions");
  });

  test("strips query params from /v1/chat/completions", () => {
    const result = OllamaAdapter.transformPath("/v1/chat/completions?foo=bar");
    expect(result).toBe("/v1/chat/completions");
    expect(result).not.toContain("?");
  });

  test("passes /v1/chat/completions through unchanged", () => {
    expect(OllamaAdapter.transformPath("/v1/chat/completions"))
      .toBe("/v1/chat/completions");
  });

  test("injects OLLAMA_API_KEY as bearer when set", () => {
    const original = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "ollama-secret";
    const result = OllamaAdapter.transformHeaders(makeHeaders());
    expect(result["authorization"]).toBe("Bearer ollama-secret");
    if (original === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = original;
  });
});

// ── OpenAIAdapter ────────────────────────────────────────────────────────────
// Used when CF_PROVIDER=openai or routing to OpenAI-compatible endpoints.
// Claude Code headers must be stripped before forwarding to OpenAI.

describe("OpenAIAdapter", () => {
  test("has correct default connection values", () => {
    expect(OpenAIAdapter.hostname).toBe("api.openai.com");
    expect(OpenAIAdapter.port).toBe(443);
    expect(OpenAIAdapter.protocol).toBe("https");
  });

  test("sets host header", () => {
    const result = OpenAIAdapter.transformHeaders(makeHeaders());
    expect(result.host).toBe("api.openai.com");
  });

  test("strips anthropic-version header", () => {
    const result = OpenAIAdapter.transformHeaders(makeHeaders());
    expect(result["anthropic-version"]).toBeUndefined();
  });

  test("strips anthropic-beta header", () => {
    const result = OpenAIAdapter.transformHeaders(makeHeaders());
    expect(result["anthropic-beta"]).toBeUndefined();
  });

  test("strips x-api-key header", () => {
    const result = OpenAIAdapter.transformHeaders(makeHeaders());
    expect(result["x-api-key"]).toBeUndefined();
  });

  test("strips hop-by-hop headers", () => {
    const result = OpenAIAdapter.transformHeaders(makeHeaders());
    expect(result["content-length"]).toBeUndefined();
    expect(result["accept-encoding"]).toBeUndefined();
    expect(result["connection"]).toBeUndefined();
  });

  test("injects OPENAI_API_KEY from env", () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-key";
    const result = OpenAIAdapter.transformHeaders(makeHeaders());
    expect(result["authorization"]).toBe("Bearer sk-test-key");
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });

  test("maps /v1/messages to /v1/chat/completions", () => {
    expect(OpenAIAdapter.transformPath("/v1/messages"))
      .toBe("/v1/chat/completions");
  });

  test("maps /v1/messages?beta=true to /v1/chat/completions", () => {
    expect(OpenAIAdapter.transformPath("/v1/messages?beta=true"))
      .toBe("/v1/chat/completions");
  });

  test("passes /v1/chat/completions through unchanged", () => {
    expect(OpenAIAdapter.transformPath("/v1/chat/completions"))
      .toBe("/v1/chat/completions");
  });
});

// ── AnthropicAdapter (upstream) ──────────────────────────────────────────────
// Used when CF_PROVIDER=anthropic — routing to real Anthropic API.
// ContextForge normalizes internally to OpenAI format, then this adapter
// converts back to Anthropic wire format before sending upstream.

describe("AnthropicAdapter (upstream provider)", () => {
  test("has correct default connection values", () => {
    expect(AnthropicAdapter.hostname).toBe("api.anthropic.com");
    expect(AnthropicAdapter.port).toBe(443);
    expect(AnthropicAdapter.protocol).toBe("https");
  });

  test("converts Authorization Bearer to x-api-key when no env key", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const headers = makeHeaders({ authorization: "Bearer sk-ant-forwarded" });
    const result = AnthropicAdapter.transformHeaders(headers);
    expect(result["x-api-key"]).toBe("sk-ant-forwarded");
    expect(result["authorization"]).toBeUndefined();
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  });

  test("env ANTHROPIC_API_KEY takes priority over forwarded header", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-key";
    const result = AnthropicAdapter.transformHeaders(makeHeaders());
    expect(result["x-api-key"]).toBe("sk-ant-env-key");
    expect(result["authorization"]).toBeUndefined();
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  });

  test("always sets anthropic-version header", () => {
    const result = AnthropicAdapter.transformHeaders(makeHeaders());
    expect(result["anthropic-version"]).toBeDefined();
  });

  test("respects client-supplied anthropic-version", () => {
    const headers = makeHeaders({ "anthropic-version": "2024-01-01" });
    const result = AnthropicAdapter.transformHeaders(headers);
    expect(result["anthropic-version"]).toBe("2024-01-01");
  });

  test("strips hop-by-hop headers", () => {
    const result = AnthropicAdapter.transformHeaders(makeHeaders());
    expect(result["content-length"]).toBeUndefined();
    expect(result["accept-encoding"]).toBeUndefined();
    expect(result["connection"]).toBeUndefined();
  });

  test("maps /v1/chat/completions to /v1/messages", () => {
    expect(AnthropicAdapter.transformPath("/v1/chat/completions"))
      .toBe("/v1/messages");
  });

  test("passes /v1/messages through unchanged", () => {
    expect(AnthropicAdapter.transformPath("/v1/messages"))
      .toBe("/v1/messages");
  });
});