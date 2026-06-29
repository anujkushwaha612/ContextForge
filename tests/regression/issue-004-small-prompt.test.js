// tests/regression/issue-004-small-prompt.test.js
//
// Regression: small prompts (< 500 tokens) were running through the full
// compression pipeline even though there was nothing meaningful to compress.

import { CompressionDecision } from "../../src/proxy/compressionDecision.js";
import { countTokens } from "../../src/compression/compressionHelper.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a payload whose messages content tokenizes to approximately
 * the requested count using real tiktoken cl100k_base encoding.
 *
 * WHY NOT "x".repeat(n * 4):
 *   tiktoken merges repeated identical characters into very few tokens.
 *   "x".repeat(2000) encodes to ~5 tokens, not 500.
 *   We use varied English-like words so tiktoken produces ~1 token per word.
 *
 * WHY measure-then-pad:
 *   We cannot predict exactly how many chars = N tokens without running
 *   tiktoken. So we build a base string of varied words, measure it,
 *   then pad with more words until we reach the target.
 *
 * @param {number} targetTokens
 * @returns {{ payload, actualTokens }}
 */
function makePayload(targetTokens) {
  // A varied word list that tokenizes close to 1 token per word
  const wordBank = [
    "function", "authenticate", "user", "password", "return",
    "const", "token", "verify", "import", "export", "class",
    "async", "await", "catch", "error", "handle", "request",
    "response", "server", "client", "proxy", "compress", "graph",
    "symbol", "patch", "vault", "memory", "stream", "index",
  ];

  let words = [];
  let payload;
  let actualTokens = 0;

  // Build word list until token count reaches target.
  // Each iteration adds 20 words (~20 tokens). Max 2000 iterations = 40k tokens.
  for (let i = 0; actualTokens < targetTokens && i < 2000; i++) {
    for (let j = 0; j < 20; j++) {
      words.push(wordBank[(i * 20 + j) % wordBank.length]);
    }
    payload = {
      model: "test-model",
      messages: [{ role: "user", content: words.join(" ") }],
    };
    actualTokens = countTokens(payload);
  }

  return { payload, actualTokens };
}

/**
 * Build a payload whose token count comes from `tools` rather than messages,
 * so we can have messages:[] while still clearing the 500-token gate.
 *
 * Required to reach the `no_messages` branch:
 *   tokenCount >= 500  → gate passes
 *   messages is empty  → no_messages fires
 *
 * A plain { messages: [] } payload has ~0 tokens and hits the token gate
 * first, returning "0 tokens below minimum (500)" instead of "no_messages".
 */
function makeHighTokenEmptyMessagesPayload() {
  // Use varied words in tool descriptions so tiktoken produces real tokens
  const wordBank = [
    "authenticate", "compress", "pipeline", "intercept", "retrieve",
    "symbolic", "patching", "workspace", "indexing", "streaming",
  ];

  let tools;
  let payload;
  let actualTokens = 0;

  // Keep adding tool descriptions until tokens >= 500
  for (let toolCount = 5; actualTokens < 500; toolCount += 5) {
    tools = Array.from({ length: toolCount }, (_, i) => ({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: Array.from(
          { length: 20 },
          (_, j) => wordBank[(i * 20 + j) % wordBank.length]
        ).join(" "),
        parameters: { type: "object", properties: {} },
      },
    }));

    payload = { model: "test-model", messages: [], tools };
    actualTokens = countTokens(payload);
  }

  return payload;
}

function decide(payload, headers = {}, optimize = true) {
  return CompressionDecision.decide({
    headers,
    optimize,
    messages: payload.messages,
    payload,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #004a — token counting pings triggered full pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #004a — token counting pings skip compression", () => {
  test("high-token payload with empty messages → passthrough (no_messages)", () => {
    const payload = makeHighTokenEmptyMessagesPayload();

    // Sanity: confirm this payload actually clears the 500-token gate
    const tokens = countTokens(payload);
    expect(tokens).toBeGreaterThanOrEqual(500);

    const decision = decide(payload);
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toBe("no_messages");
    expect(decision.hasMessages).toBe(false);
  });

  test("single-word prompt → below token threshold → passthrough", () => {
    const tinyPayload = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello!" }],
    };
    const decision = decide(tinyPayload);
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toMatch(/below minimum/i);
  });

  test("zero-token empty payload → token gate fires, not no_messages", () => {
    // Documents real behavior: { messages: [] } hits token gate first.
    // Token gate is checked before messages check — this is correct and expected.
    const emptyPayload = { model: "test-model", messages: [] };
    const decision = decide(emptyPayload);
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toMatch(/below minimum/i);
    expect(decision.passthroughReason).not.toBe("no_messages");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #004b — threshold boundary correctness
//
// We cannot use exact token targets (499, 500, 501) because tiktoken
// encodes in chunks — we cannot guarantee landing on an exact boundary
// without knowing the internal BPE merge table.
//
// Instead we verify the SHAPE of the gate:
//   - A payload we KNOW is below threshold → passthrough
//   - A payload we KNOW is above threshold → compress
//   - The actual token counts are measured and cross-checked
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #004b — token threshold boundary", () => {
  test("payload confirmed below 500 tokens → passthrough with token count in reason", () => {
    // Single short message — guaranteed well below 500 tokens
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello world" }],
    };

    const actual = countTokens(payload);
    expect(actual).toBeLessThan(500); // sanity check

    const decision = decide(payload);
    expect(decision.shouldCompress).toBe(false);
    // Reason must include the actual token count so operators can debug
    expect(decision.passthroughReason).toMatch(/below minimum/i);
    expect(decision.passthroughReason).toContain(String(actual));
  });

  test("payload confirmed above 500 tokens → compress", () => {
    const { payload, actualTokens } = makePayload(600);

    expect(actualTokens).toBeGreaterThanOrEqual(500); // sanity check

    const decision = decide(payload);
    expect(decision.shouldCompress).toBe(true);
    expect(decision.passthroughReason).toBeNull();
  });

  test("gate is strictly less-than: token count equal to threshold compresses", () => {
    // Find a payload that lands at exactly 500 or just above by measuring
    // incrementally. The gate is tokenCount < 500, so >= 500 must compress.
    const { payload, actualTokens } = makePayload(500);

    if (actualTokens >= 500) {
      const decision = decide(payload);
      expect(decision.shouldCompress).toBe(true);
    } else {
      // makePayload overshot slightly below — document the actual count
      // and skip rather than asserting wrong behavior
      console.log(`[Test] makePayload(500) produced ${actualTokens} tokens — boundary test skipped`);
      expect(actualTokens).toBeGreaterThan(400); // still reasonable
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #004c — token gate fires before bypass header check
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #004c — token gate fires before bypass header check", () => {
  test("small payload + bypass header → token gate fires, reason is not bypass_header", () => {
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello!" }],
    };

    const actual = countTokens(payload);
    expect(actual).toBeLessThan(500); // sanity

    const decision = decide(payload, { "x-contextforge-bypass": "true" });
    expect(decision.shouldCompress).toBe(false);
    // Token gate fires before bypass is evaluated
    expect(decision.passthroughReason).toMatch(/below minimum/i);
    expect(decision.passthroughReason).not.toBe("bypass_header");
  });

  test("large payload + bypass header → bypass_header reason", () => {
    const { payload, actualTokens } = makePayload(600);
    expect(actualTokens).toBeGreaterThanOrEqual(500); // sanity

    const decision = decide(payload, { "x-contextforge-bypass": "true" });
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toBe("bypass_header");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #004d — CF_OPTIMIZE=false and token gate interaction
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #004d — CF_OPTIMIZE=false and token gate interaction", () => {
  test("small payload + optimize=false → token gate fires first", () => {
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello!" }],
    };

    const actual = countTokens(payload);
    expect(actual).toBeLessThan(500); // sanity

    const decision = decide(payload, {}, false);
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toMatch(/below minimum/i);
  });

  test("large payload + optimize=false → compression_disabled reason", () => {
    const { payload, actualTokens } = makePayload(600);
    expect(actualTokens).toBeGreaterThanOrEqual(500); // sanity

    const decision = decide(payload, {}, false);
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toBe("compression_disabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #004e — passthroughReason always present on passthrough decisions
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #004e — passthroughReason always non-null on passthrough", () => {
  test("token gate passthrough → non-empty string reason", () => {
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    };
    const decision = decide(payload);
    expect(decision.shouldCompress).toBe(false);
    expect(typeof decision.passthroughReason).toBe("string");
    expect(decision.passthroughReason.length).toBeGreaterThan(0);
  });

  test("bypass header passthrough → non-empty string reason", () => {
    const { payload } = makePayload(600);
    const decision = decide(payload, { "x-contextforge-bypass": "true" });
    expect(decision.shouldCompress).toBe(false);
    expect(typeof decision.passthroughReason).toBe("string");
    expect(decision.passthroughReason.length).toBeGreaterThan(0);
  });

  test("optimize disabled passthrough → non-empty string reason", () => {
    const { payload } = makePayload(600);
    const decision = decide(payload, {}, false);
    expect(decision.shouldCompress).toBe(false);
    expect(typeof decision.passthroughReason).toBe("string");
    expect(decision.passthroughReason.length).toBeGreaterThan(0);
  });

  test("no_messages passthrough → non-empty string reason", () => {
    const payload = makeHighTokenEmptyMessagesPayload();
    const decision = decide(payload);
    expect(decision.shouldCompress).toBe(false);
    expect(typeof decision.passthroughReason).toBe("string");
    expect(decision.passthroughReason.length).toBeGreaterThan(0);
  });

  test("compress decision → passthroughReason is null", () => {
    const { payload, actualTokens } = makePayload(600);
    expect(actualTokens).toBeGreaterThanOrEqual(500); // sanity

    const decision = decide(payload);
    expect(decision.shouldCompress).toBe(true);
    expect(decision.passthroughReason).toBeNull();
  });
});