/**
 * Stage-timing instrumentation for request handlers.
 *
 * Port of headroom/proxy/stage_timer.py
 *
 * Design goals:
 *   1. Durations captured even if measured body throws
 *   2. Single StageTimer holds all stages for one request
 *   3. Uses performance.now() for monotonic high-resolution measurement
 *   4. Zero external dependencies
 *
 * Usage:
 *   const timer = new StageTimer();
 *
 *   // Synchronous
 *   using(timer.measure("translation"), () => {
 *     payload = translateAnthropicToOpenAI(payload);
 *   });
 *
 *   // Or manual
 *   const t = timer.start("compression");
 *   payload = compressionEngine(payload);
 *   t.stop();
 *
 *   console.log(timer.summary());
 *   // { translation: 2.3, compression: 45.1 }
 */

// ─────────────────────────────────────────────
// StageMeasurement — tracks one named stage
// ─────────────────────────────────────────────

export class StageMeasurement {
  constructor(timer, name) {
    this._timer = timer;
    this._name = name;
    this._start = null;
  }

  start() {
    this._start = performance.now();
    return this;
  }

  stop() {
    if (this._start === null) return;
    const durationMs = performance.now() - this._start;
    this._timer._record(this._name, durationMs);
    this._start = null;
  }

  /**
   * Wrap a synchronous function call.
   * Duration is recorded even if the function throws.
   */
  wrap(fn) {
    this.start();
    try {
      return fn();
    } finally {
      this.stop();
    }
  }

  /**
   * Wrap an async function call.
   */
  async wrapAsync(fn) {
    this.start();
    try {
      return await fn();
    } finally {
      this.stop();
    }
  }
}

// ─────────────────────────────────────────────
// StageTimer — collects all stages for one request
// ─────────────────────────────────────────────

export class StageTimer {
  constructor() {
    this._stages = {};
    this._createdAt = performance.now();
  }

  /**
   * Create and start a StageMeasurement for the named stage.
   * Call .stop() when done, or use .wrap() / .wrapAsync().
   */
  measure(name) {
    return new StageMeasurement(this, name).start();
  }

  /**
   * Convenience: time a synchronous function.
   *
   * const result = timer.time("translation", () => translate(payload));
   */
  time(name, fn) {
    const m = this.measure(name);
    try {
      return fn();
    } finally {
      m.stop();
    }
  }

  /**
   * Convenience: time an async function.
   *
   * const result = await timer.timeAsync("compression", () => compress(payload));
   */
  async timeAsync(stage, fn) {
    const start = performance.now();
    const result = await fn();
    this._stages[stage] = performance.now() - start;
    return result;
  }

  /**
   * Record a pre-computed duration (e.g. from an existing timer).
   */
  record(name, durationMs) {
    this._stages[name] = Number(durationMs);
  }

  _record(name, durationMs) {
    this._stages[name] = durationMs;
  }

  /**
   * Total milliseconds since StageTimer was created.
   */
  elapsedMs() {
    return performance.now() - this._createdAt;
  }

  /**
   * Snapshot of all recorded stage durations in milliseconds.
   */
  summary() {
    return { ...this._stages };
  }

  has(name) {
    return name in this._stages;
  }

  /**
   * Emit a structured log line of stage timings.
   *
   * @param {string}   path           - Request path
   * @param {string}   requestId      - Request ID for correlation
   * @param {string[]} expectedStages - All stages to include (null for missing ones)
   */
  emitLog(path, requestId, expectedStages = []) {
    const summary = this.summary();
    const padded = {};

    // Include all expected stages (null for ones that never ran)
    for (const stage of expectedStages) {
      padded[stage] = summary[stage] ?? null;
    }

    // Include any extra stages recorded but not in expectedStages
    for (const [stage, value] of Object.entries(summary)) {
      if (!(stage in padded)) {
        padded[stage] = value;
      }
    }

    const payload = JSON.stringify({
      event: "stage_timings",
      path,
      request_id: requestId,
      stages: padded,
    });

    console.log(`[${requestId}] STAGE_TIMINGS ${payload}`);
    return padded;
  }
}

// ─────────────────────────────────────────────
// Stage name constants — prevents typos
// ─────────────────────────────────────────────

// src/proxy/stageTimer.js

export const STAGES = {
  TRANSLATION: "translation",
  SCRUB: "scrub",
  TAG: "tag",
  PRUNE: "prune",
  SLICE_CODE: "slice_code",
  CODE_COMPRESS: "code_compress",
  PREDICTIVE: "predictive_injection",
  VAULT_INTERCEPT: "vault_intercept",
  STRIP_ANTHROPIC: "strip_anthropic",
  CCR_PIPELINE: "ccr_pipeline",
  MINIMIZE_TOOLS: "minimize_tools",
  DEDUPLICATE: "deduplicate",
  EGRESS: "egress", // if you time the upstream request
  TOTAL: "total",
  MEMORY_INJECT: "memory_inject",
  MEMORY_CONTEXT: "memory_context",
  SEMANTIC_DEDUP: "semantic_dedup",
  CACHE_ALIGN: "cache_align",
  GRAPH_INJECT: "graph_inject",
};
