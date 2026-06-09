/**
 * Durable savings tracking with per-model pricing and historical rollups.
 *
 * Port of headroom/proxy/savings_tracker.py
 *
 * Improvements over your current logRequest():
 * - Atomic writes (crash-safe temp file rename)
 * - Hourly/daily/weekly/monthly rollups
 * - Display sessions with inactivity-based rollover
 * - Per-model pricing via a pricing registry
 * - Survives proxy restarts
 * - Thread-safe (single-process, but async-safe via write queue)
 */

import fs   from "node:fs";
import path from "node:path";
import os   from "node:os";

// ─────────────────────────────────────────────
// Per-model pricing (USD per 1M tokens)
// Extend this as you add new model routes
// Headroom uses LiteLLM; we use a static registry
// ─────────────────────────────────────────────

const MODEL_PRICING = {
  // Anthropic
  "claude-opus-4":          { input: 15.00,  output: 75.00  },
  "claude-sonnet-4":        { input: 3.00,   output: 15.00  },
  "claude-haiku-4":         { input: 0.80,   output: 4.00   },
  "claude-opus-4-5":        { input: 15.00,  output: 75.00  },
  "claude-sonnet-4-5":      { input: 3.00,   output: 15.00  },

  // OpenAI
  "gpt-4o":                 { input: 2.50,   output: 10.00  },
  "gpt-4o-mini":            { input: 0.15,   output: 0.60   },
  "gpt-4-turbo":            { input: 10.00,  output: 30.00  },
  "o1":                     { input: 15.00,  output: 60.00  },
  "o3-mini":                { input: 1.10,   output: 4.40   },

  // Groq (very cheap)
  "llama-3.3-70b":          { input: 0.59,   output: 0.79   },
  "mixtral-8x7b":           { input: 0.27,   output: 0.27   },
  "gemma2-9b":              { input: 0.20,   output: 0.20   },

  // Nemotron
  "nemotron":               { input: 4.00,   output: 4.00   },

  // Local (free)
  "ollama":                 { input: 0.00,   output: 0.00   },
  "minimax-m3:cloud":       { input: 0.80,   output: 2.40   },

  // Default fallback
  "default":                { input: 1.00,   output: 3.00   },
};

function getPricing(modelName) {
  const lower = (modelName || "").toLowerCase();

  // Exact match first
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower === key || lower.startsWith(key)) return pricing;
  }

  // Prefix match
  if (lower.includes("claude-opus"))   return MODEL_PRICING["claude-opus-4"];
  if (lower.includes("claude-sonnet")) return MODEL_PRICING["claude-sonnet-4"];
  if (lower.includes("claude-haiku"))  return MODEL_PRICING["claude-haiku-4"];
  if (lower.includes("gpt-4o-mini"))   return MODEL_PRICING["gpt-4o-mini"];
  if (lower.includes("gpt-4o"))        return MODEL_PRICING["gpt-4o"];
  if (lower.includes("nemotron"))      return MODEL_PRICING["nemotron"];
  if (lower.includes("ollama") || lower.includes(":latest")) return MODEL_PRICING["ollama"];
  if (lower.includes("groq") || lower.includes("llama"))    return MODEL_PRICING["llama-3.3-70b"];

  return MODEL_PRICING["default"];
}

function estimateSavingsUsd(modelName, tokensSaved) {
  if (tokensSaved <= 0) return 0;
  const pricing = getPricing(modelName);
  return (tokensSaved / 1_000_000) * pricing.input;
}

function estimateInputCostUsd(modelName, inputTokens) {
  if (inputTokens <= 0) return 0;
  const pricing = getPricing(modelName);
  return (inputTokens / 1_000_000) * pricing.input;
}

// ─────────────────────────────────────────────
// Time utilities
// ─────────────────────────────────────────────

function utcNow() {
  return new Date();
}

function toUtcIso(dt) {
  return dt.toISOString().replace(".000Z", "Z");
}

function bucketStart(timestamp, bucket) {
  const dt = new Date(timestamp);
  if (bucket === "hour") {
    dt.setUTCMinutes(0, 0, 0);
    return dt;
  }
  if (bucket === "day") {
    dt.setUTCHours(0, 0, 0, 0);
    return dt;
  }
  if (bucket === "week") {
    dt.setUTCHours(0, 0, 0, 0);
    dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
    return dt;
  }
  if (bucket === "month") {
    dt.setUTCDate(1);
    dt.setUTCHours(0, 0, 0, 0);
    return dt;
  }
  throw new Error(`Unknown bucket: ${bucket}`);
}

// ─────────────────────────────────────────────
// SavingsTracker
// ─────────────────────────────────────────────

const SCHEMA_VERSION = 2;
const DEFAULT_MAX_HISTORY_POINTS = 5000;
const DEFAULT_MAX_HISTORY_AGE_DAYS = 365;
const DEFAULT_DISPLAY_SESSION_INACTIVITY_MINUTES = 60;
const DEFAULT_MAX_RESPONSE_HISTORY_POINTS = 500;

function emptyDisplaySession() {
  return {
    requests:                0,
    tokens_saved:            0,
    compression_savings_usd: 0,
    total_input_tokens:      0,
    total_input_cost_usd:    0,
    savings_percent:         0,
    started_at:              null,
    last_activity_at:        null,
  };
}

function defaultLifetime() {
  return {
    requests:                0,
    tokens_saved:            0,
    compression_savings_usd: 0,
    total_input_tokens:      0,
    total_input_cost_usd:    0,
  };
}

export class SavingsTracker {
  constructor({
    filePath                        = null,
    maxHistoryPoints                = DEFAULT_MAX_HISTORY_POINTS,
    maxHistoryAgeDays               = DEFAULT_MAX_HISTORY_AGE_DAYS,
    displaySessionInactivityMinutes = DEFAULT_DISPLAY_SESSION_INACTIVITY_MINUTES,
    maxResponseHistoryPoints        = DEFAULT_MAX_RESPONSE_HISTORY_POINTS,
  } = {}) {
    this._filePath = filePath || this._defaultPath();
    this._maxHistoryPoints                = maxHistoryPoints;
    this._maxHistoryAgeDays               = maxHistoryAgeDays;
    this._displaySessionInactivityMs      = displaySessionInactivityMinutes * 60 * 1000;
    this._maxResponseHistoryPoints        = maxResponseHistoryPoints;

    // Write queue — prevents concurrent writes corrupting the file
    this._writeQueue = Promise.resolve();

    this._state = this._loadState();
  }

  _defaultPath() {
    const envPath = process.env.CF_SAVINGS_PATH;
    if (envPath) return envPath;
    return path.join(os.homedir(), ".contextforge", "proxy_savings.json");
  }

  // ─────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────

  /**
   * Record a request with compression savings.
   * This is the main method called after each pipeline run.
   */
  recordRequest({
    model,
    inputTokens,
    tokensSaved,
    timestamp = null,
  }) {
    const ts              = timestamp ? new Date(timestamp) : utcNow();
    const deltaTokensSaved = Math.max(0, tokensSaved || 0);
    const deltaInput       = Math.max(0, inputTokens || 0);
    const deltaSavingsUsd  = estimateSavingsUsd(model, deltaTokensSaved);
    const deltaInputCostUsd = estimateInputCostUsd(model, deltaInput);

    const lifetime = this._state.lifetime;
    lifetime.requests                += 1;
    lifetime.tokens_saved            += deltaTokensSaved;
    lifetime.compression_savings_usd += deltaSavingsUsd;
    lifetime.total_input_tokens      += deltaInput;
    lifetime.total_input_cost_usd    += deltaInputCostUsd;

    // Display session management
    this._updateDisplaySession({
      ts,
      deltaTokensSaved,
      deltaInput,
      deltaSavingsUsd,
      deltaInputCostUsd,
    });

    // History point (only when compression occurred)
    if (deltaTokensSaved > 0) {
      this._state.history.push({
        timestamp:               toUtcIso(ts),
        total_tokens_saved:      lifetime.tokens_saved,
        compression_savings_usd: parseFloat(lifetime.compression_savings_usd.toFixed(6)),
        total_input_tokens:      lifetime.total_input_tokens,
        total_input_cost_usd:    parseFloat(lifetime.total_input_cost_usd.toFixed(6)),
      });
      this._trimHistory(ts);
    }

    // Enqueue atomic write (non-blocking)
    this._writeQueue = this._writeQueue
      .then(() => this._saveAtomic())
      .catch((err) => console.error("[SavingsTracker] Write failed:", err.message));
  }

  _updateDisplaySession({ ts, deltaTokensSaved, deltaInput, deltaSavingsUsd, deltaInputCostUsd }) {
    let session = this._state.display_session;
    const lastActivity = session.last_activity_at
      ? new Date(session.last_activity_at)
      : null;

    const isExpired =
      lastActivity === null ||
      ts - lastActivity > this._displaySessionInactivityMs;

    if (isExpired) {
      session = emptyDisplaySession();
      session.started_at = toUtcIso(ts);
      this._state.display_session = session;
    }

    session.requests                += 1;
    session.tokens_saved            += deltaTokensSaved;
    session.compression_savings_usd += deltaSavingsUsd;
    session.total_input_tokens      += deltaInput;
    session.total_input_cost_usd    += deltaInputCostUsd;
    session.last_activity_at         = toUtcIso(ts);

    if (!session.started_at) session.started_at = session.last_activity_at;

    const totalBefore = session.tokens_saved + session.total_input_tokens;
    session.savings_percent = totalBefore > 0
      ? parseFloat(((session.tokens_saved / totalBefore) * 100).toFixed(2))
      : 0;
  }

  /**
   * Get a snapshot of current stats.
   */
  snapshot() {
    return {
      schema_version:  SCHEMA_VERSION,
      storage_path:    this._filePath,
      lifetime:        { ...this._state.lifetime },
      display_session: this._displaySessionSnapshot(),
      history:         [...this._state.history],
      retention: {
        max_history_points:    this._maxHistoryPoints,
        max_history_age_days:  this._maxHistoryAgeDays,
      },
    };
  }

  /**
   * Stats preview for /stats endpoint.
   */
  statsPreview(recentPoints = 20) {
    const snap = this.snapshot();
    return {
      schema_version:   snap.schema_version,
      storage_path:     snap.storage_path,
      lifetime:         snap.lifetime,
      display_session:  snap.display_session,
      history_points:   snap.history.length,
      recent_history:   snap.history.slice(-recentPoints),
    };
  }

  /**
   * Full history response with rollups.
   */
  historyResponse() {
    const snap = this.snapshot();
    const raw  = snap.history;

    return {
      schema_version:  snap.schema_version,
      generated_at:    toUtcIso(utcNow()),
      lifetime:        snap.lifetime,
      display_session: snap.display_session,
      history:         this._compactHistory(raw),
      series: {
        hourly:  this._buildRollup(raw, "hour"),
        daily:   this._buildRollup(raw, "day"),
        weekly:  this._buildRollup(raw, "week"),
        monthly: this._buildRollup(raw, "month"),
      },
    };
  }

  // ─────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────

  _displaySessionSnapshot() {
    const session = { ...this._state.display_session };
    const lastActivity = session.last_activity_at
      ? new Date(session.last_activity_at)
      : null;

    if (!lastActivity || utcNow() - lastActivity > this._displaySessionInactivityMs) {
      return emptyDisplaySession();
    }
    return session;
  }

  _trimHistory(referenceTime) {
    let history = this._state.history;

    // Age trimming
    if (this._maxHistoryAgeDays > 0) {
      const cutoff = new Date(referenceTime);
      cutoff.setDate(cutoff.getDate() - this._maxHistoryAgeDays);
      history = history.filter((item) => new Date(item.timestamp) >= cutoff);
      if (history.length === 0 && this._state.history.length > 0) {
        history = [this._state.history[this._state.history.length - 1]];
      }
    }

    // Count trimming
    if (this._maxHistoryPoints > 0 && history.length > this._maxHistoryPoints) {
      history = history.slice(-this._maxHistoryPoints);
    }

    this._state.history = history;
  }

  _compactHistory(history) {
    if (history.length <= this._maxResponseHistoryPoints) {
      return [...history];
    }

    // Keep recent tail dense, sample older points
    const recentPoints = Math.min(
      Math.max(Math.floor(this._maxResponseHistoryPoints / 3), 50),
      this._maxResponseHistoryPoints - 1
    );
    const recent = history.slice(-recentPoints);
    const older  = history.slice(0, -recentPoints);
    const olderSlots = this._maxResponseHistoryPoints - recent.length;

    let sampledOlder = [];
    if (olderSlots > 0 && older.length > 0) {
      if (olderSlots === 1) {
        sampledOlder = [older[0]];
      } else {
        for (let i = 0; i < olderSlots; i++) {
          const idx = Math.round(((older.length - 1) * i) / (olderSlots - 1));
          sampledOlder.push(older[idx]);
        }
      }
    }

    // Deduplicate by timestamp
    const seen = new Set();
    const compacted = [];
    for (const point of [...sampledOlder, ...recent]) {
      if (!seen.has(point.timestamp)) {
        seen.add(point.timestamp);
        compacted.push({ ...point });
      }
    }
    return compacted;
  }

  _buildRollup(history, bucket) {
    if (!history.length) return [];

    const aggregated = new Map();
    let prevTotalTokens   = 0;
    let prevTotalUsd      = 0;
    let prevTotalInput    = 0;
    let prevTotalInputUsd = 0;

    for (const point of history) {
      const ts           = new Date(point.timestamp);
      const bucketKey    = toUtcIso(bucketStart(ts, bucket));
      const totalTokens  = point.total_tokens_saved || 0;
      const totalUsd     = point.compression_savings_usd || 0;
      const totalInput   = point.total_input_tokens || 0;
      const totalInputUsd = point.total_input_cost_usd || 0;

      const deltaTokens   = Math.max(totalTokens - prevTotalTokens, 0);
      const deltaUsd      = Math.max(totalUsd - prevTotalUsd, 0);
      const deltaInput    = Math.max(totalInput - prevTotalInput, 0);
      const deltaInputUsd = Math.max(totalInputUsd - prevTotalInputUsd, 0);

      prevTotalTokens   = totalTokens;
      prevTotalUsd      = totalUsd;
      prevTotalInput    = totalInput;
      prevTotalInputUsd = totalInputUsd;

      if (!aggregated.has(bucketKey)) {
        aggregated.set(bucketKey, {
          timestamp:                      bucketKey,
          tokens_saved:                   0,
          compression_savings_usd_delta:  0,
          total_tokens_saved:             totalTokens,
          compression_savings_usd:        totalUsd,
          total_input_tokens_delta:       0,
          total_input_tokens:             totalInput,
          total_input_cost_usd_delta:     0,
          total_input_cost_usd:           totalInputUsd,
        });
      }

      const entry = aggregated.get(bucketKey);
      entry.tokens_saved                  += deltaTokens;
      entry.compression_savings_usd_delta += deltaUsd;
      entry.total_input_tokens_delta      += deltaInput;
      entry.total_input_cost_usd_delta    += deltaInputUsd;
      entry.total_tokens_saved             = totalTokens;
      entry.compression_savings_usd        = parseFloat(totalUsd.toFixed(6));
      entry.total_input_tokens             = totalInput;
      entry.total_input_cost_usd           = parseFloat(totalInputUsd.toFixed(6));
    }

    return [...aggregated.values()];
  }

  // ─────────────────────────────────────────────
  // Persistence — atomic write via temp file rename
  // ─────────────────────────────────────────────

  async _saveAtomic() {
    const dir     = path.dirname(this._filePath);
    const tmpFile = path.join(dir, `.cf_savings_${Date.now()}_${process.pid}.tmp`);

    const payload = JSON.stringify({
      schema_version:  SCHEMA_VERSION,
      lifetime:        this._state.lifetime,
      display_session: this._state.display_session,
      history:         this._state.history,
    }, null, 2);

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpFile, payload, "utf-8");
      fs.renameSync(tmpFile, this._filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      throw err;
    }
  }

  _loadState() {
    const defaultState = {
      schema_version:  SCHEMA_VERSION,
      lifetime:        defaultLifetime(),
      display_session: emptyDisplaySession(),
      history:         [],
    };

    if (!fs.existsSync(this._filePath)) return defaultState;

    try {
      const raw = JSON.parse(fs.readFileSync(this._filePath, "utf-8"));
      return this._sanitizeState(raw) || defaultState;
    } catch (err) {
      console.warn(`[SavingsTracker] Failed to load ${this._filePath}: ${err.message}`);
      return defaultState;
    }
  }

  _sanitizeState(raw) {
    if (!raw || typeof raw !== "object") return null;

    // Normalize history entries
    const history = (raw.history || [])
      .filter((item) => item && item.timestamp)
      .map((item) => ({
        timestamp:               item.timestamp,
        total_tokens_saved:      Math.max(0, item.total_tokens_saved || 0),
        compression_savings_usd: Math.max(0, item.compression_savings_usd || 0),
        total_input_tokens:      Math.max(0, item.total_input_tokens || 0),
        total_input_cost_usd:    Math.max(0, item.total_input_cost_usd || 0),
      }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const lifetime = raw.lifetime || {};

    return {
      schema_version: SCHEMA_VERSION,
      lifetime: {
        requests:                Math.max(0, lifetime.requests || 0),
        tokens_saved:            Math.max(0, lifetime.tokens_saved || 0),
        compression_savings_usd: Math.max(0, lifetime.compression_savings_usd || 0),
        total_input_tokens:      Math.max(0, lifetime.total_input_tokens || 0),
        total_input_cost_usd:    Math.max(0, lifetime.total_input_cost_usd || 0),
      },
      display_session: emptyDisplaySession(),
      history,
    };
  }
}

// ─────────────────────────────────────────────
// Process-wide singleton
// ─────────────────────────────────────────────

export const savingsTracker = new SavingsTracker();