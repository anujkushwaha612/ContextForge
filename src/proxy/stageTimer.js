/**
 * Stage-timing instrumentation for request handlers.
 *
 * Design goals:
 *   1. Durations captured even if measured body throws
 *   2. Single StageTimer holds all stages for one request
 *   3. Uses performance.now() for monotonic high-resolution measurement
 *   4. Zero external dependencies
 *   5. Optional per-stage token delta tracking (two APIs):
 *        - recordTokens(name, before, after)  — computes savings
 *        - recordTokenSavings(name, saved)    — direct delta from caller
 */

// ─────────────────────────────────────────────
// StageMeasurement — tracks one named stage
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
// StageTimer — collects all stages for one request
// ─────────────────────────────────────────────

export class StageTimer {
  constructor() {
    // Structure: {
    //   [name]: {
    //     duration:     number,
    //     tokensBefore: number|null,
    //     tokensAfter:  number|null,
    //     tokensSaved:  number|null
    //   }
    // }
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

  async timeAsync(stage, fn) {
    const start  = performance.now();
    const result = await fn();
    this._record(stage, performance.now() - start);
    return result;
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
   * Record token deltas for a specific stage from a before/after pair.
   * Used when the caller has both counts (e.g. semantic dedup measuring
   * payload size pre- and post-stage).
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
   * Record a precomputed savings delta for a specific stage.
   * Used when the stage itself reports how many tokens it saved
   * (e.g. minimizeToolSchemas attaches _cf_minimizeTokensSaved to the
   * payload, server.js reads it and forwards via this method).
   *
   * Additive: if a stage records savings multiple times in one request,
   * they accumulate. This matches the semantics of recordTokens(), which
   * overwrites — recordTokens is "I measured the total delta", while
   * recordTokenSavings is "this sub-step contributed N more tokens saved".
   *
   * @param {string} name   Stage name (use STAGES.* constants)
   * @param {number} saved  Tokens saved (positive number)
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

  /**
   * Returns a flat object of stage durations (backward compatible).
   */
  summary() {
    const out = {};
    for (const [k, v] of Object.entries(this._stages)) {
      out[k] = v.duration;
    }
    return out;
  }

  /**
   * Returns a flat object of per-stage token savings.
   * Only stages that recorded token data are included.
   */
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
// Stage name constants — prevents typos
// ─────────────────────────────────────────────

export const STAGES = {
  TRANSLATION:      "translation",
  SCRUB:            "scrub",
  TAG:              "tag",

  CODE_COMPRESS:    "code_compress",
  PREDICTIVE:       "predictive_injection",
  VAULT_INTERCEPT:  "vault_intercept",
  STRIP_ANTHROPIC:  "strip_anthropic",
  CCR_PIPELINE:     "ccr_pipeline",
  MINIMIZE_TOOLS:   "minimize_tools",
  DEDUPLICATE:      "deduplicate",
  EGRESS:           "egress",
  TOTAL:            "total",
  MEMORY_INJECT:    "memory_inject",
  MEMORY_CONTEXT:   "memory_context",
  SEMANTIC_DEDUP:   "semantic_dedup",
 CACHE_ALIGN: "cache_align",
 BUDGET_ENFORCER: "budget_enforcer",
 GRAPH_INJECT: "graph_inject",
 SYS_PROMPT_PRUNE: "sys_prompt_prune",
};