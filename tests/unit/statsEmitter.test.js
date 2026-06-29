/**
 * Unit tests for StatsEmitter.
 *
 * Tests:
 *   - Session metric recording
 *   - Agent action tracking
 *   - Cache hit rate calculation
 *   - Snapshot shape validation
 *   - Event broadcasting
 */

import { statsEmitter } from "../../src/proxy/statsEmitter.js";

// Reset state between tests by creating a fresh instance
// We test the singleton directly since that is what the server uses
beforeEach(() => {
  // Reset session counters
  statsEmitter.session.totalRequests = 0;
  statsEmitter.session.tokensBefore = 0;
  statsEmitter.session.tokensAfter = 0;
  statsEmitter.session.tokensSaved = 0;
  statsEmitter.session.avgCompressionRatio = 0;
  statsEmitter.session.avgPipelineLatency = 0;
  statsEmitter.session.avgUpstreamLatency = 0;

  // Reset agent actions
  statsEmitter.agentActions.graphLookups = 0;
  statsEmitter.agentActions.surgicalReads = 0;
  statsEmitter.agentActions.astPatches = 0;
  statsEmitter.agentActions.rawVaultOpens = 0;

  // Reset cache
  for (const key of Object.keys(statsEmitter.cache)) {
    statsEmitter.cache[key].hits = 0;
    statsEmitter.cache[key].misses = 0;
    statsEmitter.cache[key].rate = 0;
  }

  // Reset recent events
  statsEmitter.recentEvents = [];
});

// ── recordRequest ────────────────────────────────────────────────────────────

describe("statsEmitter.recordRequest", () => {
  test("increments totalRequests", () => {
    statsEmitter.recordRequest({
      baselineTokens: 1000,
      finalTokens: 600,
      pipelineLatency: 10,
      upstreamLatency: 200
    });
    expect(statsEmitter.session.totalRequests).toBe(1);
  });

  test("accumulates token counts correctly", () => {
    statsEmitter.recordRequest({
      baselineTokens: 1000,
      finalTokens: 600,
      pipelineLatency: 10,
      upstreamLatency: 200
    });
    expect(statsEmitter.session.tokensBefore).toBe(1000);
    expect(statsEmitter.session.tokensAfter).toBe(600);
    expect(statsEmitter.session.tokensSaved).toBe(400);
  });

  test("calculates compression ratio correctly", () => {
    statsEmitter.recordRequest({
      baselineTokens: 1000,
      finalTokens: 600,
      pipelineLatency: 10,
      upstreamLatency: 200
    });
    // (400 / 1000) * 100 = 40%
    expect(statsEmitter.session.avgCompressionRatio).toBeCloseTo(40, 1);
  });

  test("computes rolling average latency across multiple requests", () => {
    statsEmitter.recordRequest({ baselineTokens: 100, finalTokens: 80, pipelineLatency: 10, upstreamLatency: 100 });
    statsEmitter.recordRequest({ baselineTokens: 100, finalTokens: 80, pipelineLatency: 20, upstreamLatency: 200 });
    statsEmitter.recordRequest({ baselineTokens: 100, finalTokens: 80, pipelineLatency: 30, upstreamLatency: 300 });
    // avg pipeline = (10 + 20 + 30) / 3 = 20
    expect(statsEmitter.session.avgPipelineLatency).toBeCloseTo(20, 0);
  });

  test("adds event to recentEvents", () => {
    statsEmitter.recordRequest({
      baselineTokens: 1000,
      finalTokens: 600,
      pipelineLatency: 10,
      upstreamLatency: 200
    });
    expect(statsEmitter.recentEvents.length).toBe(1);
    expect(statsEmitter.recentEvents[0].type).toBe("request");
  });

  test("caps recentEvents at maxRecentEvents", () => {
    for (let i = 0; i < statsEmitter.maxRecentEvents + 10; i++) {
      statsEmitter.recordRequest({
        baselineTokens: 100,
        finalTokens: 80,
        pipelineLatency: 5,
        upstreamLatency: 50
      });
    }
    expect(statsEmitter.recentEvents.length).toBe(statsEmitter.maxRecentEvents);
  });
});

// ── recordAgentAction ────────────────────────────────────────────────────────

describe("statsEmitter.recordAgentAction", () => {
  test("increments graphLookups", () => {
    statsEmitter.recordAgentAction("graphLookups");
    statsEmitter.recordAgentAction("graphLookups");
    expect(statsEmitter.agentActions.graphLookups).toBe(2);
  });

  test("increments surgicalReads", () => {
    statsEmitter.recordAgentAction("surgicalReads");
    expect(statsEmitter.agentActions.surgicalReads).toBe(1);
  });

  test("increments astPatches", () => {
    statsEmitter.recordAgentAction("astPatches");
    expect(statsEmitter.agentActions.astPatches).toBe(1);
  });

  test("increments rawVaultOpens", () => {
    statsEmitter.recordAgentAction("rawVaultOpens");
    expect(statsEmitter.agentActions.rawVaultOpens).toBe(1);
  });

  test("ignores unknown action types silently", () => {
    expect(() => {
      statsEmitter.recordAgentAction("unknownAction");
    }).not.toThrow();
    expect(statsEmitter.agentActions.graphLookups).toBe(0);
  });

  test("broadcasts after each action", (done) => {
    const listener = (snapshot) => {
      expect(snapshot.trigger).toBe("agent_action");
      statsEmitter.off("snapshot", listener);
      done();
    };
    statsEmitter.on("snapshot", listener);
    statsEmitter.recordAgentAction("graphLookups");
  });
});

// ── recordCacheHit ───────────────────────────────────────────────────────────

describe("statsEmitter.recordCacheHit", () => {
  test("tracks hits and calculates rate", () => {
    statsEmitter.recordCacheHit("semanticDedup", true);
    statsEmitter.recordCacheHit("semanticDedup", true);
    statsEmitter.recordCacheHit("semanticDedup", false);
    // 2 hits / 3 total = 66.67%
    expect(statsEmitter.cache.semanticDedup.hits).toBe(2);
    expect(statsEmitter.cache.semanticDedup.misses).toBe(1);
    expect(statsEmitter.cache.semanticDedup.rate).toBeCloseTo(66.67, 1);
  });

  test("tracks ragRetrieval separately", () => {
    statsEmitter.recordCacheHit("ragRetrieval", true);
    expect(statsEmitter.cache.ragRetrieval.hits).toBe(1);
    expect(statsEmitter.cache.semanticDedup.hits).toBe(0);
  });

  test("ignores unknown cache names silently", () => {
    expect(() => {
      statsEmitter.recordCacheHit("unknownCache", true);
    }).not.toThrow();
  });

  test("rate is 0 when no requests recorded", () => {
    expect(statsEmitter.cache.semanticDedup.rate).toBe(0);
  });
});

// ── getSnapshot ──────────────────────────────────────────────────────────────

describe("statsEmitter.getSnapshot", () => {
  test("returns snapshot with all required top-level keys", () => {
    const snapshot = statsEmitter.getSnapshot("test");
    expect(snapshot).toHaveProperty("trigger", "test");
    expect(snapshot).toHaveProperty("at");
    expect(snapshot).toHaveProperty("session");
    expect(snapshot).toHaveProperty("stages");
    expect(snapshot).toHaveProperty("cache");
    expect(snapshot).toHaveProperty("graph");
    expect(snapshot).toHaveProperty("agentActions");
    expect(snapshot).toHaveProperty("recentEvents");
    expect(snapshot).toHaveProperty("uptime");
  });

  test("agentActions in snapshot reflects current state", () => {
    statsEmitter.recordAgentAction("astPatches");
    statsEmitter.recordAgentAction("astPatches");
    const snapshot = statsEmitter.getSnapshot();
    expect(snapshot.agentActions.astPatches).toBe(2);
  });

  test("snapshot is a deep copy — mutations do not affect emitter state", () => {
    statsEmitter.recordAgentAction("graphLookups");
    const snapshot = statsEmitter.getSnapshot();
    snapshot.agentActions.graphLookups = 9999;
    expect(statsEmitter.agentActions.graphLookups).toBe(1);
  });

  test("uptime increases over time", async () => {
    const snap1 = statsEmitter.getSnapshot();
    await new Promise(r => setTimeout(r, 50));
    const snap2 = statsEmitter.getSnapshot();
    expect(snap2.uptime).toBeGreaterThan(snap1.uptime);
  });
});