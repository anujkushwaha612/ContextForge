/**
 * jsonCrusher.js
 *
 * Statistical per-item compression for large JSON tool results.
 *
 * The gap this fills: a big JSON array previously had only two fates —
 * pass through whole (45k tokens of near-identical items) or get vaulted
 * whole by fatCatch (forcing a contextforge_retrieve round-trip that pulls
 * ALL 45k tokens right back). This stage adds the third option: keep the
 * items that carry signal INLINE and drop the boring bulk, so the model
 * almost never needs the round-trip.
 *
 * What is kept (in priority order, capped at MAX_KEEP):
 *   1. Error-state items       — status != ok, error/exception keys,
 *                                 level in {error,fatal,warn}, success:false
 *   2. Query-relevant items    — term overlap with the latest user message
 *   3. Numeric outliers        — >2σ from the mean on any shared numeric field
 *   4. Positional samples      — first 3 + last 2 (schema/shape evidence)
 *
 * Guarantees:
 *   - Output is VALID JSON with the original top-level shape preserved.
 *     The drop-note is injected as a final array element so consumers that
 *     iterate the array still work.
 *   - The FULL original is vaulted first (saveToVault content-hash-dedups,
 *     so the same content always yields the same vault id → deterministic
 *     output across client history resends; nothing here calls Date.now()
 *     or random()).
 *   - The note embeds vault_id="cf_vault_…" in exactly the form the CCR
 *     marker scanner recognizes, so the retrieve tool gets injected when
 *     the model needs the dropped rows.
 *   - Respects every pipeline gate: policy.compressToolResults, the
 *     recent-turn age gate, shell-tool protection, _cf_editable, vaulted /
 *     deduped / compressed markers, retrieve-result exemption.
 *   - Idempotent: already-crushed content is recognized and skipped.
 */

import { saveToVault } from "../logging/cacheDb.js";
import { isRecentToolResult } from "./compressionPolicy.js";
import { isShellToolResult } from "./toolScrubber.js";

// ─────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────

const MIN_ITEMS = 30; // arrays smaller than this are left alone
const MIN_CHARS = 8_000; // content smaller than this is left alone
const MAX_KEEP = 50; // hard cap on inline items
const POSITION_HEAD = 3; // first N kept as shape evidence
const POSITION_TAIL = 2; // last N kept as shape evidence
const QUERY_TOP_K = 10; // query-relevant items kept
const OUTLIER_SIGMA = 2; // numeric outlier threshold
const MIN_SAVINGS_RATIO = 0.3; // must save ≥30% …
const MIN_SAVINGS_CHARS = 2_000; // … and ≥2k chars, else not worth the churn

const NOTE_KEY = "_cf_note";

// ─────────────────────────────────────────────
// Error-state detection
// ─────────────────────────────────────────────

const OK_STATUS = new Set([
  "ok",
  "success",
  "succeeded",
  "pass",
  "passed",
  "active",
  "done",
  "completed",
  "complete",
  "fulfilled",
  "healthy",
  "ready",
  "running",
]);
const ERROR_LEVELS = new Set(["error", "err", "fatal", "critical", "warn", "warning"]);
const ERROR_KEYS = [
  "error",
  "err",
  "exception",
  "stack",
  "stacktrace",
  "failure",
  "failureMessage",
];

function isErrorItem(item) {
  if (item == null) return false;
  if (typeof item === "string") {
    return /\b(error|fail(ed|ure)?|exception|fatal|timeout|denied|refused)\b/i.test(item);
  }
  if (typeof item !== "object") return false;

  const status = item.status ?? item.state ?? item.result ?? item.outcome;
  if (typeof status === "string" && !OK_STATUS.has(status.toLowerCase())) return true;

  const level = item.level ?? item.severity;
  if (typeof level === "string" && ERROR_LEVELS.has(level.toLowerCase())) return true;

  for (const k of ERROR_KEYS) {
    if (item[k] !== undefined && item[k] !== null && item[k] !== false && item[k] !== "")
      return true;
  }
  if (item.success === false || item.ok === false || item.passed === false) return true;
  if (item.failed === true) return true;
  const exit = item.exitCode ?? item.exit_code;
  if (typeof exit === "number" && exit !== 0) return true;
  return false;
}

// ─────────────────────────────────────────────
// Numeric outlier detection
// Fields present (as finite numbers) in ≥50% of items are profiled;
// items >OUTLIER_SIGMA standard deviations from the mean are flagged.
// ─────────────────────────────────────────────

function findOutlierIndices(items) {
  const outliers = new Set();
  if (items.length < MIN_ITEMS) return outliers;

  const fieldValues = new Map(); // key → number[ate index parity] {sum, entries:[{idx,val}]}
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it == null || typeof it !== "object" || Array.isArray(it)) continue;
    for (const [k, v] of Object.entries(it)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        if (!fieldValues.has(k)) fieldValues.set(k, []);
        fieldValues.get(k).push({ idx: i, val: v });
      }
    }
  }

  for (const [, entries] of fieldValues) {
    if (entries.length < items.length * 0.5) continue; // not a shared field
    const n = entries.length;
    const mean = entries.reduce((s, e) => s + e.val, 0) / n;
    const variance = entries.reduce((s, e) => s + (e.val - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    if (std === 0) continue; // constant field — no outliers possible
    for (const e of entries) {
      if (Math.abs(e.val - mean) > OUTLIER_SIGMA * std) outliers.add(e.idx);
    }
  }
  return outliers;
}

// ─────────────────────────────────────────────
// Query relevance — deterministic term overlap with the latest user message
// ─────────────────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "are",
  "was",
  "you",
  "your",
  "can",
  "what",
  "how",
  "why",
  "all",
  "any",
  "not",
  "but",
  "please",
  "now",
  "then",
  "them",
  "they",
  "its",
  "his",
  "her",
  "out",
  "use",
]);

function extractQueryTerms(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      // skip pure tool_result carriers — find real text
      const textBlocks = msg.content.filter((b) => b?.type === "text" && b.text);
      if (textBlocks.length === 0) continue;
      text = textBlocks.map((b) => b.text).join(" ");
    } else {
      continue;
    }
    const terms = new Set(
      text
        .toLowerCase()
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .split(/[^a-z0-9_./-]+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    );
    if (terms.size > 0) return terms;
  }
  return new Set();
}

function queryScore(item, terms) {
  if (terms.size === 0) return 0;
  let text;
  try {
    text = (typeof item === "string" ? item : JSON.stringify(item)).toLowerCase();
  } catch {
    return 0;
  }
  let score = 0;
  for (const t of terms) {
    if (text.includes(t)) score++;
  }
  return score;
}

// ─────────────────────────────────────────────
// Array locator — finds the dominant array in the parsed JSON.
// Handles: top-level array, or object with one-or-more array fields
// (the LARGEST by serialized size is chosen; single target keeps the
// transform simple and deterministic).
// ─────────────────────────────────────────────

function locateDominantArray(parsed) {
  if (Array.isArray(parsed)) {
    return { array: parsed, path: null };
  }
  if (parsed && typeof parsed === "object") {
    let best = null;
    for (const [key, val] of Object.entries(parsed)) {
      if (Array.isArray(val) && val.length >= MIN_ITEMS) {
        const size = JSON.stringify(val).length;
        if (!best || size > best.size) best = { array: val, path: key, size };
      }
    }
    if (best) return { array: best.array, path: best.path };
  }
  return null;
}

// ─────────────────────────────────────────────
// Dropped-items summary (short, deterministic)
// ─────────────────────────────────────────────

function summarizeDropped(items, droppedIdx) {
  const statusCounts = new Map();
  for (const i of droppedIdx) {
    const it = items[i];
    if (it && typeof it === "object" && !Array.isArray(it)) {
      const s = it.status ?? it.state ?? it.level;
      if (typeof s === "string") {
        statusCounts.set(s, (statusCounts.get(s) || 0) + 1);
      }
    }
  }
  if (statusCounts.size === 0) return "";
  const parts = [...statusCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([s, c]) => `${c}× ${s}`);
  return ` (${parts.join(", ")})`;
}

// ─────────────────────────────────────────────
// Core crush of a single JSON string
// Returns { crushed, savedChars, vaultId } or null when not applicable.
// ─────────────────────────────────────────────

export function crushJsonContent(content, queryTerms) {
  if (typeof content !== "string" || content.length < MIN_CHARS) return null;

  // Idempotency: already carries our note → leave alone
  if (content.includes(`"${NOTE_KEY}"`) && content.includes("cf_vault_")) return null;
  // Never touch stubs
  if (content.startsWith("[CF_VAULT:") || content.startsWith("[CF_COMPRESSED")) return null;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null; // not valid JSON — not ours to touch
  }

  const located = locateDominantArray(parsed);
  if (!located || located.array.length < MIN_ITEMS) return null;

  const items = located.array;
  const n = items.length;

  // ── Score & select ──────────────────────────────────────────────────
  const keep = new Set();

  // 1. errors — highest priority, all of them (cap applied at the end)
  const errorIdx = [];
  for (let i = 0; i < n; i++) {
    if (isErrorItem(items[i])) errorIdx.push(i);
  }

  // 2. query-relevant — top K by score, index as deterministic tie-break
  const scored = [];
  if (queryTerms && queryTerms.size > 0) {
    for (let i = 0; i < n; i++) {
      const s = queryScore(items[i], queryTerms);
      if (s > 0) scored.push({ i, s });
    }
    scored.sort((a, b) => b.s - a.s || a.i - b.i);
  }
  const queryIdx = scored.slice(0, QUERY_TOP_K).map((e) => e.i);

  // 3. numeric outliers
  const outlierIdx = [...findOutlierIndices(items)].sort((a, b) => a - b);

  // 4. positional shape samples
  const positionIdx = [];
  for (let i = 0; i < Math.min(POSITION_HEAD, n); i++) positionIdx.push(i);
  for (let i = Math.max(0, n - POSITION_TAIL); i < n; i++) positionIdx.push(i);

  // Priority fill up to MAX_KEEP: position (cheap, tiny) → errors → query → outliers
  for (const i of positionIdx) keep.add(i);
  for (const bucket of [errorIdx, queryIdx, outlierIdx]) {
    for (const i of bucket) {
      if (keep.size >= MAX_KEEP) break;
      keep.add(i);
    }
  }

  if (keep.size >= n) return null; // nothing would be dropped

  // ── Rebuild ─────────────────────────────────────────────────────────
  const keptOrdered = [...keep].sort((a, b) => a - b);
  const droppedCount = n - keptOrdered.length;
  const droppedIdx = [];
  for (let i = 0; i < n; i++) if (!keep.has(i)) droppedIdx.push(i);

  // Vault the FULL original before dropping anything. saveToVault
  // content-hash-dedups → same content always returns the same id.
  const vaultId = saveToVault(content);

  // NOTE: the vault id is deliberately UNQUOTED. This note lives inside a
  // JSON string — quotes would serialize as \" and the escaped form breaks
  // the retrieval marker scanner's pattern (vault_id[=:]\s*["']?cf_vault_…).
  // The bare form matches cleanly both raw and JSON-escaped.
  const note = {
    [NOTE_KEY]:
      `${keptOrdered.length} of ${n} items shown — ${droppedCount} similar items ` +
      `omitted${summarizeDropped(items, droppedIdx)}. Errors, outliers and ` +
      `query-relevant items were kept. Full data: use tool call ` +
      `contextforge_retrieve with vault_id=${vaultId}`,
  };

  const newArray = [...keptOrdered.map((i) => items[i]), note];

  let rebuilt;
  if (located.path === null) {
    rebuilt = newArray;
  } else {
    rebuilt = { ...parsed, [located.path]: newArray };
  }

  const crushed = JSON.stringify(rebuilt);
  const savedChars = content.length - crushed.length;

  // Not worth it → leave original untouched (and the vault entry is
  // content-hash-dedup'd, so an unused save costs one idempotent row).
  if (savedChars < MIN_SAVINGS_CHARS || savedChars / content.length < MIN_SAVINGS_RATIO) {
    return null;
  }

  return { crushed, savedChars, vaultId, kept: keptOrdered.length, total: n };
}

// ─────────────────────────────────────────────
// Pipeline entry point
// ─────────────────────────────────────────────

export function crushJsonToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  if (process.env.CF_DISABLE_JSON_CRUSH === "true") return payload;

  const policy = payload.__policy ?? null;

  // Same master switch the AST compressor honors: at LOW pressure on a
  // local upstream, tool results are left untouched.
  if (policy && policy.compressToolResults === false) return payload;

  const queryTerms = extractQueryTerms(payload.messages);
  let totalSaved = 0;

  payload.messages = payload.messages.map((msg, msgIndex) => {
    // ── OpenAI format: role:"tool" ──────────────────────────────────────
    if (msg.role === "tool" && typeof msg.content === "string") {
      if (msg._cf_type !== "json") return msg;
      if (msg.name === "contextforge_retrieve" || /contextforge_retrieve$/.test(msg.name ?? ""))
        return msg;
      if (isShellToolResult(msg)) return msg;
      if (msg._cf_editable === true) return msg;
      if (msg._cf_vaulted || msg._cf_deduped || msg._compressedVaultId || msg._cf_jsonCrushed)
        return msg;
      if (isRecentToolResult(payload.messages, msgIndex, policy)) return msg;

      const result = crushJsonContent(msg.content, queryTerms);
      if (!result) return msg;

      totalSaved += result.savedChars;
      console.log(
        `[JSON Crush] 📉 ${result.total} → ${result.kept} items ` +
          `(${result.savedChars.toLocaleString()} chars saved) → vault ${result.vaultId}`
      );
      return { ...msg, content: result.crushed, _cf_jsonCrushed: true };
    }

    // ── Anthropic format: role:"user" with tool_result blocks ───────────
    if (msg.role === "user" && Array.isArray(msg.content)) {
      let modified = false;
      const newContent = msg.content.map((block) => {
        if (block?.type !== "tool_result" || typeof block.content !== "string") return block;
        if (block._cf_type !== "json") return block;
        if (
          block.name === "contextforge_retrieve" ||
          /contextforge_retrieve$/.test(block.name ?? "")
        )
          return block;
        if (isShellToolResult(block)) return block;
        if (block._cf_editable === true) return block;
        if (
          block._cf_vaulted ||
          block._cf_deduped ||
          block._compressedVaultId ||
          block._cf_jsonCrushed
        )
          return block;
        if (isRecentToolResult(payload.messages, msgIndex, policy)) return block;

        const result = crushJsonContent(block.content, queryTerms);
        if (!result) return block;

        totalSaved += result.savedChars;
        modified = true;
        console.log(
          `[JSON Crush] 📉 ${result.total} → ${result.kept} items ` +
            `(${result.savedChars.toLocaleString()} chars saved) → vault ${result.vaultId}`
        );
        return { ...block, content: result.crushed, _cf_jsonCrushed: true };
      });
      return modified ? { ...msg, content: newContent } : msg;
    }

    return msg;
  });

  if (totalSaved > 0) {
    payload._cf_jsonCrushTokensSaved = Math.round(totalSaved / 4);
  }

  return payload;
}
