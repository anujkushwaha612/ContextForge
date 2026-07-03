/**
 * compressionPolicy.js — REWRITTEN
 *
 * The old file inferred FAST/BALANCED/PRECISE from the model name and then
 * returned IDENTICAL values for all three modes — 150 lines computing a
 * constant. Model name is also the wrong signal: what actually determines
 * good compression behavior is
 *
 *   1. CONTEXT PRESSURE  — how full is the window? Compressing a 10k-token
 *      conversation saves nothing and costs retrieve round-trips.
 *      Compressing a 150k-token one is survival.
 *   2. MESSAGE AGE       — a tool result the model JUST requested must stay
 *      readable (compressing it forces an immediate contextforge_retrieve —
 *      the self-defeating loop observed in the S3-refactor session).
 *      Old history is retransmitted every turn — that's where savings live.
 *   3. UPSTREAM COST     — local (ollama): tokens are free, round-trips are
 *      expensive → compress late, vault rarely. Cloud APIs: tokens are money
 *      → compress earlier.
 *
 * This file resolves those three signals into one Policy per request and
 * provides the age-gate helper (isRecentToolResult) that astCompressor and
 * semanticDedup call. It fixes F1/F2 from the session diagnosis:
 *
 *   F1: policy.recentTurnExemption — tool results newer than N assistant
 *       turns are never AST-compressed and never deduped.
 *   F2: policy.dedupKeepNewest — dedup replaces the OLDER occurrence,
 *       keeping the newest copy readable.
 *
 * Backward compatibility: getPolicyForModel(model) still works (server.js
 * line ~886) and now returns a pressure-aware policy when given the payload:
 *       getPolicyForModel(payload.model, payload)
 */

// ─────────────────────────────────────────────
// Pressure tiers
// ─────────────────────────────────────────────

export const Pressure = Object.freeze({
  LOW: "low",       // plenty of headroom — do almost nothing
  MEDIUM: "medium", // normal agentic session — compress old history only
  HIGH: "high",     // window filling up — compress everything but the live turn
});

// Rough char→token: 4 chars ≈ 1 token (same convention as the rest of CF).
const CHARS_PER_TOKEN = 4;

/** Estimate payload size in tokens without a tokenizer pass (cheap, ±15%). */
export function estimatePayloadTokens(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (typeof block?.text === "string") chars += block.text.length;
        else if (typeof block?.content === "string") chars += block.content.length;
      }
    }
  }
  // tools/system add real weight but minimize_tools handles them separately
  return Math.round(chars / CHARS_PER_TOKEN);
}

// ─────────────────────────────────────────────
// Upstream cost class (the one thing provider/model name IS good for)
// ─────────────────────────────────────────────

const LOCAL_HINTS = ["ollama", "lm-studio", "llama.cpp", "localhost", "llamacpp"];

export function isLocalUpstream({ provider = "", model = "" } = {}) {
  const p = String(provider).toLowerCase();
  const m = String(model).toLowerCase();
  if (LOCAL_HINTS.some((h) => p.includes(h))) return true;
  // ollama-style tags: "qwen2.5-coder:14b", "minimax-m3:cloud"
  if (/:[a-z0-9._-]+$/.test(m) && !m.startsWith("claude") && !m.startsWith("gpt")) return true;
  return false;
}

// ─────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────

export class CompressionPolicy {
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

/**
 * Tier tables. Two dimensions: pressure × (local|cloud).
 * Values chosen from the observed session:
 *  - recentTurnExemption=2: model needs 1 reasoning + 1 action turn with
 *    content visible before it's safe to stub (prevents the retrieve loop).
 *  - minLinesToCompress replaces astCompressor's hardcoded `< 30` guard.
 *  - vault threshold: local models pay latency per retrieve, not per token —
 *    keep it high; cloud pays per token — lower it under pressure.
 */
const TIERS = {
  [Pressure.LOW]: {
    local: { compressToolResults: false, recentTurnExemption: 3, minLinesToCompress: 120,
             singleMsgVaultThreshold: 100_000, maxBodyLines: 8, dedupEnabled: true },
    cloud: { compressToolResults: true,  recentTurnExemption: 3, minLinesToCompress: 60,
             singleMsgVaultThreshold: 60_000,  maxBodyLines: 6, dedupEnabled: true },
  },
  [Pressure.MEDIUM]: {
    local: { compressToolResults: true,  recentTurnExemption: 2, minLinesToCompress: 60,
             singleMsgVaultThreshold: 60_000,  maxBodyLines: 4, dedupEnabled: true },
    cloud: { compressToolResults: true,  recentTurnExemption: 2, minLinesToCompress: 40,
             singleMsgVaultThreshold: 30_000,  maxBodyLines: 4, dedupEnabled: true },
  },
  [Pressure.HIGH]: {
    local: { compressToolResults: true,  recentTurnExemption: 1, minLinesToCompress: 30,
             singleMsgVaultThreshold: 24_000,  maxBodyLines: 3, dedupEnabled: true },
    cloud: { compressToolResults: true,  recentTurnExemption: 1, minLinesToCompress: 30,
             singleMsgVaultThreshold: 16_000,  maxBodyLines: 2, dedupEnabled: true },
  },
};

// Pressure boundaries in estimated tokens. Deliberately conservative:
// most local models run 32k–128k windows; Claude-bound sessions run 200k.
const PRESSURE_BOUNDS = { mediumAt: 15_000, highAt: 45_000 };

export function classifyPressure(estTokens) {
  if (estTokens >= PRESSURE_BOUNDS.highAt) return Pressure.HIGH;
  if (estTokens >= PRESSURE_BOUNDS.mediumAt) return Pressure.MEDIUM;
  return Pressure.LOW;
}

/**
 * PRIMARY ENTRY POINT.
 *
 * resolvePolicy({ model, provider, payload }) → CompressionPolicy
 *
 * All fields:
 *   pressure                "low" | "medium" | "high"     (why decisions were made)
 *   local                   boolean                        (upstream cost class)
 *   compressToolResults     master switch for astCompressor
 *   recentTurnExemption     F1 — tool results newer than N assistant turns
 *                           are exempt from compression AND dedup
 *   minLinesToCompress      replaces astCompressor's hardcoded 30
 *   singleMsgVaultThreshold fatCatch trigger (chars)
 *   maxBodyLines            native compressor body cap
 *   preserveErrorHandlers   native compressor
 *   minTokensToCompress     native compressor
 *   dedupEnabled            master switch for semanticDedup
 *   dedupKeepNewest         F2 — stub the OLDER occurrence, keep newest full
 *   mode                    legacy field (logging compatibility)
 */
export function resolvePolicy({ model = "", provider = "", payload = null } = {}) {
  const local = isLocalUpstream({ provider: provider || process.env.CF_PROVIDER || "", model });
  const estTokens = payload ? estimatePayloadTokens(payload) : 0;
  const pressure = classifyPressure(estTokens);
  const t = TIERS[pressure][local ? "local" : "cloud"];

  return new CompressionPolicy({
    pressure,
    local,
    estTokens,
    ...t,
    preserveErrorHandlers: true,
    minTokensToCompress: 80,
    dedupKeepNewest: true, // F2 — always on; old behavior was a bug, not a mode
    mode: pressure,        // legacy log field: [mode=medium] now means pressure
  });
}

// ─────────────────────────────────────────────
// F1 helper — the age gate.
// Called by astCompressor + semanticDedup per message.
// ─────────────────────────────────────────────

/**
 * A tool result is "recent" if fewer than policy.recentTurnExemption
 * assistant messages appear AFTER it in the conversation. Assistant
 * messages are the model's turns — N of them after a tool result means
 * the model has had N chances to read and act on that content.
 *
 * @param {Array}  messages  payload.messages
 * @param {number} index     index of the tool message being considered
 * @param {object} policy    resolved CompressionPolicy
 */
export function isRecentToolResult(messages, index, policy) {
  const exemption = policy?.recentTurnExemption ?? 2;
  if (exemption <= 0) return false;
  let assistantTurnsAfter = 0;
  for (let i = index + 1; i < messages.length; i++) {
    if (messages[i]?.role === "assistant") {
      assistantTurnsAfter++;
      if (assistantTurnsAfter >= exemption) return false;
    }
  }
  return true;
}

/**
 * F3 helper — never dedup against a stub.
 * Given the registry's remembered turn content marker, callers should verify
 * the referenced original is still full content. Cheap textual check:
 */
export function looksLikeStub(content) {
  return typeof content === "string" &&
    (content.startsWith("[CF_COMPRESSED_FILE") || content.startsWith("[CF_VAULT:"));
}

// ─────────────────────────────────────────────
// Backward-compatible exports (server.js line ~886 calls getPolicyForModel)
// ─────────────────────────────────────────────

export const ModelMode = Object.freeze({
  FAST: "fast",
  BALANCED: "balanced",
  PRECISE: "precise",
});

/**
 * Legacy entry point. Now accepts the payload as an optional second arg —
 * server.js should be updated to:
 *     const policy = getPolicyForModel(payload.model || "", payload);
 * Without the payload it still works (pressure defaults to LOW → gentle).
 */
export function getPolicyForModel(modelName = "", payload = null) {
  return resolvePolicy({ model: modelName, payload });
}

export function defaultPolicy() {
  return resolvePolicy({});
}

/** Legacy shim: mode-based lookup maps onto pressure tiers. */
export function policyForMode(mode) {
  const pressure =
    mode === ModelMode.FAST ? Pressure.LOW :
    mode === ModelMode.PRECISE ? Pressure.MEDIUM :
    Pressure.MEDIUM;
  const t = TIERS[pressure].local;
  return new CompressionPolicy({
    pressure, local: true, estTokens: 0, ...t,
    preserveErrorHandlers: true, minTokensToCompress: 80,
    dedupKeepNewest: true, mode,
  });
}

/** Legacy shim: kept so imports don't break; no longer drives behavior. */
export function inferModelMode(modelName = "") {
  const lower = String(modelName).toLowerCase();
  if (isLocalUpstream({ model: lower })) return ModelMode.FAST;
  if (lower.includes("opus") || lower.includes("gpt-4") || lower.includes("o1") || lower.includes("o3"))
    return ModelMode.PRECISE;
  return ModelMode.BALANCED;
}
