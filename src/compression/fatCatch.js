/**
 * fatCatch.js — REWRITTEN as a JUNK CATCHER.
 *
 * Diagnosis of the old version:
 *   - At the old fixed threshold (150k chars) it effectively never fired —
 *     the "[Fat Catch]" lines in session logs come from cacheDb.saveToVault
 *     dedup logging, not from this stage.
 *   - When it did fire, it was aimed at the wrong target: legitimate big
 *     code files, which the AST compressor handles strictly better (keeps
 *     a skeleton; fatCatch's stub keeps NOTHING).
 *
 * New role — catch what NOTHING else in the pipeline handles:
 *   The AST compressor only helps with parseable code. Dedup only helps
 *   with repeats. The FIRST read of a minified bundle, package-lock.json,
 *   base64 blob, or giant log/JSON dump sails through both. That's the
 *   "fat" this stage catches.
 *
 * Fixes (FC-1 … FC-5):
 *   FC-1  Junk detection expanded beyond minified JS: base64/data-URI
 *         blobs, giant single-line JSON, lockfiles. Junk is vaulted at a
 *         LOW threshold (junkThreshold) because the model can't use it
 *         raw anyway — vaulting junk is nearly free.
 *   FC-2  Parseable code is NO LONGER blindly vaulted at the main
 *         threshold — it passes through for the AST compressor to
 *         skeleton-ize (strictly more useful than a blind stub). Only a
 *         hard ceiling (4× threshold) still force-vaults code, as an
 *         emergency brake.
 *   FC-3  Age gate honored for NON-junk content (policy.recentTurnExemption
 *         via payload.__policy) — a fresh giant-but-legit result the model
 *         just asked for isn't ripped away before it can be read. Junk is
 *         exempt from the age gate: it's unusable fresh or stale.
 *   FC-4  Stub now carries context: filename, content class, size, and a
 *         head preview — the model can decide whether retrieval is worth
 *         a round-trip instead of retrieving blind.
 *   FC-5  Threshold comes from policy.singleMsgVaultThreshold (pressure-
 *         aware: 16k–100k) with the arg as fallback; junkThreshold scales
 *         with it.
 */

import { saveToVault } from "../logging/cacheDb.js";
import { isShellToolResult } from "./toolScrubber.js";
import { isRecentToolResult } from "./compressionPolicy.js";
import { passesTokenGate } from "./compressionHelper.js";

// ─────────────────────────────────────────────
// Junk classifiers (FC-1)
// ─────────────────────────────────────────────

const MINIFIED_MIN_CHARS = 5_000;
const MINIFIED_LONG_LINE_THRESHOLD = 200;
const MINIFIED_LONG_LINE_RATIO = 0.8;

function isMinifiedCode(content) {
  if (content.length <= MINIFIED_MIN_CHARS) return false;
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const longLines = lines.filter((l) => l.length > MINIFIED_LONG_LINE_THRESHOLD).length;
  return longLines / lines.length > MINIFIED_LONG_LINE_RATIO;
}

function isBase64Blob(content) {
  if (content.length < 10_000) return false;
  // sample the middle — data URIs / embedded blobs are contiguous
  const sample = content.slice(Math.floor(content.length / 2), Math.floor(content.length / 2) + 2_000);
  const b64ish = sample.replace(/[A-Za-z0-9+/=\s]/g, "").length / Math.max(sample.length, 1);
  return b64ish < 0.02 && /[A-Za-z0-9+/]{120,}/.test(sample);
}

function isLockfile(filename = "") {
  return /package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock/i
    .test(filename);
}

function isGiantSingleLineJson(content, msgType) {
  if (msgType !== "json" && msgType !== "code") return false;
  if (content.length < 20_000) return false;
  const firstNl = content.indexOf("\n");
  const effectivelyOneLine = firstNl === -1 || firstNl > content.length * 0.9;
  return effectivelyOneLine && /^[\s]*[[{]/.test(content);
}

/** Classify junk. Returns a label or null. */
function classifyJunk(content, msgType, filename) {
  if (isLockfile(filename)) return "lockfile";
  if (msgType === "code" && isMinifiedCode(content)) return "minified code";
  if (isBase64Blob(content)) return "base64/binary blob";
  if (isGiantSingleLineJson(content, msgType)) return "single-line JSON dump";
  return null;
}

// ─────────────────────────────────────────────
// Stub builder (FC-4)
// ─────────────────────────────────────────────

function buildStub(content, vaultId, { kind, filename }) {
  const tokens = Math.round(content.length / 4);
  const head = content.slice(0, 200).replace(/\s+/g, " ").trim();
  const name = filename ? ` file: ${String(filename).replace(/\\/g, "/")}` : "";
  return (
    `[CF_VAULT:${vaultId}] ${kind} intercepted (${tokens.toLocaleString()} tokens).${name}\n` +
    `Preview: ${head}…\n` +
    `This content class is rarely useful to read in full. If you truly need it, ` +
    `use tool call contextforge_retrieve with vault_id="${vaultId}".`
  );
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

export function interceptAndVaultMassiveToolResults(payload, charThreshold = 150_000) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  if (process.env.CF_DISABLE_FAT_CATCH === "true") {
    console.warn("[Fat Catch] ⚠️  Bypassed via CF_DISABLE_FAT_CATCH=true environment variable");
    return payload;
  }

  // FC-5: pressure-aware threshold from policy when present
  const policy = payload.__policy ?? null;
  const threshold = policy?.singleMsgVaultThreshold ?? charThreshold;
  const junkThreshold = Math.min(10_000, threshold); // junk is cheap to vault
  const hardCeiling = threshold * 4;                 // emergency brake for anything

  function processContent(content, msgType, filename, msgIndex) {
    // Never re-process already-vaulted or already-compressed content
    if (
      content.includes("[CF_VAULT:") ||
      content.includes('[CF_COMPRESSED_FILE vault_id:') ||
      content.startsWith("[CF_COMPRESSED]")
    ) {
      return content;
    }

    // ── FC-1: junk — vault at LOW threshold, NO age gate (unusable anyway)
    const junkKind = classifyJunk(content, msgType, filename);
    if (junkKind && content.length > junkThreshold) {
      const vaultId = saveToVault(content);
      const stub = buildStub(content, vaultId, { kind: `${junkKind[0].toUpperCase()}${junkKind.slice(1)}`, filename });
      // A1 (headroom analysis): token-validation gate — the threshold is
      // char-based; the stub must actually be smaller in tokens before we
      // replace (today always true at these thresholds, but the gate is
      // what keeps that true if junkThreshold ever drops).
      if (!passesTokenGate(content, stub)) {
        return content;
      }
      console.log(
        `[Fat Catch] 🗑️  ${junkKind} (${content.length} chars) → vaulted ${vaultId}`
      );
      return stub;
    }

    // ── FC-3: age gate for legitimate content — never rip away something
    // the model just asked for and hasn't had a turn to read.
    if (isRecentToolResult(payload.messages, msgIndex, policy)) {
      // …unless it breaches the hard ceiling — then it endangers the window
      if (content.length <= hardCeiling) return content;
    }

    // ── FC-2: parseable code below the hard ceiling → leave for the AST
    // compressor (skeleton beats blind stub). Non-code (text/markdown/json)
    // has no better handler, so the main threshold applies to it.
    if (msgType === "code" && content.length <= hardCeiling) {
      return content;
    }

    if (content.length > threshold) {
      const vaultId = saveToVault(content);
      const stub = buildStub(content, vaultId, { kind: "Oversized tool result", filename });
      // A1: same token-validation gate as the junk path.
      if (!passesTokenGate(content, stub)) {
        return content;
      }
      console.log(
        `[Fat Catch] 🕸️  Massive ${msgType || "unknown"} result (${content.length} chars) ` +
          `→ vaulted ${vaultId} [threshold=${threshold}]`
      );
      return stub;
    }

    return content;
  }

  payload.messages = payload.messages.map((msg, msgIndex) => {
    // ── OpenAI format: role:"tool" ────────────────────────────────────────
    if (msg.role === "tool" && typeof msg.content === "string") {
      if (msg.name === "contextforge_retrieve" || /contextforge_retrieve$/.test(msg.name ?? "")) return msg;
      if (isShellToolResult(msg)) return msg;
      if (msg._cf_vaulted || msg._cf_deduped || msg._compressedVaultId) return msg;

      const newContent = processContent(msg.content, msg._cf_type, msg._filename, msgIndex);
      if (newContent !== msg.content) {
        return { ...msg, _cf_vaulted: true, content: newContent };
      }
      return msg;
    }

    // ── Anthropic format: role:"user" with tool_result blocks ────────────
    if (msg.role === "user" && Array.isArray(msg.content)) {
      let modified = false;
      const newContent = msg.content.map((block) => {
        if (block.type === "tool_result" && typeof block.content === "string") {
          if (block.name === "contextforge_retrieve" || /contextforge_retrieve$/.test(block.name ?? "")) return block;
          if (isShellToolResult(block)) return block;
          if (block._cf_vaulted || block._cf_deduped || block._compressedVaultId) return block;

          const processed = processContent(block.content, block._cf_type, block._filename, msgIndex);
          if (processed !== block.content) {
            modified = true;
            return { ...block, _cf_vaulted: true, content: processed };
          }
        }
        return block;
      });
      if (modified) return { ...msg, content: newContent };
    }

    return msg;
  });

  return payload;
}
