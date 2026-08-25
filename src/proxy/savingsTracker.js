/**
 * savingsTracker.js
 *
 * Tracks token savings across requests, sessions, and lifetime.
 *
 * Fixes:
 *   ST-1: Multi-hop negative tokensSaved values are preserved and displayed
 *         honestly. getSummary now clarifies negative = multi-hop overhead.
 *   ST-3: Persisted `ghost_retries` remains backward-compatible, but display
 *         labels call these ghost hops: successful internal tool continuations
 *         are not failures or retries.
 *
 *   ST-2: History trimming unchanged — documented that file can reach
 *         ~500KB for heavy usage at default maxHistoryPoints=5000.
 */

import fs from "node:fs";
import path from "node:path";

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

const SCHEMA_VERSION = 4;

const DEFAULT_MAX_HISTORY_POINTS = 5000;
const DEFAULT_MAX_HISTORY_AGE_DAYS = 365;
const DEFAULT_DISPLAY_SESSION_INACTIVITY_MINUTES = 60;
const DEFAULT_MAX_RESPONSE_HISTORY_POINTS = 500;

function emptyDisplaySession() {
  return {
    requests: 0,
    tokens_before: 0,
    tokens_after: 0,
    tokens_saved: 0,
    compression_ratio: 0,
    cache_read_tokens: 0,
    started_at: null,
    last_activity_at: null,
    ghost_retries: 0,
    requests_with_retries: 0,
  };
}

function defaultLifetime() {
  return {
    requests: 0,
    tokens_before: 0,
    tokens_after: 0,
    tokens_saved: 0,
    cache_read_tokens: 0,
    ghost_retries: 0,
    requests_with_retries: 0,
  };
}

export class SavingsTracker {
  constructor({
    filePath = null,
    maxHistoryPoints = DEFAULT_MAX_HISTORY_POINTS,
    maxHistoryAgeDays = DEFAULT_MAX_HISTORY_AGE_DAYS,
    displaySessionInactivityMinutes = DEFAULT_DISPLAY_SESSION_INACTIVITY_MINUTES,
    maxResponseHistoryPoints = DEFAULT_MAX_RESPONSE_HISTORY_POINTS,
  } = {}) {
    this._filePath = filePath || this._defaultPath();
    this._maxHistoryPoints = maxHistoryPoints;
    this._maxHistoryAgeDays = maxHistoryAgeDays;
    this._displaySessionInactivityMs = displaySessionInactivityMinutes * 60 * 1000;
    this._maxResponseHistoryPoints = maxResponseHistoryPoints;
    this._writeQueue = Promise.resolve();
    this._state = this._loadState();
  }

  _defaultPath() {
    const envPath = process.env.CF_SAVINGS_PATH;
    if (envPath) return envPath;
    return path.join(process.cwd(), "CF-savings", "proxy_savings.json");
  }

  recordRequest({
    baselineTokens,
    wireTokens,
    tokensSaved,
    timestamp = null,
    ghostRetries = 0,
    cacheReadTokens = 0,
  }) {
    const ts = timestamp ? new Date(timestamp) : utcNow();

    const deltaBaseline = Math.max(0, baselineTokens || 0);
    const deltaWire = Math.max(0, wireTokens || 0);
    const deltaSaved = typeof tokensSaved === "number" ? tokensSaved : deltaBaseline - deltaWire;

    const lt = this._state.lifetime;
    lt.requests += 1;
    lt.tokens_before += deltaBaseline;
    lt.tokens_after += deltaWire;
    lt.tokens_saved += deltaSaved;
    lt.cache_read_tokens += cacheReadTokens || 0;

    if (ghostRetries > 0) {
      lt.ghost_retries += ghostRetries;
      lt.requests_with_retries += 1;
    }

    this._updateDisplaySession({
      ts,
      deltaBaseline,
      deltaWire,
      deltaSaved,
      ghostRetries,
      cacheReadTokens,
    });

    this._state.history.push({
      timestamp: toUtcIso(ts),
      total_tokens_saved: lt.tokens_saved,
      total_tokens_before: lt.tokens_before,
      total_tokens_after: lt.tokens_after,
    });
    this._trimHistory(ts);

    this._writeQueue = this._writeQueue
      .then(() => this._saveAtomic())
      .catch((err) => console.error("[SavingsTracker] Write failed:", err.message));
  }

  _updateDisplaySession({
    ts,
    deltaBaseline,
    deltaWire,
    deltaSaved,
    ghostRetries,
    cacheReadTokens = 0,
  }) {
    let session = this._state.display_session;

    const lastActivity = session.last_activity_at ? new Date(session.last_activity_at) : null;
    const isExpired = lastActivity === null || ts - lastActivity > this._displaySessionInactivityMs;

    if (isExpired) {
      session = emptyDisplaySession();
      session.started_at = toUtcIso(ts);
      this._state.display_session = session;
    }

    session.requests += 1;
    session.tokens_before += deltaBaseline;
    session.tokens_after += deltaWire;
    session.tokens_saved += deltaSaved;
    session.cache_read_tokens += cacheReadTokens || 0;
    session.last_activity_at = toUtcIso(ts);

    if (ghostRetries > 0) {
      session.ghost_retries += ghostRetries;
      session.requests_with_retries += 1;
    }

    if (!session.started_at) {
      session.started_at = session.last_activity_at;
    }

    session.compression_ratio =
      session.tokens_before > 0
        ? parseFloat(((session.tokens_saved / session.tokens_before) * 100).toFixed(2))
        : 0;
  }

  snapshot() {
    return {
      schema_version: SCHEMA_VERSION,
      storage_path: this._filePath,
      lifetime: { ...this._state.lifetime },
      display_session: this._displaySessionSnapshot(),
      history: [...this._state.history],
      retention: {
        max_history_points: this._maxHistoryPoints,
        max_history_age_days: this._maxHistoryAgeDays,
      },
    };
  }

  statsPreview(recentPoints = 20) {
    const snap = this.snapshot();
    return {
      schema_version: snap.schema_version,
      storage_path: snap.storage_path,
      lifetime: snap.lifetime,
      display_session: snap.display_session,
      history_points: snap.history.length,
      recent_history: snap.history.slice(-recentPoints),
    };
  }

  historyResponse() {
    const snap = this.snapshot();
    return {
      schema_version: snap.schema_version,
      generated_at: toUtcIso(utcNow()),
      lifetime: snap.lifetime,
      display_session: snap.display_session,
      history: this._compactHistory(snap.history),
      series: {
        hourly: this._buildRollup(snap.history, "hour"),
        daily: this._buildRollup(snap.history, "day"),
        weekly: this._buildRollup(snap.history, "week"),
        monthly: this._buildRollup(snap.history, "month"),
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getSummary
  //
  // ST-1 FIX: Tokens Saved row now shows "(est)" suffix since cl100k_base
  // is used instead of Claude's actual tokenizer — absolute numbers are
  // approximate. Negative savings are displayed honestly with a note
  // explaining multi-hop overhead.
  // ─────────────────────────────────────────────────────────────────────────
  getSummary() {
    const snap = this.snapshot();
    const lt = snap.lifetime;

    const ratio =
      lt.tokens_before > 0 ? ((lt.tokens_saved / lt.tokens_before) * 100).toFixed(1) : "0.0";

    // Field names retain their on-disk v1 compatibility, but each count is an
    // extra ghost hop regardless of whether the tool execution succeeded.
    const hopRate =
      lt.requests > 0 ? ((lt.requests_with_retries / lt.requests) * 100).toFixed(1) : "0.0";

    const avgHops =
      lt.requests_with_retries > 0
        ? (lt.ghost_retries / lt.requests_with_retries).toFixed(2)
        : "0.00";

    const pad = (val) => String(val).padEnd(20);

    // ST-1: Negative tokens_saved = multi-hop sessions where ghost interceptor
    // made multiple LLM calls. Each hop adds to wireTokens while baseline
    // is only the initial payload. This is honest accounting, not an error.
    const savedLabel =
      lt.tokens_saved < 0
        ? `${pad(lt.tokens_saved.toLocaleString())} │ ← multi-hop overhead`
        : pad(lt.tokens_saved.toLocaleString());

    let cacheRow = "";
    if (lt.cache_read_tokens > 0) {
      cacheRow = `\n│ Cache Read (est)   │ ${pad(lt.cache_read_tokens.toLocaleString())} │`;
    }

    return `
┌───────────────────────────────────────────┐
│       ContextForge Stats (All Time)       │
├────────────────────┬──────────────────────┤
│ Total Requests     │ ${pad(lt.requests.toLocaleString())} │
│ Tokens Before (est)│ ${pad(lt.tokens_before.toLocaleString())} │
│ Tokens After  (est)│ ${pad(lt.tokens_after.toLocaleString())} │
│ Tokens Saved  (est)│ ${savedLabel}
│ Compression Ratio  │ ${pad(ratio + "%")} │${cacheRow}
├────────────────────┼──────────────────────┤
│ Ghost Hops         │ ${pad(lt.ghost_retries.toLocaleString())} │
│ Hop Rate           │ ${pad(hopRate + "%")} │
│ Avg Hops/Req       │ ${pad(avgHops)} │
└────────────────────┴──────────────────────┘
  Note: Token counts are estimates (cl100k_base ≈ Claude tokenizer ±15%)`;
  }

  _displaySessionSnapshot() {
    const session = { ...this._state.display_session };
    const lastActivity = session.last_activity_at ? new Date(session.last_activity_at) : null;
    if (!lastActivity || utcNow() - lastActivity > this._displaySessionInactivityMs) {
      return emptyDisplaySession();
    }
    return session;
  }

  _trimHistory(referenceTime) {
    let history = this._state.history;

    if (this._maxHistoryAgeDays > 0) {
      const cutoff = new Date(referenceTime);
      cutoff.setDate(cutoff.getDate() - this._maxHistoryAgeDays);
      history = history.filter((item) => new Date(item.timestamp) >= cutoff);
      if (history.length === 0 && this._state.history.length > 0) {
        history = [this._state.history[this._state.history.length - 1]];
      }
    }

    if (this._maxHistoryPoints > 0 && history.length > this._maxHistoryPoints) {
      history = history.slice(-this._maxHistoryPoints);
    }

    this._state.history = history;
  }

  _compactHistory(history) {
    if (history.length <= this._maxResponseHistoryPoints) return [...history];

    const recentPoints = Math.min(
      Math.max(Math.floor(this._maxResponseHistoryPoints / 3), 50),
      this._maxResponseHistoryPoints - 1
    );
    const recent = history.slice(-recentPoints);
    const older = history.slice(0, -recentPoints);
    const olderSlots = this._maxResponseHistoryPoints - recent.length;

    let sampledOlder = [];
    if (olderSlots > 0 && older.length > 0) {
      if (olderSlots === 1) {
        sampledOlder = [older[0]];
      } else {
        for (let i = 0; i < olderSlots; i++) {
          sampledOlder.push(older[Math.round(((older.length - 1) * i) / (olderSlots - 1))]);
        }
      }
    }

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
    let prevTotalSaved = 0;
    let prevTotalBefore = 0;
    let prevTotalAfter = 0;

    for (const point of history) {
      const ts = new Date(point.timestamp);
      const bucketKey = toUtcIso(bucketStart(ts, bucket));

      const totalSaved = point.total_tokens_saved || 0;
      const totalBefore = point.total_tokens_before || 0;
      const totalAfter = point.total_tokens_after || 0;

      const deltaSaved = totalSaved - prevTotalSaved;
      const deltaBefore = totalBefore - prevTotalBefore;
      const deltaAfter = totalAfter - prevTotalAfter;

      prevTotalSaved = totalSaved;
      prevTotalBefore = totalBefore;
      prevTotalAfter = totalAfter;

      if (!aggregated.has(bucketKey)) {
        aggregated.set(bucketKey, {
          timestamp: bucketKey,
          tokens_saved_delta: 0,
          tokens_before_delta: 0,
          tokens_after_delta: 0,
          total_tokens_saved: totalSaved,
          total_tokens_before: totalBefore,
          total_tokens_after: totalAfter,
        });
      }

      const entry = aggregated.get(bucketKey);
      entry.tokens_saved_delta += deltaSaved;
      entry.tokens_before_delta += deltaBefore;
      entry.tokens_after_delta += deltaAfter;
      entry.total_tokens_saved = totalSaved;
      entry.total_tokens_before = totalBefore;
      entry.total_tokens_after = totalAfter;
    }

    return [...aggregated.values()];
  }

  async _saveAtomic() {
    const dir = path.dirname(this._filePath);
    const tmpFile = path.join(dir, `.cf_savings_${Date.now()}_${process.pid}.tmp`);

    const payload = JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        lifetime: this._state.lifetime,
        display_session: this._state.display_session,
        history: this._state.history,
      },
      null,
      2
    );

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpFile, payload, "utf-8");
      fs.renameSync(tmpFile, this._filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
      throw err;
    }
  }

  _loadState() {
    const defaultState = {
      schema_version: SCHEMA_VERSION,
      lifetime: defaultLifetime(),
      display_session: emptyDisplaySession(),
      history: [],
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

    const incomingVersion = raw.schema_version || 1;
    const lifetime = raw.lifetime || {};

    let tokensBefore, tokensAfter, tokensSaved;

    if (incomingVersion >= 4 && lifetime.tokens_before != null) {
      tokensBefore = lifetime.tokens_before || 0;
      tokensAfter = lifetime.tokens_after || 0;
      tokensSaved = lifetime.tokens_saved || 0;
    } else {
      const savedV3 = Math.max(0, lifetime.tokens_saved || 0);
      const wireV3 = Math.max(0, lifetime.total_input_tokens || 0);
      tokensSaved = savedV3;
      tokensAfter = wireV3;
      tokensBefore = savedV3 + wireV3;
    }

    const history = (raw.history || [])
      .filter((item) => item && item.timestamp)
      .map((item) => {
        if (incomingVersion >= 4) {
          return {
            timestamp: item.timestamp,
            total_tokens_saved: item.total_tokens_saved ?? 0,
            total_tokens_before: item.total_tokens_before ?? 0,
            total_tokens_after: item.total_tokens_after ?? 0,
          };
        } else {
          const saved = item.total_tokens_saved || 0;
          const input = item.total_input_tokens || 0;
          return {
            timestamp: item.timestamp,
            total_tokens_saved: saved,
            total_tokens_before: saved + input,
            total_tokens_after: input,
          };
        }
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      schema_version: SCHEMA_VERSION,
      lifetime: {
        requests: Math.max(0, lifetime.requests || 0),
        tokens_before: tokensBefore,
        tokens_after: tokensAfter,
        tokens_saved: tokensSaved,
        cache_read_tokens: Math.max(0, lifetime.cache_read_tokens || 0),
        ghost_retries: Math.max(0, lifetime.ghost_retries || 0),
        requests_with_retries: Math.max(0, lifetime.requests_with_retries || 0),
      },
      display_session: emptyDisplaySession(),
      history,
    };
  }
}

export const savingsTracker = new SavingsTracker();
