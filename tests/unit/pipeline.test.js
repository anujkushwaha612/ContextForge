// tests/unit/pipeline.test.js
//
// Tests compression pipeline stages in isolation.
// No network, no LLM calls, no file system writes.
//
// Tests:
//   - countTokens
//   - minimizeToolSchemas
//   - deduplicateSystemMessages
//   - CompressionDecision gate

import { countTokens }              from "../../src/compression/compressionHelper.js";
import { minimizeToolSchemas }      from "../../src/proxy/translator.js";
import { deduplicateSystemMessages } from "../../src/proxy/systemMessages.js";
import { CompressionDecision }       from "../../src/proxy/compressionDecision.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

// Builds a payload large enough to pass the 500-token compression gate.
// Uses realistic content so token counting behaves naturally.
function buildLargePayload(extraMessages = []) {
  const longContent = `
    You are a senior TypeScript engineer working on a large enterprise codebase.
    Your task is to refactor the authentication module following SOLID principles.
    The codebase uses Express.js, TypeScript, PostgreSQL via TypeORM, and Redis
    for session management. All functions must have JSDoc comments, unit tests,
    and error handling. The authentication module currently has the following issues:
    1. The authenticate function is too long and does too many things.
    2. Password hashing is done inline instead of in a separate service.
    3. JWT token generation and validation are not abstracted.
    4. Session management is tightly coupled to the request handler.
    5. There is no refresh token support.
    6. Error messages leak internal implementation details.
    Please refactor the module to address all of these issues while maintaining
    full backward compatibility with existing API consumers.
  `.repeat(3);

  return {
    model: "claude-sonnet-4",
    messages: [
      { role: "system", content: "You are a helpful coding assistant." },
      { role: "user",   content: longContent },
      ...extraMessages,
    ],
  };
}

// ── countTokens ──────────────────────────────────────────────────────────────

describe("countTokens", () => {
  test("returns 0 for empty payload", () => {
    expect(countTokens({})).toBe(0);
    expect(countTokens({ messages: [] })).toBe(0);
  });

  test("returns a positive number for a simple message", () => {
    const payload = { messages: [{ role: "user", content: "Hello world" }] };
    expect(countTokens(payload)).toBeGreaterThan(0);
  });

  test("token count grows with content size", () => {
    const small = countTokens({
      messages: [{ role: "user", content: "Hi" }],
    });
    const large = countTokens({
      messages: [{ role: "user", content: "Hello ".repeat(200) }],
    });
    expect(large).toBeGreaterThan(small);
  });

  test("tool definitions add to token count", () => {
    const withoutTools = {
      messages: [{ role: "user", content: "test" }],
    };
    const withTools = {
      messages: [{ role: "user", content: "test" }],
      tools: [{
        type: "function",
        function: {
          name: "find_symbol",
          description: "Search the codebase AST graph for a symbol by name",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "Symbol name to find" },
            },
            required: ["target"],
          },
        },
      }],
    };
    expect(countTokens(withTools)).toBeGreaterThan(countTokens(withoutTools));
  });
});

// ── minimizeToolSchemas ──────────────────────────────────────────────────────

describe("minimizeToolSchemas", () => {
  function buildPayloadWithTools(count = 5) {
    return {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "test" }],
      tools: Array.from({ length: count }, (_, i) => ({
        type: "function",
        function: {
          name: `tool_${i}`,
          description: `This is a very detailed and verbose description of tool number ${i}. `
            + `It explains in exhaustive detail what the tool does, when to use it, what to avoid, `
            + `and what parameters it expects. Much of this text is redundant and can be shortened.`,
          parameters: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: `A detailed description of the input parameter for tool ${i} `
                  + `that provides far more context than is needed for inference.`,
              },
            },
            required: ["input"],
          },
        },
      })),
    };
  }

  test("returns a valid payload with messages and tools", () => {
    const result = minimizeToolSchemas(buildPayloadWithTools(3));
    expect(result).toBeDefined();
    expect(Array.isArray(result.messages)).toBe(true);
    expect(Array.isArray(result.tools)).toBe(true);
  });

  test("preserves all tool names", () => {
    const payload = buildPayloadWithTools(5);
    const result = minimizeToolSchemas(payload);
    const originalNames = payload.tools.map(t => t.function?.name || t.name);
    const resultNames = result.tools.map(t => t.function?.name || t.name);
    expect(resultNames).toEqual(originalNames);
  });

  test("reduces character count for large tool sets", () => {
    const payload = buildPayloadWithTools(10);
    const originalSize = JSON.stringify(payload.tools).length;
    const result = minimizeToolSchemas(payload);
    const minimizedSize = JSON.stringify(result.tools).length;
    expect(minimizedSize).toBeLessThan(originalSize);
  });

  test("handles payload with no tools gracefully", () => {
    const payload = { messages: [{ role: "user", content: "hello" }] };
    const result = minimizeToolSchemas(payload);
    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
  });

  test("handles empty tools array gracefully", () => {
    const payload = {
      messages: [{ role: "user", content: "test" }],
      tools: [],
    };
    const result = minimizeToolSchemas(payload);
    expect(result.tools).toBeDefined();
  });
});

// ── deduplicateSystemMessages ────────────────────────────────────────────────

describe("deduplicateSystemMessages", () => {
  test("returns payload unchanged when no system messages", () => {
    const payload = {
      messages: [
        { role: "user",      content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
    };
    const result = deduplicateSystemMessages(payload);
    expect(result.messages.length).toBe(2);
  });

  test("returns payload unchanged when only one system message", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user",   content: "Hello" },
      ],
    };
    const result = deduplicateSystemMessages(payload);
    const systemMsgs = result.messages.filter(m => m.role === "system");
    expect(systemMsgs.length).toBe(1);
  });

  test("removes exact duplicate system messages", () => {
    const systemContent = "You are a helpful coding assistant with TypeScript expertise.";
    const payload = {
      messages: [
        { role: "system",    content: systemContent },
        { role: "user",      content: "Question 1" },
        { role: "assistant", content: "Answer 1" },
        { role: "system",    content: systemContent }, // exact duplicate
        { role: "user",      content: "Question 2" },
      ],
    };
    const result = deduplicateSystemMessages(payload);
    const systemMsgs = result.messages.filter(m => m.role === "system");
    expect(systemMsgs.length).toBe(1);
  });

  test("keeps non-duplicate system messages", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a TypeScript expert." },
        { role: "user",   content: "Hello" },
        { role: "system", content: "Additional context about the codebase." }, // different
      ],
    };
    const result = deduplicateSystemMessages(payload);
    const systemMsgs = result.messages.filter(m => m.role === "system");
    expect(systemMsgs.length).toBe(2);
  });

  test("preserves non-system message order", () => {
    const systemContent = "System prompt content.";
    const payload = {
      messages: [
        { role: "system",    content: systemContent },
        { role: "user",      content: "Question 1" },
        { role: "assistant", content: "Answer 1" },
        { role: "system",    content: systemContent }, // duplicate
        { role: "user",      content: "Question 2" },
      ],
    };
    const result = deduplicateSystemMessages(payload);
    const nonSystem = result.messages.filter(m => m.role !== "system");
    expect(nonSystem[0].content).toBe("Question 1");
    expect(nonSystem[1].content).toBe("Answer 1");
    expect(nonSystem[2].content).toBe("Question 2");
  });

  test("handles payload with missing messages gracefully", () => {
    const result = deduplicateSystemMessages({});
    expect(result).toBeDefined();
  });
});

// ── CompressionDecision ──────────────────────────────────────────────────────

describe("CompressionDecision", () => {
  // Build a payload that genuinely counts above 500 tokens so the gate passes.
  // The gate calls countTokens(payload) internally — precomputedTokens is ignored.
  const LARGE_PAYLOAD = buildLargePayload();

  // Small payload that will count below the 500-token threshold.
  const SMALL_PAYLOAD = {
    messages: [{ role: "user", content: "hi" }],
  };

  function decide(overrides = {}) {
    return CompressionDecision.decide({
      headers:  {},
      optimize: true,
      messages: LARGE_PAYLOAD.messages,
      payload:  LARGE_PAYLOAD,
      ...overrides,
    });
  }

  test("compresses large payload when optimize is true", () => {
    const decision = decide();
    expect(decision.shouldCompress).toBe(true);
  });

  test("does not compress when optimize is false", () => {
    const decision = decide({ optimize: false });
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toBe("compression_disabled");
  });

  test("does not compress when bypass header is set", () => {
    const decision = decide({
      headers: { "x-contextforge-bypass": "true" },
    });
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toBe("bypass_header");
  });

  test("does not compress when bypass mode is passthrough", () => {
    const decision = decide({
      headers: { "x-contextforge-mode": "passthrough" },
    });
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toBe("bypass_header");
  });

  test("does not compress small payload below 500-token threshold", () => {
    const decision = CompressionDecision.decide({
      headers:  {},
      optimize: true,
      messages: SMALL_PAYLOAD.messages,
      payload:  SMALL_PAYLOAD,
    });
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toMatch(/below minimum/i);
  });

  test("does not compress when messages array is empty", () => {
    const emptyPayload = { messages: [] };
    const decision = CompressionDecision.decide({
      headers:  {},
      optimize: true,
      messages: [],
      payload:  emptyPayload,
    });
    expect(decision.shouldCompress).toBe(false);
  });

  test("passthroughReason is null when compressing", () => {
    const decision = decide();
    if (decision.shouldCompress) {
      expect(decision.passthroughReason).toBeNull();
    }
  });

  test("decision object is frozen — cannot be mutated", () => {
    const decision = decide();
    expect(() => {
      decision.shouldCompress = !decision.shouldCompress;
    }).toThrow();
  });

  test("toString returns readable string", () => {
    const compressing = decide();
    const str = compressing.toString();
    expect(typeof str).toBe("string");
    expect(str.length).toBeGreaterThan(0);
  });
});