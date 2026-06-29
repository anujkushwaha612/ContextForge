// tests/unit/compressionDecision.test.js

import {
  CompressionDecision,
  isBypassEnabled,
  getOptimizeFlag,
} from "../../src/proxy/compressionDecision.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a payload that countTokens will estimate above or below 500.
 * countTokens uses ~4 chars per token as a rough estimate.
 * 500 tokens ≈ 2000 chars of content.
 */
function makePayload(tokenEstimate) {
  return {
    model: "test-model",
    messages: [
      { role: "user", content: "word ".repeat(tokenEstimate - 5) },
    ],
  };
}

const LARGE_PAYLOAD = makePayload(600);  // above threshold
const SMALL_PAYLOAD = makePayload(100);  // below threshold
const EMPTY_PAYLOAD  = { model: "test-model", messages: [] };

// ─────────────────────────────────────────────────────────────────────────────
// isBypassEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe("isBypassEnabled", () => {
  describe("x-contextforge-bypass header", () => {
    test.each(["true", "1", "yes", "on"])(
      '"%s" → bypass enabled',
      (value) => {
        expect(isBypassEnabled({ "x-contextforge-bypass": value })).toBe(true);
      }
    );

    test.each(["TRUE", "YES", "ON", "True"])(
      '"%s" case-insensitive → bypass enabled',
      (value) => {
        expect(isBypassEnabled({ "x-contextforge-bypass": value })).toBe(true);
      }
    );

    test.each(["false", "0", "no", "off", ""])(
      '"%s" → bypass disabled',
      (value) => {
        expect(isBypassEnabled({ "x-contextforge-bypass": value })).toBe(false);
      }
    );
  });

  describe("x-contextforge-mode header", () => {
    test('"passthrough" → bypass enabled', () => {
      expect(isBypassEnabled({ "x-contextforge-mode": "passthrough" })).toBe(true);
    });

    test('"PASSTHROUGH" case-insensitive → bypass enabled', () => {
      expect(isBypassEnabled({ "x-contextforge-mode": "PASSTHROUGH" })).toBe(true);
    });

    test('"compress" → bypass disabled', () => {
      expect(isBypassEnabled({ "x-contextforge-mode": "compress" })).toBe(false);
    });
  });

  test("no relevant headers → bypass disabled", () => {
    expect(isBypassEnabled({ "content-type": "application/json" })).toBe(false);
  });

  test("empty headers object → bypass disabled", () => {
    expect(isBypassEnabled({})).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompressionDecision.decide — token threshold gate
// ─────────────────────────────────────────────────────────────────────────────

describe("CompressionDecision.decide — token threshold", () => {
  test("payload below 500 tokens → passthrough regardless of other flags", () => {
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: true,
      messages: SMALL_PAYLOAD.messages,
      payload: SMALL_PAYLOAD,
    });
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toMatch(/below minimum/i);
  });

  test("payload above 500 tokens + no bypass → shouldCompress true", () => {
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: true,
      messages: LARGE_PAYLOAD.messages,
      payload: LARGE_PAYLOAD,
    });
    expect(decision.shouldCompress).toBe(true);
    expect(decision.passthroughReason).toBeNull();
  });

  test("token count exactly at threshold boundary — 499 tokens → passthrough", () => {
    const payload = makePayload(499);
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: true,
      messages: payload.messages,
      payload,
    });
    expect(decision.shouldCompress).toBe(false);
  });

  test("token count exactly 500 → compress (threshold is exclusive lower bound)", () => {
    // makePayload(500) produces exactly ~500 token estimate
    // The gate is tokenCount < 500, so 500 should compress
    const payload = makePayload(500);
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: true,
      messages: payload.messages,
      payload,
    });
    // 500 is NOT < 500, so it should proceed to compression
    expect(decision.shouldCompress).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompressionDecision.decide — bypass / config gates
// ─────────────────────────────────────────────────────────────────────────────

describe("CompressionDecision.decide — bypass gates", () => {
  test("bypass header → passthrough with reason bypass_header", () => {
    const decision = CompressionDecision.decide({
      headers: { "x-contextforge-bypass": "true" },
      optimize: true,
      messages: LARGE_PAYLOAD.messages,
      payload: LARGE_PAYLOAD,
    });
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toBe("bypass_header");
    expect(decision.bypassHeaderSet).toBe(true);
  });

  test("optimize=false → passthrough with reason compression_disabled", () => {
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: false,
      messages: LARGE_PAYLOAD.messages,
      payload: LARGE_PAYLOAD,
    });
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toBe("compression_disabled");
    expect(decision.configOptimizeEnabled).toBe(false);
  });

  test("empty messages → passthrough with reason no_messages", () => {
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: true,
      messages: [],
      payload: LARGE_PAYLOAD, // large payload so token gate passes
    });
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toBe("no_messages");
    expect(decision.hasMessages).toBe(false);
  });

  test("null messages → passthrough with reason no_messages", () => {
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: true,
      messages: null,
      payload: LARGE_PAYLOAD,
    });
    expect(decision.shouldCompress).toBe(false);
    expect(decision.passthroughReason).toBe("no_messages");
  });

  test("bypass header takes precedence over optimize=false", () => {
    // Both bypass and config-disabled — bypass reason wins because
    // it's checked first after the token gate
    const decision = CompressionDecision.decide({
      headers: { "x-contextforge-bypass": "true" },
      optimize: false,
      messages: LARGE_PAYLOAD.messages,
      payload: LARGE_PAYLOAD,
    });
    expect(decision.passthroughReason).toBe("bypass_header");
  });

  test("token gate takes precedence over bypass header", () => {
    // Small payload — token gate fires before bypass is even checked
    const decision = CompressionDecision.decide({
      headers: { "x-contextforge-bypass": "true" },
      optimize: true,
      messages: SMALL_PAYLOAD.messages,
      payload: SMALL_PAYLOAD,
    });
    expect(decision.passthroughReason).toMatch(/below minimum/i);
    // bypassHeaderSet should still be false because we never reached that check
    expect(decision.bypassHeaderSet).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompressionDecision value object properties
// ─────────────────────────────────────────────────────────────────────────────

describe("CompressionDecision value object", () => {
  test("decision is frozen — mutations are silently ignored", () => {
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: true,
      messages: LARGE_PAYLOAD.messages,
      payload: LARGE_PAYLOAD,
    });
    // Object.freeze means assignment silently fails in non-strict mode
    // In strict mode it throws — either way the value must not change
    try {
      decision.shouldCompress = false;
    } catch {}
    expect(decision.shouldCompress).toBe(true);
  });

  test("toString — compressing path", () => {
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: true,
      messages: LARGE_PAYLOAD.messages,
      payload: LARGE_PAYLOAD,
    });
    expect(decision.toString()).toBe("CompressionDecision(COMPRESS)");
  });

  test("toString — passthrough path includes reason", () => {
    const decision = CompressionDecision.decide({
      headers: { "x-contextforge-bypass": "true" },
      optimize: true,
      messages: LARGE_PAYLOAD.messages,
      payload: LARGE_PAYLOAD,
    });
    expect(decision.toString()).toContain("PASSTHROUGH");
    expect(decision.toString()).toContain("bypass_header");
  });

  test("applyToTags — sets passthrough_reason on passthrough", () => {
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: false,
      messages: LARGE_PAYLOAD.messages,
      payload: LARGE_PAYLOAD,
    });
    const tags = {};
    decision.applyToTags(tags);
    expect(tags.passthrough_reason).toBe("compression_disabled");
  });

  test("applyToTags — no-op when compressing", () => {
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: true,
      messages: LARGE_PAYLOAD.messages,
      payload: LARGE_PAYLOAD,
    });
    const tags = {};
    decision.applyToTags(tags);
    expect(tags.passthrough_reason).toBeUndefined();
  });

  test("all fields present on compress decision", () => {
    const decision = CompressionDecision.decide({
      headers: {},
      optimize: true,
      messages: LARGE_PAYLOAD.messages,
      payload: LARGE_PAYLOAD,
    });
    expect(decision).toMatchObject({
      shouldCompress: true,
      passthroughReason: null,
      bypassHeaderSet: false,
      configOptimizeEnabled: true,
      hasMessages: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getOptimizeFlag
// ─────────────────────────────────────────────────────────────────────────────

describe("getOptimizeFlag", () => {
  const originalEnv = process.env.CF_OPTIMIZE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CF_OPTIMIZE;
    } else {
      process.env.CF_OPTIMIZE = originalEnv;
    }
  });

  test.each(["false", "0", "off", "no", "disabled"])(
    'CF_OPTIMIZE="%s" → false',
    (value) => {
      process.env.CF_OPTIMIZE = value;
      expect(getOptimizeFlag()).toBe(false);
    }
  );

  test.each(["true", "1", "yes", "on", "enabled", "TRUE"])(
    'CF_OPTIMIZE="%s" → true',
    (value) => {
      process.env.CF_OPTIMIZE = value;
      expect(getOptimizeFlag()).toBe(true);
    }
  );

  test("CF_OPTIMIZE unset → defaults to true", () => {
    delete process.env.CF_OPTIMIZE;
    expect(getOptimizeFlag()).toBe(true);
  });
});