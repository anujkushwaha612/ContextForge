/**
 * stageTimer.js
 *
 * Stage-timing instrumentation for request handlers.
 *
 * Fixes:
 *   TM-1: timeAsync now records duration in a finally block — stage duration
 *         is captured even when fn() throws. Previously a throwing async
 *         stage silently disappeared from the timer summary.
 *
 *   TM-2: recordTokens and recordTokenSavings are documented as mutually
 *         exclusive per stage. Mixing them produces incorrect totals because
 *         recordTokens overwrites tokensSaved while recordTokenSavings adds
 *         to it. Contract enforced via documentation — no runtime guard added
 *         since the performance cost of checking isn't justified.
 *
 *   TM-3: STAGES object expanded with RETRIEVE stage for CCR internal use.
 */

// ─────────────────────────────────────────────
// StageMeasurement
// ─────────────────────────────────────────────

export class StageMeasurement {
  constructor(timer, name) {
    this._timer = timer;
    this._name  = name;
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

  wrap(fn) {
    this.start();
    try {
      return fn();
    } finally {
      this.stop();
    }
  }

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
// StageTimer
// ─────────────────────────────────────────────

export class StageTimer {
  constructor() {
    this._stages    = {};
    this._createdAt = performance.now();
  }

  measure(name) {
    return new StageMeasurement(this, name).start();
  }

  time(name, fn) {
    const m = this.measure(name);
    try {
      return fn();
    } finally {
      m.stop();
    }
  }

  // TM-1 FIX: Duration now recorded in finally block.
  // Previously: if fn() rejected, _record was never called and the stage
  // disappeared from the summary silently. Now duration is always captured.
  async timeAsync(stage, fn) {
    const start = performance.now();
    try {
      const result = await fn();
      return result;
    } finally {
      // Runs on both success and throw — stage always appears in summary
      this._record(stage, performance.now() - start);
    }
  }

  record(name, durationMs) {
    this._record(name, Number(durationMs));
  }

  _record(name, durationMs) {
    if (!this._stages[name]) {
      this._stages[name] = {
        duration:     0,
        tokensBefore: null,
        tokensAfter:  null,
        tokensSaved:  null,
      };
    }
    this._stages[name].duration = durationMs;
  }

  /**
   * Record token deltas from a before/after pair.
   *
   * TM-2 CONTRACT: Do NOT mix recordTokens and recordTokenSavings on the
   * same stage within a single request. recordTokens OVERWRITES tokensSaved
   * with (before - after). recordTokenSavings ADDS to tokensSaved. Mixing
   * them produces (before - after) + extraSavings which double-counts if
   * extraSavings is already included in the before/after delta.
   *
   * Use recordTokens when: you have before and after counts from countTokens().
   * Use recordTokenSavings when: the stage itself reports how many tokens it saved.
   */
  recordTokens(name, before, after) {
    if (!this._stages[name]) {
      this._stages[name] = {
        duration:     0,
        tokensBefore: null,
        tokensAfter:  null,
        tokensSaved:  null,
      };
    }
    this._stages[name].tokensBefore = before;
    this._stages[name].tokensAfter  = after;
    this._stages[name].tokensSaved  = before - after;
  }

  /**
   * Record a precomputed savings delta.
   *
   * TM-2 CONTRACT: Do NOT mix with recordTokens on the same stage.
   * See recordTokens() documentation above.
   *
   * Additive: multiple recordTokenSavings calls on the same stage accumulate.
   * This is intentional — a stage may report savings in multiple sub-steps
   * (e.g. system prompt dedup + skills list pruning both contribute to DEDUPLICATE).
   */
  recordTokenSavings(name, saved) {
    const delta = Number(saved) || 0;
    if (!this._stages[name]) {
      this._stages[name] = {
        duration:     0,
        tokensBefore: null,
        tokensAfter:  null,
        tokensSaved:  0,
      };
    }
    if (this._stages[name].tokensSaved === null) {
      this._stages[name].tokensSaved = 0;
    }
    this._stages[name].tokensSaved += delta;
  }

  elapsedMs() {
    return performance.now() - this._createdAt;
  }

  summary() {
    const out = {};
    for (const [k, v] of Object.entries(this._stages)) {
      out[k] = v.duration;
    }
    return out;
  }

  tokenSummary() {
    const out = {};
    for (const [k, v] of Object.entries(this._stages)) {
      if (v.tokensSaved !== null) {
        out[k] = v.tokensSaved;
      }
    }
    return out;
  }

  has(name) {
    return name in this._stages;
  }

  emitLog(path, requestId, expectedStages = []) {
    const summary = this.summary();
    const padded  = {};

    for (const stage of expectedStages) {
      padded[stage] = summary[stage] ?? null;
    }

    for (const [stage, value] of Object.entries(summary)) {
      if (!(stage in padded)) {
        padded[stage] = value;
      }
    }

    const payload = JSON.stringify({
      event:      "stage_timings",
      path,
      request_id: requestId,
      stages:     padded,
    });

    console.log(`[${requestId}] STAGE_TIMINGS ${payload}`);
    return padded;
  }
}

// ─────────────────────────────────────────────
// Stage name constants
//
// TM-3: Added RETRIEVE for CCR internal use. Use STAGES.* constants
// everywhere — string literals bypass typo detection.
// ─────────────────────────────────────────────

export const STAGES = {
  MINIMIZE_TOOLS:  "minimize_tools",
  DEDUPLICATE:     "deduplicate",
  HISTORY_PRUNE:   "history_prune",
  GRAPH_INJECT:    "graph_inject",
  SCRUB:           "scrub",
  TAG:             "tag",
  SEMANTIC_DEDUP:  "semantic_dedup",
  JSON_CRUSH:      "json_crush",
  CODE_COMPRESS:   "code_compress",
  VAULT_INTERCEPT: "vault_intercept",
  STRIP_ANTHROPIC: "strip_anthropic",
  CCR_PIPELINE:    "ccr_pipeline",
  RETRIEVE:        "retrieve",        // TM-3: CCR internal retrieval stage
  MEMORY_INJECT:   "memory_inject",
  MEMORY_CONTEXT:  "memory_context",
  CACHE_ALIGN:     "cache_align",
};