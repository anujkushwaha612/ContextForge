/**
 * statsEmitter.js
 *
 * Central event bus for live dashboard metrics.
 * Pipeline stages push events here.
 * SSE clients subscribe and receive deltas in real-time.
 */

import { EventEmitter } from "node:events";

class StatsEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // Allow many dashboard tabs

    // ── Cumulative session metrics ──
    this.session = {
      startedAt: Date.now(),
      totalRequests: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      tokensSaved: 0,
      avgCompressionRatio: 0,
      avgPipelineLatency: 0,
      avgUpstreamLatency: 0,
      lastPipelineLatency: 0,
      lastUpstreamLatency: 0,
    };

    // ── Per-stage latency rolling averages ──
    this.stages = {}; // { stage_name: { totalMs, count, lastMs } }

    // ── Cache hit rates ──
    this.cache = {
      semanticDedup: { hits: 0, misses: 0, rate: 0 },
      ragRetrieval: { hits: 0, misses: 0, rate: 0 },
      contentDetector: { hits: 0, misses: 0, rate: 0 },
      cacheAligner: { hits: 0, misses: 0, rate: 0, streak: 0 },
    };

    // ── Agent Repository Operations ──
    this.agentActions = {
      graphLookups: 0,
      surgicalReads: 0,
      astPatches: 0,
      rawVaultOpens: 0,
    };

    // ── Graph stats ──
    this.graph = {
      nodes: 0,
      edges: 0,
      files: 0,
      lastQuery: null,
    };

    // ── Recent activity feed (last 20 events) ──
    this.recentEvents = [];
    this.maxRecentEvents = 20;

    // ── Periodic heartbeat broadcast ──
    // SE-1 FIX: .unref() — this interval kept the event loop alive forever,
    // so any embedder/importer of this module could never exit cleanly
    // (verified: process hung past its natural end). Also skip when no
    // dashboard is connected — getSnapshot() does a JSON deep-clone every
    // second; that's pure GC churn with zero listeners.
    const hb = setInterval(() => {
      if (this.listenerCount("snapshot") > 0) this.broadcast("heartbeat");
    }, 1000);
    hb.unref();
  }

  // ─────────────────────────────────────────────
  // Recorders — called from pipeline
  // ─────────────────────────────────────────────

  recordRequest({
    baselineTokens,
    finalTokens,
    pipelineLatency,
    upstreamLatency,
  }) {
    this.session.totalRequests++;
    this.session.tokensBefore += baselineTokens;
    this.session.tokensAfter += finalTokens;
    this.session.tokensSaved += baselineTokens - finalTokens;
    this.session.lastPipelineLatency = pipelineLatency;
    this.session.lastUpstreamLatency = upstreamLatency;

    // Rolling averages
    const n = this.session.totalRequests;
    this.session.avgCompressionRatio =
      this.session.tokensBefore > 0
        ? (this.session.tokensSaved / this.session.tokensBefore) * 100
        : 0;
    this.session.avgPipelineLatency =
      (this.session.avgPipelineLatency * (n - 1) + pipelineLatency) / n;
    this.session.avgUpstreamLatency =
      (this.session.avgUpstreamLatency * (n - 1) + upstreamLatency) / n;

    this.addRecentEvent({
      type: "request",
      tokensSaved: baselineTokens - finalTokens,
      // SE-2 FIX: baselineTokens=0 (empty passthrough pings) produced NaN
      // which then flowed into the dashboard JSON as null-after-serialize
      // and broke chart math client-side.
      compressionRatio:
        baselineTokens > 0
          ? ((baselineTokens - finalTokens) / baselineTokens) * 100
          : 0,
      pipelineLatency,
      upstreamLatency,
    });

    this.broadcast("request");
  }

  recordStage(stageName, ms) {
    if (!this.stages[stageName]) {
      this.stages[stageName] = { totalMs: 0, count: 0, lastMs: 0 };
    }
    const s = this.stages[stageName];
    s.totalMs += ms;
    s.count++;
    s.lastMs = ms;
  }

  recordCacheHit(cacheName, isHit) {
    if (!this.cache[cacheName]) return;
    const c = this.cache[cacheName];
    if (isHit) c.hits++;
    else c.misses++;
    const total = c.hits + c.misses;
    c.rate = total > 0 ? (c.hits / total) * 100 : 0;
  }

  recordCacheAlignStreak(streak, hitRate) {
    this.cache.cacheAligner.streak = streak;
    this.cache.cacheAligner.rate = hitRate;
  }

  updateGraphStats({ nodes, edges, files }) {
    this.graph.nodes = nodes ?? this.graph.nodes;
    this.graph.edges = edges ?? this.graph.edges;
    this.graph.files = files ?? this.graph.files;
  }

  recordGraphQuery(queryType, target) {
    this.graph.lastQuery = { queryType, target, at: Date.now() };
    this.addRecentEvent({
      type: "graph_query",
      queryType,
      target,
    });
    this.broadcast("graph");
  }

  recordVaultRetrieval(vaultId, chars) {
    this.addRecentEvent({
      type: "vault_open",
      vaultId,
      chars,
    });
    this.broadcast("vault");
  }

  addRecentEvent(event) {
    this.recentEvents.unshift({ ...event, at: Date.now() });
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.pop();
    }
  }

  recordAgentAction(actionType) {
    if (this.agentActions[actionType] !== undefined) {
      this.agentActions[actionType]++;
      this.broadcast("agent_action");
    }
  }

  // ─────────────────────────────────────────────
  // Broadcast — emit current snapshot to listeners
  // ─────────────────────────────────────────────

  broadcast(triggerType) {
    const snapshot = this.getSnapshot(triggerType);
    this.emit("snapshot", snapshot);
  }

  getSnapshot(triggerType = "manual") {
    return {
      trigger: triggerType,
      at: Date.now(),
      session: { ...this.session },
      // SE-3 FIX: shallow spread shared the INNER per-stage objects — any
      // consumer mutating a snapshot (dashboard code, tests) corrupted the
      // live counters. Verified: writing to snapshot.stages.X.totalMs
      // changed the emitter's real state.
      stages: Object.fromEntries(
        Object.entries(this.stages).map(([k, v]) => [k, { ...v }])
      ),
      cache: JSON.parse(JSON.stringify(this.cache)),
      graph: { ...this.graph, lastQuery: this.graph.lastQuery ? { ...this.graph.lastQuery } : null },
      agentActions: { ...this.agentActions },
      recentEvents: this.recentEvents.map((ev) => ({ ...ev })),
      uptime: Date.now() - this.session.startedAt,
    };
  }
}

export const statsEmitter = new StatsEmitter();
