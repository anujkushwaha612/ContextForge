import fs from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// savingsTracker.js
//
// Tracks token savings across requests, sessions, and lifetime.
//
// Dollar / USD estimates have been intentionally removed.
// Reason: dollar value depends on provider, model, cached-input pricing,
// enterprise discounts, and routing — none of which ContextForge controls.
// Showing a single dollar figure would be misleading across providers.
//
// What IS tracked:
//   - trueBaselineTokens  (payload size before any compression)
//   - wireTokens          (tokens actually sent, including all retry hops)
//   - tokensSaved         (baseline − wire, can be negative)
//   - ghostRetries        (retry hops added by the execution engine)
//
// Negative tokensSaved values are preserved throughout — in memory,
// in the history array, and in the persistent JSON file.
// A one-way ratchet that only counts wins is not honest accounting.
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

// Bumped to 4: removed all USD/dollar fields, added tokens_before tracking,
// removed Math.max(0) clamps on tokens_saved so negatives persist correctly.
const SCHEMA_VERSION = 4;

const DEFAULT_MAX_HISTORY_POINTS = 5000;
const DEFAULT_MAX_HISTORY_AGE_DAYS = 365;
const DEFAULT_DISPLAY_SESSION_INACTIVITY_MINUTES = 60;
const DEFAULT_MAX_RESPONSE_HISTORY_POINTS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// State shape helpers
// ─────────────────────────────────────────────────────────────────────────────

function emptyDisplaySession() {
  return {
    requests: 0,
    tokens_before: 0,        // sum of trueBaselineTokens for this session
    tokens_after: 0,         // sum of wireTokens for this session
    tokens_saved: 0,         // tokens_before − tokens_after (can be negative)
    compression_ratio: 0,    // tokens_saved / tokens_before * 100 (can be negative)
    started_at: null,
    last_activity_at: null,
    ghost_retries: 0,
    requests_with_retries: 0,
  };
}

function defaultLifetime() {
  return {
    requests: 0,
    tokens_before: 0,        // sum of all trueBaselineTokens
    tokens_after: 0,         // sum of all wireTokens
    tokens_saved: 0,         // tokens_before − tokens_after (can be negative)
    ghost_retries: 0,
    requests_with_retries: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SavingsTracker
// ─────────────────────────────────────────────────────────────────────────────

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

  // ───────────────────────────────────────────────────────────────────────────
  // recordRequest
  //
  // Called once per completed request from server.js.
  //
  // Parameters:
  //   baselineTokens  — trueBaselineTokens: payload size BEFORE any compression
  //   wireTokens      — tokens actually sent across all LLM hops (incl. retries)
  //   tokensSaved     — baselineTokens − wireTokens (pre-computed, may be negative)
  //   ghostRetries    — number of retry hops beyond the first (0 = no retries)
  //   timestamp       — optional Date or ISO string, defaults to now
  // ───────────────────────────────────────────────────────────────────────────
  recordRequest({
    baselineTokens,
    wireTokens,
    tokensSaved,
    timestamp = null,
    ghostRetries = 0,
  }) {
    const ts = timestamp ? new Date(timestamp) : utcNow();

    // Sanitize inputs — baseline and wire must be non-negative counts.
    // tokensSaved is allowed to be negative and is NOT clamped.
    const deltaBaseline = Math.max(0, baselineTokens || 0);
    const deltaWire     = Math.max(0, wireTokens     || 0);
    const deltaSaved    = typeof tokensSaved === "number" ? tokensSaved
                          : deltaBaseline - deltaWire;

    // ── Lifetime accumulation ───────────────────────────────────────────────
    const lt = this._state.lifetime;
    lt.requests       += 1;
    lt.tokens_before  += deltaBaseline;
    lt.tokens_after   += deltaWire;
    lt.tokens_saved   += deltaSaved;   // intentionally allows negative accumulation

    if (ghostRetries > 0) {
      lt.ghost_retries          += ghostRetries;
      lt.requests_with_retries  += 1;
    }

    // ── Display session ─────────────────────────────────────────────────────
    this._updateDisplaySession({ ts, deltaBaseline, deltaWire, deltaSaved, ghostRetries });

    // ── History — always push, including net-negative requests ──────────────
    // Dropping net-negative points would make the time series dishonest.
    this._state.history.push({
      timestamp:         toUtcIso(ts),
      total_tokens_saved: lt.tokens_saved,
      total_tokens_before: lt.tokens_before,
      total_tokens_after:  lt.tokens_after,
    });
    this._trimHistory(ts);

    // ── Async persist ───────────────────────────────────────────────────────
    this._writeQueue = this._writeQueue
      .then(() => this._saveAtomic())
      .catch((err) => console.error("[SavingsTracker] Write failed:", err.message));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // _updateDisplaySession
  // ───────────────────────────────────────────────────────────────────────────
  _updateDisplaySession({ ts, deltaBaseline, deltaWire, deltaSaved, ghostRetries }) {
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

    session.requests        += 1;
    session.tokens_before   += deltaBaseline;
    session.tokens_after    += deltaWire;
    session.tokens_saved    += deltaSaved;
    session.last_activity_at = toUtcIso(ts);

    if (ghostRetries > 0) {
      session.ghost_retries         += ghostRetries;
      session.requests_with_retries += 1;
    }

    if (!session.started_at) {
      session.started_at = session.last_activity_at;
    }

    // Compression ratio: tokens_saved / tokens_before * 100
    // Uses the correctly tracked tokens_before (trueBaselineTokens sum).
    // Can be negative when wire cost exceeded baseline.
    session.compression_ratio =
      session.tokens_before > 0
        ? parseFloat(((session.tokens_saved / session.tokens_before) * 100).toFixed(2))
        : 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public read API
  // ───────────────────────────────────────────────────────────────────────────

  snapshot() {
    return {
      schema_version:  SCHEMA_VERSION,
      storage_path:    this._filePath,
      lifetime:        { ...this._state.lifetime },
      display_session: this._displaySessionSnapshot(),
      history:         [...this._state.history],
      retention: {
        max_history_points:   this._maxHistoryPoints,
        max_history_age_days: this._maxHistoryAgeDays,
      },
    };
  }

  statsPreview(recentPoints = 20) {
    const snap = this.snapshot();
    return {
      schema_version:  snap.schema_version,
      storage_path:    snap.storage_path,
      lifetime:        snap.lifetime,
      display_session: snap.display_session,
      history_points:  snap.history.length,
      recent_history:  snap.history.slice(-recentPoints),
    };
  }

  historyResponse() {
    const snap = this.snapshot();
    return {
      schema_version: snap.schema_version,
      generated_at:   toUtcIso(utcNow()),
      lifetime:       snap.lifetime,
      display_session: snap.display_session,
      history:        this._compactHistory(snap.history),
      series: {
        hourly:  this._buildRollup(snap.history, "hour"),
        daily:   this._buildRollup(snap.history, "day"),
        weekly:  this._buildRollup(snap.history, "week"),
        monthly: this._buildRollup(snap.history, "month"),
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // getSummary — ASCII table printed at proxy shutdown
  //
  // Dollar savings row has been removed.
  // Compression ratio now uses tokens_before (true baseline) as denominator.
  // Tokens Saved can display negative values honestly.
  // ───────────────────────────────────────────────────────────────────────────
  getSummary() {
    const snap = this.snapshot();
    const lt   = snap.lifetime;

    const ratio =
      lt.tokens_before > 0
        ? ((lt.tokens_saved / lt.tokens_before) * 100).toFixed(1)
        : "0.0";

    const retryRate =
      lt.requests > 0
        ? ((lt.requests_with_retries / lt.requests) * 100).toFixed(1)
        : "0.0";

    const avgRetries =
      lt.requests_with_retries > 0
        ? (lt.ghost_retries / lt.requests_with_retries).toFixed(2)
        : "0.00";

    // Pad helper — handles negative numbers which need the sign included
    const pad = (val) => String(val).padEnd(20);

    return `
┌───────────────────────────────────────────┐
│       ContextForge Stats (All Time)       │
├────────────────────┬──────────────────────┤
│ Total Requests     │ ${pad(lt.requests.toLocaleString())} │
│ Tokens Before      │ ${pad(lt.tokens_before.toLocaleString())} │
│ Tokens After       │ ${pad(lt.tokens_after.toLocaleString())} │
│ Tokens Saved       │ ${pad(lt.tokens_saved.toLocaleString())} │
│ Compression Ratio  │ ${pad(ratio + "%")} │
├────────────────────┼──────────────────────┤
│ Ghost Retries      │ ${pad(lt.ghost_retries.toLocaleString())} │
│ Retry Rate         │ ${pad(retryRate + "%")} │
│ Avg Retries/Req    │ ${pad(avgRetries)} │
└────────────────────┴──────────────────────┘`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ───────────────────────────────────────────────────────────────────────────

  _displaySessionSnapshot() {
    const session     = { ...this._state.display_session };
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

    if (this._maxHistoryAgeDays > 0) {
      const cutoff = new Date(referenceTime);
      cutoff.setDate(cutoff.getDate() - this._maxHistoryAgeDays);
      history = history.filter((item) => new Date(item.timestamp) >= cutoff);
      // Always keep at least the most recent point
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
    const older  = history.slice(0, -recentPoints);
    const olderSlots = this._maxResponseHistoryPoints - recent.length;

    let sampledOlder = [];
    if (olderSlots > 0 && older.length > 0) {
      if (olderSlots === 1) {
        sampledOlder = [older[0]];
      } else {
        for (let i = 0; i < olderSlots; i++) {
          sampledOlder.push(
            older[Math.round(((older.length - 1) * i) / (olderSlots - 1))]
          );
        }
      }
    }

    const seen     = new Set();
    const compacted = [];
    for (const point of [...sampledOlder, ...recent]) {
      if (!seen.has(point.timestamp)) {
        seen.add(point.timestamp);
        compacted.push({ ...point });
      }
    }
    return compacted;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // _buildRollup
  //
  // Negative delta values are preserved — a time bucket where ContextForge
  // inflated the payload shows a negative tokens_saved_delta honestly.
  // The old Math.max(0, delta) clamp has been removed.
  // ───────────────────────────────────────────────────────────────────────────
  _buildRollup(history, bucket) {
    if (!history.length) return [];

    const aggregated = new Map();
    let prevTotalSaved  = 0;
    let prevTotalBefore = 0;
    let prevTotalAfter  = 0;

    for (const point of history) {
      const ts        = new Date(point.timestamp);
      const bucketKey = toUtcIso(bucketStart(ts, bucket));

      const totalSaved  = point.total_tokens_saved  || 0;
      const totalBefore = point.total_tokens_before || 0;
      const totalAfter  = point.total_tokens_after  || 0;

      // Deltas are NOT clamped — negative deltas (inflation events) are real
      const deltaSaved  = totalSaved  - prevTotalSaved;
      const deltaBefore = totalBefore - prevTotalBefore;
      const deltaAfter  = totalAfter  - prevTotalAfter;

      prevTotalSaved  = totalSaved;
      prevTotalBefore = totalBefore;
      prevTotalAfter  = totalAfter;

      if (!aggregated.has(bucketKey)) {
        aggregated.set(bucketKey, {
          timestamp:              bucketKey,
          tokens_saved_delta:     0,
          tokens_before_delta:    0,
          tokens_after_delta:     0,
          total_tokens_saved:     totalSaved,
          total_tokens_before:    totalBefore,
          total_tokens_after:     totalAfter,
        });
      }

      const entry = aggregated.get(bucketKey);
      entry.tokens_saved_delta  += deltaSaved;
      entry.tokens_before_delta += deltaBefore;
      entry.tokens_after_delta  += deltaAfter;
      entry.total_tokens_saved   = totalSaved;
      entry.total_tokens_before  = totalBefore;
      entry.total_tokens_after   = totalAfter;
    }

    return [...aggregated.values()];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Persistence
  // ───────────────────────────────────────────────────────────────────────────

  async _saveAtomic() {
    const dir     = path.dirname(this._filePath);
    const tmpFile = path.join(dir, `.cf_savings_${Date.now()}_${process.pid}.tmp`);

    const payload = JSON.stringify(
      {
        schema_version:  SCHEMA_VERSION,
        lifetime:        this._state.lifetime,
        display_session: this._state.display_session,
        history:         this._state.history,
      },
      null,
      2
    );

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

  // ───────────────────────────────────────────────────────────────────────────
  // _sanitizeState
  //
  // Handles loading files written by older schema versions (1, 2, 3).
  //
  // Key changes from v3 → v4:
  //   - tokens_saved is NO LONGER clamped to Math.max(0, ...).
  //     Negative lifetime totals are valid and must be preserved.
  //   - tokens_before / tokens_after replace the circular denominator.
  //   - USD / dollar fields are dropped and not migrated.
  //   - History items preserve negative total_tokens_saved values.
  //
  // Migration from v3:
  //   Old files have tokens_saved but not tokens_before / tokens_after.
  //   We reconstruct tokens_before from (tokens_saved + total_input_tokens)
  //   as the best available approximation, and set tokens_after to
  //   total_input_tokens. This is imperfect for sessions with retries but
  //   is the only reconstruction possible without the original data.
  // ───────────────────────────────────────────────────────────────────────────
  _sanitizeState(raw) {
    if (!raw || typeof raw !== "object") return null;

    const incomingVersion = raw.schema_version || 1;
    const lifetime        = raw.lifetime || {};

    // ── Migrate tokens_before / tokens_after from older schemas ────────────
    let tokensBefore, tokensAfter, tokensSaved;

    if (incomingVersion >= 4 && lifetime.tokens_before != null) {
      // v4 file — use directly, allow negative tokens_saved
      tokensBefore = lifetime.tokens_before || 0;
      tokensAfter  = lifetime.tokens_after  || 0;
      tokensSaved  = lifetime.tokens_saved  || 0;
    } else {
      // v1–v3 file — reconstruct from available fields
      // tokens_saved in v3 was Math.max(0, ...) so it cannot go below 0
      // total_input_tokens in v3 was wireTokens
      const savedV3 = Math.max(0, lifetime.tokens_saved || 0);
      const wireV3  = Math.max(0, lifetime.total_input_tokens || 0);
      tokensSaved  = savedV3;
      tokensAfter  = wireV3;
      tokensBefore = savedV3 + wireV3; // best approximation available
    }

    // ── History migration ───────────────────────────────────────────────────
    const history = (raw.history || [])
      .filter((item) => item && item.timestamp)
      .map((item) => {
        if (incomingVersion >= 4) {
          // v4 items — preserve as-is including negatives
          return {
            timestamp:           item.timestamp,
            total_tokens_saved:  item.total_tokens_saved  ?? 0,
            total_tokens_before: item.total_tokens_before ?? 0,
            total_tokens_after:  item.total_tokens_after  ?? 0,
          };
        } else {
          // v1–v3 items — reconstruct tokens_before / tokens_after
          const saved  = item.total_tokens_saved  || 0;
          const input  = item.total_input_tokens  || 0;
          return {
            timestamp:           item.timestamp,
            total_tokens_saved:  saved,
            total_tokens_before: saved + input,
            total_tokens_after:  input,
          };
        }
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      schema_version: SCHEMA_VERSION,
      lifetime: {
        requests:              Math.max(0, lifetime.requests              || 0),
        tokens_before:         tokensBefore,
        tokens_after:          tokensAfter,
        tokens_saved:          tokensSaved,   // NOT clamped — negatives are valid
        ghost_retries:         Math.max(0, lifetime.ghost_retries         || 0),
        requests_with_retries: Math.max(0, lifetime.requests_with_retries || 0),
      },
      display_session: emptyDisplaySession(),
      history,
    };
  }
}

export const savingsTracker = new SavingsTracker();