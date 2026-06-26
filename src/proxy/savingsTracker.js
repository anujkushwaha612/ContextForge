import fs from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────
// Per-model pricing (USD per 1M tokens)
// ─────────────────────────────────────────────
const MODEL_PRICING = {
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-opus-4-5": { input: 5.0, output: 25.0 },
  "claude-opus-4": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-sonnet-4": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-haiku-4": { input: 1.0, output: 5.0 },
  "claude-3-5-sonnet": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku": { input: 0.8, output: 4.0 },
  "claude-3-sonnet": { input: 3.0, output: 15.0 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "gpt-5.5": { input: 5.0, output: 20.0 },
  "gpt-5.5-mini": { input: 1.0, output: 4.0 },
  "gpt-5": { input: 5.0, output: 15.0 },
  "gpt-5-mini": { input: 0.8, output: 3.2 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "o4-mini": { input: 1.1, output: 4.4 },
  o4: { input: 2.0, output: 8.0 },
  "o3-pro": { input: 20.0, output: 80.0 },
  o3: { input: 2.0, output: 8.0 },
  "o3-mini": { input: 1.1, output: 4.4 },
  o1: { input: 15.0, output: 60.0 },
  "o1-mini": { input: 1.1, output: 4.4 },
  "o1-pro": { input: 20.0, output: 80.0 },
  "codex-mini": { input: 1.5, output: 6.0 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-4": { input: 30.0, output: 60.0 },
  "gemini-3": { input: 2, output: 12.0 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-flash-lite": { input: 0.04, output: 0.15 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "deepseek-r1-0528": { input: 0.55, output: 2.19 },
  "deepseek-r1": { input: 0.55, output: 2.19 },
  "deepseek-v3-0324": { input: 0.27, output: 1.1 },
  "deepseek-v3": { input: 0.27, output: 1.1 },
  "deepseek-v3-2": { input: 0.14, output: 0.28 },
  "deepseek-r1-distill-llama-70b": { input: 0.03, output: 0.03 },
  "deepseek-coder": { input: 0.14, output: 0.28 },
  "deepseek-prover-v2": { input: 0.55, output: 2.19 },
  "llama-4-behemoth": { input: 1.5, output: 5.0 },
  "llama-4-maverick": { input: 0.27, output: 0.85 },
  "llama-4-scout": { input: 0.18, output: 0.59 },
  "llama-3.3-70b": { input: 0.59, output: 0.79 },
  "llama-3.1-405b": { input: 3.0, output: 3.0 },
  "llama-3.1-70b": { input: 0.59, output: 0.79 },
  "llama-3.1-8b": { input: 0.05, output: 0.08 },
  "llama-3-70b": { input: 0.59, output: 0.79 },
  "mistral-large-2": { input: 2.0, output: 6.0 },
  "mistral-large": { input: 2.0, output: 6.0 },
  "mistral-medium-3": { input: 0.4, output: 2.0 },
  "mistral-medium": { input: 0.4, output: 2.0 },
  "mistral-small-3.1": { input: 0.1, output: 0.3 },
  "mistral-small": { input: 0.2, output: 0.6 },
  "devstral-small": { input: 0.1, output: 0.3 },
  "mistral-7b": { input: 0.25, output: 0.25 },
  "mixtral-8x7b": { input: 0.27, output: 0.27 },
  "mixtral-8x22b": { input: 0.9, output: 0.9 },
  codestral: { input: 0.3, output: 0.9 },
  "codestral-mamba": { input: 0.2, output: 0.6 },
  "mistral-nemo": { input: 0.02, output: 0.04 },
  "grok-4": { input: 3.0, output: 15.0 },
  "grok-3": { input: 3.0, output: 15.0 },
  "grok-3-mini": { input: 0.3, output: 0.5 },
  "grok-3-fast": { input: 5.0, output: 25.0 },
  "grok-2": { input: 2.0, output: 10.0 },
  "command-a": { input: 2.5, output: 10.0 },
  "command-r-plus": { input: 2.5, output: 10.0 },
  "command-r": { input: 0.15, output: 0.6 },
  "command-r7b": { input: 0.0375, output: 0.15 },
  "qwen3-235b-a22b": { input: 0.5, output: 1.5 },
  "qwen3-30b-a3b": { input: 0.13, output: 0.5 },
  "qwen3-32b": { input: 0.2, output: 0.6 },
  "qwen3-8b": { input: 0.05, output: 0.15 },
  "qwen3-4b": { input: 0.02, output: 0.06 },
  "qwen2.5-72b": { input: 0.4, output: 0.4 },
  "qwen2.5-7b": { input: 0.1, output: 0.1 },
  "qwen-max": { input: 0.4, output: 1.2 },
  "qwen-plus": { input: 0.15, output: 0.6 },
  "nova-premier": { input: 2.5, output: 12.5 },
  "nova-pro": { input: 0.8, output: 3.2 },
  "nova-lite": { input: 0.06, output: 0.24 },
  "nova-micro": { input: 0.035, output: 0.14 },
  "phi-4": { input: 0.07, output: 0.14 },
  "phi-4-mini": { input: 0.02, output: 0.04 },
  "jamba-1.5-large": { input: 2.0, output: 8.0 },
  "jamba-1.5-mini": { input: 0.2, output: 0.4 },
  ollama: { input: 0.0, output: 0.0 },
  "lm-studio": { input: 0.0, output: 0.0 },
  default: { input: 1.0, output: 4.0 },
};

function getPricing(modelName) {
  const lower = (modelName || "").toLowerCase();
  if (MODEL_PRICING[lower]) return MODEL_PRICING[lower];
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key !== "default" && lower.startsWith(key)) return pricing;
  }
  if (lower.includes("claude-opus")) return MODEL_PRICING["claude-opus-4"];
  if (lower.includes("claude-sonnet")) return MODEL_PRICING["claude-sonnet-4"];
  if (lower.includes("claude-haiku")) return MODEL_PRICING["claude-haiku-4"];
  if (lower.includes("gpt-5.5-mini")) return MODEL_PRICING["gpt-5.5-mini"];
  if (lower.includes("gpt-5.5")) return MODEL_PRICING["gpt-5.5"];
  if (lower.includes("gpt-5-mini")) return MODEL_PRICING["gpt-5-mini"];
  if (lower.includes("gpt-5")) return MODEL_PRICING["gpt-5"];
  if (lower.includes("gpt-4.1-nano")) return MODEL_PRICING["gpt-4.1-nano"];
  if (lower.includes("gpt-4.1-mini")) return MODEL_PRICING["gpt-4.1-mini"];
  if (lower.includes("gpt-4.1")) return MODEL_PRICING["gpt-4.1"];
  if (lower.includes("gpt-4o-mini")) return MODEL_PRICING["gpt-4o-mini"];
  if (lower.includes("gpt-4o")) return MODEL_PRICING["gpt-4o"];
  if (lower.includes("codex-mini")) return MODEL_PRICING["codex-mini"];
  if (lower.includes("codex")) return MODEL_PRICING["codex-mini"];
  if (lower.includes("o4-mini")) return MODEL_PRICING["o4-mini"];
  if (lower.includes("o4")) return MODEL_PRICING["o4"];
  if (lower.includes("o3-pro")) return MODEL_PRICING["o3-pro"];
  if (lower.includes("o3-mini")) return MODEL_PRICING["o3-mini"];
  if (lower.includes("o3")) return MODEL_PRICING["o3"];
  if (lower.includes("o1-pro")) return MODEL_PRICING["o1-pro"];
  if (lower.includes("o1-mini")) return MODEL_PRICING["o1-mini"];
  if (lower.includes("o1")) return MODEL_PRICING["o1"];
  if(lower.includes("gemini-3")) return MODEL_PRICING["gemini-3"];
  if (lower.includes("gemini-2.5-flash-lite")) return MODEL_PRICING["gemini-2.5-flash-lite"];
  if (lower.includes("gemini-2.5-flash")) return MODEL_PRICING["gemini-2.5-flash"];
  if (lower.includes("gemini-2.5-pro")) return MODEL_PRICING["gemini-2.5-pro"];
  if (lower.includes("gemini-2.0-flash")) return MODEL_PRICING["gemini-2.0-flash"];
  if (lower.includes("gemini-1.5-flash")) return MODEL_PRICING["gemini-1.5-flash"];
  if (lower.includes("gemini-1.5-pro")) return MODEL_PRICING["gemini-1.5-pro"];
  if (lower.includes("gemini")) return MODEL_PRICING["gemini-2.5-flash"];
  if (lower.includes("deepseek-prover")) return MODEL_PRICING["deepseek-prover-v2"];
  if (lower.includes("deepseek-r1")) return MODEL_PRICING["deepseek-r1"];
  if (lower.includes("deepseek-v3")) return MODEL_PRICING["deepseek-v3"];
  if (lower.includes("deepseek")) return MODEL_PRICING["deepseek-v3"];
  if (lower.includes("llama-4-behemoth")) return MODEL_PRICING["llama-4-behemoth"];
  if (lower.includes("llama-4-maverick")) return MODEL_PRICING["llama-4-maverick"];
  if (lower.includes("llama-4-scout")) return MODEL_PRICING["llama-4-scout"];
  if (lower.includes("llama-4")) return MODEL_PRICING["llama-4-maverick"];
  if (lower.includes("llama-3.3")) return MODEL_PRICING["llama-3.3-70b"];
  if (lower.includes("llama-3.1-405b")) return MODEL_PRICING["llama-3.1-405b"];
  if (lower.includes("llama-3.1-8b")) return MODEL_PRICING["llama-3.1-8b"];
  if (lower.includes("llama-3.1") || lower.includes("llama-3")) return MODEL_PRICING["llama-3.1-70b"];
  if (lower.includes("llama")) return MODEL_PRICING["llama-3.3-70b"];
  if (lower.includes("devstral")) return MODEL_PRICING["devstral-small"];
  if (lower.includes("mixtral-8x22b")) return MODEL_PRICING["mixtral-8x22b"];
  if (lower.includes("mixtral")) return MODEL_PRICING["mixtral-8x7b"];
  if (lower.includes("codestral-mamba")) return MODEL_PRICING["codestral-mamba"];
  if (lower.includes("codestral")) return MODEL_PRICING["codestral"];
  if (lower.includes("mistral-large")) return MODEL_PRICING["mistral-large"];
  if (lower.includes("mistral-medium")) return MODEL_PRICING["mistral-medium"];
  if (lower.includes("mistral-small-3.1")) return MODEL_PRICING["mistral-small-3.1"];
  if (lower.includes("mistral-small")) return MODEL_PRICING["mistral-small"];
  if (lower.includes("mistral-nemo")) return MODEL_PRICING["mistral-nemo"];
  if (lower.includes("mistral")) return MODEL_PRICING["mistral-small"];
  if (lower.includes("grok-4")) return MODEL_PRICING["grok-4"];
  if (lower.includes("grok-3-mini")) return MODEL_PRICING["grok-3-mini"];
  if (lower.includes("grok-3-fast")) return MODEL_PRICING["grok-3-fast"];
  if (lower.includes("grok-3")) return MODEL_PRICING["grok-3"];
  if (lower.includes("grok")) return MODEL_PRICING["grok-2"];
  if (lower.includes("command-a")) return MODEL_PRICING["command-a"];
  if (lower.includes("command-r-plus")) return MODEL_PRICING["command-r-plus"];
  if (lower.includes("command-r7b")) return MODEL_PRICING["command-r7b"];
  if (lower.includes("command-r")) return MODEL_PRICING["command-r"];
  if (lower.includes("qwen3-235b")) return MODEL_PRICING["qwen3-235b-a22b"];
  if (lower.includes("qwen3-30b")) return MODEL_PRICING["qwen3-30b-a3b"];
  if (lower.includes("qwen3-32b")) return MODEL_PRICING["qwen3-32b"];
  if (lower.includes("qwen3-8b")) return MODEL_PRICING["qwen3-8b"];
  if (lower.includes("qwen3-4b")) return MODEL_PRICING["qwen3-4b"];
  if (lower.includes("qwen3")) return MODEL_PRICING["qwen3-235b-a22b"];
  if (lower.includes("qwen2.5-72b")) return MODEL_PRICING["qwen2.5-72b"];
  if (lower.includes("qwen2.5-7b")) return MODEL_PRICING["qwen2.5-7b"];
  if (lower.includes("qwen-max")) return MODEL_PRICING["qwen-max"];
  if (lower.includes("qwen-plus")) return MODEL_PRICING["qwen-plus"];
  if (lower.includes("qwen")) return MODEL_PRICING["qwen-max"];
  if (lower.includes("nova-premier")) return MODEL_PRICING["nova-premier"];
  if (lower.includes("nova-pro")) return MODEL_PRICING["nova-pro"];
  if (lower.includes("nova-lite")) return MODEL_PRICING["nova-lite"];
  if (lower.includes("nova-micro")) return MODEL_PRICING["nova-micro"];
  if (lower.includes("nova")) return MODEL_PRICING["nova-pro"];
  if (lower.includes("phi-4-mini")) return MODEL_PRICING["phi-4-mini"];
  if (lower.includes("phi-4")) return MODEL_PRICING["phi-4"];
  if (lower.includes("phi")) return MODEL_PRICING["phi-4"];
  if (lower.includes("jamba-1.5-large")) return MODEL_PRICING["jamba-1.5-large"];
  if (lower.includes("jamba-1.5-mini")) return MODEL_PRICING["jamba-1.5-mini"];
  if (lower.includes("jamba")) return MODEL_PRICING["jamba-1.5-mini"];
  if (lower.includes("ollama") || lower.includes(":latest") || lower.includes("lm-studio")) return MODEL_PRICING["ollama"];
  if (lower.includes("gemma")) return { input: 0.1, output: 0.1 };
  return MODEL_PRICING["default"];
}

function estimateSavingsUsd(modelName, tokensSaved) {
  if (tokensSaved <= 0) return 0;
  return (tokensSaved / 1_000_000) * getPricing(modelName).input;
}

function estimateInputCostUsd(modelName, inputTokens) {
  if (inputTokens <= 0) return 0;
  return (inputTokens / 1_000_000) * getPricing(modelName).input;
}

function utcNow() { return new Date(); }
function toUtcIso(dt) { return dt.toISOString().replace(".000Z", "Z"); }

function bucketStart(timestamp, bucket) {
  const dt = new Date(timestamp);
  if (bucket === "hour") { dt.setUTCMinutes(0, 0, 0); return dt; }
  if (bucket === "day") { dt.setUTCHours(0, 0, 0, 0); return dt; }
  if (bucket === "week") { dt.setUTCHours(0, 0, 0, 0); dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay()); return dt; }
  if (bucket === "month") { dt.setUTCDate(1); dt.setUTCHours(0, 0, 0, 0); return dt; }
  throw new Error(`Unknown bucket: ${bucket}`);
}

const SCHEMA_VERSION = 3; // Bumped for new ghost retry fields
const DEFAULT_MAX_HISTORY_POINTS = 5000;
const DEFAULT_MAX_HISTORY_AGE_DAYS = 365;
const DEFAULT_DISPLAY_SESSION_INACTIVITY_MINUTES = 60;
const DEFAULT_MAX_RESPONSE_HISTORY_POINTS = 500;

function emptyDisplaySession() {
  return {
    requests: 0, tokens_saved: 0, compression_savings_usd: 0,
    total_input_tokens: 0, total_input_cost_usd: 0, savings_percent: 0,
    started_at: null, last_activity_at: null,
    ghost_retries: 0, requests_with_retries: 0, // FIX 8
  };
}

function defaultLifetime() {
  return {
    requests: 0, tokens_saved: 0, compression_savings_usd: 0,
    total_input_tokens: 0, total_input_cost_usd: 0,
    ghost_retries: 0, requests_with_retries: 0, // FIX 8
  };
}

export class SavingsTracker {
  constructor({
    filePath = null, maxHistoryPoints = DEFAULT_MAX_HISTORY_POINTS,
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

  // FIX 8: Added ghostRetries parameter
  recordRequest({ model, inputTokens, tokensSaved, timestamp = null, ghostRetries = 0 }) {
    const ts = timestamp ? new Date(timestamp) : utcNow();
    const deltaTokensSaved = Math.max(0, tokensSaved || 0);
    const deltaInput = Math.max(0, inputTokens || 0);
    const deltaSavingsUsd = estimateSavingsUsd(model, deltaTokensSaved);
    const deltaInputCostUsd = estimateInputCostUsd(model, deltaInput);

    const lifetime = this._state.lifetime;
    lifetime.requests += 1;
    lifetime.tokens_saved += deltaTokensSaved;
    lifetime.compression_savings_usd += deltaSavingsUsd;
    lifetime.total_input_tokens += deltaInput;
    lifetime.total_input_cost_usd += deltaInputCostUsd;
    
    if (ghostRetries > 0) {
      lifetime.ghost_retries += ghostRetries;
      lifetime.requests_with_retries += 1;
    }

    this._updateDisplaySession({ ts, deltaTokensSaved, deltaInput, deltaSavingsUsd, deltaInputCostUsd, ghostRetries });

    if (deltaTokensSaved > 0) {
      this._state.history.push({
        timestamp: toUtcIso(ts), total_tokens_saved: lifetime.tokens_saved,
        compression_savings_usd: parseFloat(lifetime.compression_savings_usd.toFixed(6)),
        total_input_tokens: lifetime.total_input_tokens,
        total_input_cost_usd: parseFloat(lifetime.total_input_cost_usd.toFixed(6)),
      });
      this._trimHistory(ts);
    }

    this._writeQueue = this._writeQueue.then(() => this._saveAtomic()).catch((err) =>
      console.error("[SavingsTracker] Write failed:", err.message),
    );
  }

  _updateDisplaySession({ ts, deltaTokensSaved, deltaInput, deltaSavingsUsd, deltaInputCostUsd, ghostRetries }) {
    let session = this._state.display_session;
    const lastActivity = session.last_activity_at ? new Date(session.last_activity_at) : null;
    const isExpired = lastActivity === null || ts - lastActivity > this._displaySessionInactivityMs;

    if (isExpired) {
      session = emptyDisplaySession();
      session.started_at = toUtcIso(ts);
      this._state.display_session = session;
    }

    session.requests += 1;
    session.tokens_saved += deltaTokensSaved;
    session.compression_savings_usd += deltaSavingsUsd;
    session.total_input_tokens += deltaInput;
    session.total_input_cost_usd += deltaInputCostUsd;
    session.last_activity_at = toUtcIso(ts);
    if (ghostRetries > 0) {
      session.ghost_retries += ghostRetries;
      session.requests_with_retries += 1;
    }

    if (!session.started_at) session.started_at = session.last_activity_at;
    const totalBefore = session.tokens_saved + session.total_input_tokens;
    session.savings_percent = totalBefore > 0 ? parseFloat(((session.tokens_saved / totalBefore) * 100).toFixed(2)) : 0;
  }

  snapshot() {
    return {
      schema_version: SCHEMA_VERSION, storage_path: this._filePath,
      lifetime: { ...this._state.lifetime }, display_session: this._displaySessionSnapshot(),
      history: [...this._state.history],
      retention: { max_history_points: this._maxHistoryPoints, max_history_age_days: this._maxHistoryAgeDays },
    };
  }

  statsPreview(recentPoints = 20) {
    const snap = this.snapshot();
    return {
      schema_version: snap.schema_version, storage_path: snap.storage_path,
      lifetime: snap.lifetime, display_session: snap.display_session,
      history_points: snap.history.length, recent_history: snap.history.slice(-recentPoints),
    };
  }

  historyResponse() {
    const snap = this.snapshot();
    return {
      schema_version: snap.schema_version, generated_at: toUtcIso(utcNow()),
      lifetime: snap.lifetime, display_session: snap.display_session,
      history: this._compactHistory(snap.history),
      series: {
        hourly: this._buildRollup(snap.history, "hour"), daily: this._buildRollup(snap.history, "day"),
        weekly: this._buildRollup(snap.history, "week"), monthly: this._buildRollup(snap.history, "month"),
      },
    };
  }

  // FIX 8: Updated ASCII table to include Ghost Retry metrics
  getSummary() {
    const snap = this.snapshot();
    const lt = snap.lifetime;
    const tokensAfter = lt.total_input_tokens;
    const tokensBefore = lt.tokens_saved + lt.total_input_tokens;
    const ratio = tokensBefore > 0 ? ((lt.tokens_saved / tokensBefore) * 100).toFixed(1) : "0.0";
    
    const retryRate = lt.requests > 0 ? ((lt.requests_with_retries / lt.requests) * 100).toFixed(1) : "0.0";
    const avgRetries = lt.requests_with_retries > 0 ? (lt.ghost_retries / lt.requests_with_retries).toFixed(2) : "0.00";

    return `
┌───────────────────────────────────────────┐
│       ContextForge Stats (All Time)       │
├────────────────────┬──────────────────────┤
│ Total Requests     │ ${lt.requests.toLocaleString().padEnd(20)} │
│ Tokens Before      │ ${tokensBefore.toLocaleString().padEnd(20)} │
│ Tokens After       │ ${tokensAfter.toLocaleString().padEnd(20)} │
│ Tokens Saved       │ ${lt.tokens_saved.toLocaleString().padEnd(20)} │
│ Compression Ratio  │ ${(ratio + "%").padEnd(20)} │
│ Est. Savings       │ $${lt.compression_savings_usd.toFixed(6).padEnd(19)} │
├────────────────────┼──────────────────────┤
│ Ghost Retries      │ ${lt.ghost_retries.toLocaleString().padEnd(20)} │
│ Retry Rate         │ ${(retryRate + "%").padEnd(20)} │
│ Avg Retries/Req    │ ${avgRetries.padEnd(20)} │
└────────────────────┴──────────────────────┘`;
  }

  _displaySessionSnapshot() {
    const session = { ...this._state.display_session };
    const lastActivity = session.last_activity_at ? new Date(session.last_activity_at) : null;
    if (!lastActivity || utcNow() - lastActivity > this._displaySessionInactivityMs) return emptyDisplaySession();
    return session;
  }

  _trimHistory(referenceTime) {
    let history = this._state.history;
    if (this._maxHistoryAgeDays > 0) {
      const cutoff = new Date(referenceTime);
      cutoff.setDate(cutoff.getDate() - this._maxHistoryAgeDays);
      history = history.filter((item) => new Date(item.timestamp) >= cutoff);
      if (history.length === 0 && this._state.history.length > 0) history = [this._state.history[this._state.history.length - 1]];
    }
    if (this._maxHistoryPoints > 0 && history.length > this._maxHistoryPoints) history = history.slice(-this._maxHistoryPoints);
    this._state.history = history;
  }

  _compactHistory(history) {
    if (history.length <= this._maxResponseHistoryPoints) return [...history];
    const recentPoints = Math.min(Math.max(Math.floor(this._maxResponseHistoryPoints / 3), 50), this._maxResponseHistoryPoints - 1);
    const recent = history.slice(-recentPoints);
    const older = history.slice(0, -recentPoints);
    const olderSlots = this._maxResponseHistoryPoints - recent.length;
    let sampledOlder = [];
    if (olderSlots > 0 && older.length > 0) {
      if (olderSlots === 1) sampledOlder = [older[0]];
      else for (let i = 0; i < olderSlots; i++) sampledOlder.push(older[Math.round(((older.length - 1) * i) / (olderSlots - 1))]);
    }
    const seen = new Set(); const compacted = [];
    for (const point of [...sampledOlder, ...recent]) {
      if (!seen.has(point.timestamp)) { seen.add(point.timestamp); compacted.push({ ...point }); }
    }
    return compacted;
  }

  _buildRollup(history, bucket) {
    if (!history.length) return [];
    const aggregated = new Map();
    let prevTotalTokens = 0, prevTotalUsd = 0, prevTotalInput = 0, prevTotalInputUsd = 0;
    for (const point of history) {
      const ts = new Date(point.timestamp);
      const bucketKey = toUtcIso(bucketStart(ts, bucket));
      const totalTokens = point.total_tokens_saved || 0, totalUsd = point.compression_savings_usd || 0;
      const totalInput = point.total_input_tokens || 0, totalInputUsd = point.total_input_cost_usd || 0;
      const deltaTokens = Math.max(totalTokens - prevTotalTokens, 0), deltaUsd = Math.max(totalUsd - prevTotalUsd, 0);
      const deltaInput = Math.max(totalInput - prevTotalInput, 0), deltaInputUsd = Math.max(totalInputUsd - prevTotalInputUsd, 0);
      prevTotalTokens = totalTokens; prevTotalUsd = totalUsd; prevTotalInput = totalInput; prevTotalInputUsd = totalInputUsd;
      if (!aggregated.has(bucketKey)) {
        aggregated.set(bucketKey, {
          timestamp: bucketKey, tokens_saved: 0, compression_savings_usd_delta: 0, total_tokens_saved: totalTokens,
          compression_savings_usd: totalUsd, total_input_tokens_delta: 0, total_input_tokens: totalInput,
          total_input_cost_usd_delta: 0, total_input_cost_usd: totalInputUsd,
        });
      }
      const entry = aggregated.get(bucketKey);
      entry.tokens_saved += deltaTokens; entry.compression_savings_usd_delta += deltaUsd;
      entry.total_input_tokens_delta += deltaInput; entry.total_input_cost_usd_delta += deltaInputUsd;
      entry.total_tokens_saved = totalTokens; entry.compression_savings_usd = parseFloat(totalUsd.toFixed(6));
      entry.total_input_tokens = totalInput; entry.total_input_cost_usd = parseFloat(totalInputUsd.toFixed(6));
    }
    return [...aggregated.values()];
  }

  async _saveAtomic() {
    const dir = path.dirname(this._filePath);
    const tmpFile = path.join(dir, `.cf_savings_${Date.now()}_${process.pid}.tmp`);
    const payload = JSON.stringify({
      schema_version: SCHEMA_VERSION, lifetime: this._state.lifetime,
      display_session: this._state.display_session, history: this._state.history,
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
    const defaultState = { schema_version: SCHEMA_VERSION, lifetime: defaultLifetime(), display_session: emptyDisplaySession(), history: [] };
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
    const history = (raw.history || []).filter((item) => item && item.timestamp).map((item) => ({
      timestamp: item.timestamp, total_tokens_saved: Math.max(0, item.total_tokens_saved || 0),
      compression_savings_usd: Math.max(0, item.compression_savings_usd || 0),
      total_input_tokens: Math.max(0, item.total_input_tokens || 0),
      total_input_cost_usd: Math.max(0, item.total_input_cost_usd || 0),
    })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const lifetime = raw.lifetime || {};
    return {
      schema_version: SCHEMA_VERSION,
      lifetime: {
        requests: Math.max(0, lifetime.requests || 0), tokens_saved: Math.max(0, lifetime.tokens_saved || 0),
        compression_savings_usd: Math.max(0, lifetime.compression_savings_usd || 0),
        total_input_tokens: Math.max(0, lifetime.total_input_tokens || 0),
        total_input_cost_usd: Math.max(0, lifetime.total_input_cost_usd || 0),
        ghost_retries: Math.max(0, lifetime.ghost_retries || 0),
        requests_with_retries: Math.max(0, lifetime.requests_with_retries || 0),
      },
      display_session: emptyDisplaySession(),
      history,
    };
  }
}

export const savingsTracker = new SavingsTracker();