/**
 * systemMessages.js
 *
 * Pipeline Stage 1 — always-on, runs on every request.
 *
 * Two operations:
 *   1. injectContextForgeRule  — appends ContextForge operating instructions
 *      to the first system message (or creates one if none exists).
 *
 *   2. deduplicateSystemMessages — removes redundant/duplicate system messages
 *      that some clients send on every turn.
 *
 * Fixes applied:
 *   SM-1: injectContextForgeRule now uses object spread instead of direct
 *         property mutation. All pipeline stages must treat message objects
 *         as immutable.
 *
 *   SM-2: Now searches for the FIRST system message (forward scan, stops
 *         immediately) instead of the last (backward scan through all messages).
 *         The first system message is what deduplicateSystemMessages preserves.
 *
 *   SM-7: Rule is no longer injected unconditionally. contextforge_patch_ast
 *         instruction is only appended when the patch tool is actually present
 *         in payload.tools. CHAT-classified requests that bypass tool injection
 *         no longer receive instructions to use a tool that does not exist.
 *         A shorter always-injected notice replaces the conditional tool instruction.
 *
 *   SM-4: deduplicateSystemMessages now uses a single combined pass instead
 *         of two separate O(n) passes (map then filter).
 */

import crypto from "node:crypto";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

// Always-present ContextForge notice — injected regardless of which tools are active.
// Tells the LLM it is operating behind a proxy without referencing specific tools.
const CF_NOTICE =
  "\n\nYou are operating behind ContextForge. " +
  "File contents may be structurally compressed to save context. " +
  "When making edits, use the tools provided in this session — " +
  "do not use built-in file editing capabilities.";

// Patch tool instruction — only injected when contextforge_patch_ast is in payload.tools.
const CF_PATCH_INSTRUCTION =
  " You MUST use the `contextforge_patch_ast` tool to make all edits to files.";

// Dedup sentinel — checked before injecting to avoid duplicating on retries
const CF_SENTINEL = "ContextForge";

// Skills list phrase — used for pruning verbose skill catalogs
const SKILLS_PHRASE =
  "The following skills are available for use with the Skill tool:";

// ─────────────────────────────────────────────
// injectContextForgeRule
//
// SM-1: Uses object spread — never mutates existing message objects.
// SM-2: Forward scan to find FIRST system message — consistent with
//       what deduplicateSystemMessages preserves (first-seen hash).
// SM-7: patch tool instruction only added when tool is present.
// ─────────────────────────────────────────────

export function injectContextForgeRule(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  // SM-7: Check if patch tool is actually available in this request
  const hasPatchTool = Array.isArray(payload.tools) &&
    payload.tools.some((t) => {
      const name = t.name || t.function?.name || "";
      return name === "contextforge_patch_ast";
    });

  const rule = hasPatchTool
    ? CF_NOTICE + CF_PATCH_INSTRUCTION
    : CF_NOTICE;

  // SM-2: Forward scan — first system message is the canonical one.
  // The translator always places system messages at index 0.
  for (let i = 0; i < payload.messages.length; i++) {
    const msg = payload.messages[i];

    if (msg.role !== "system") continue;
    if (typeof msg.content !== "string") continue;

    // Already injected — skip to avoid duplication on retry hops
    if (msg.content.includes(CF_SENTINEL)) return payload;

    // SM-1: Spread to create new object — never mutate in place
    const newMessages = [...payload.messages];
    newMessages[i] = {
      ...msg,
      content: msg.content + rule,
    };

    return { ...payload, messages: newMessages };
  }

  // No system message found — create one at the start
  return {
    ...payload,
    messages: [
      { role: "system", content: rule.trim() },
      ...payload.messages,
    ],
  };
}

// ─────────────────────────────────────────────
// deduplicateSystemMessages
//
// SM-4: Single combined pass instead of map() then filter().
//       Skills pruning and duplicate detection happen in the same iteration.
// ─────────────────────────────────────────────

export function deduplicateSystemMessages(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  const systemMessages = payload.messages.filter((m) => m.role === "system");

  // If there is only ONE system message, never touch it
  if (systemMessages.length <= 1) return payload;

  const seenSystemPrompts = new Set();
  let prunedCount = 0;
  let charsSaved  = 0;

  // SM-4: Single pass — prune skills list AND deduplicate in one iteration
  const newMessages = [];

  for (const msg of payload.messages) {
    // Non-system messages pass through unchanged
    if (msg.role !== "system" || typeof msg.content !== "string") {
      newMessages.push(msg);
      continue;
    }

    let content = msg.content;

    // ── Skills list pruning ──────────────────────────────────────────────
    // Remove verbose skill catalogs that Claude Code sometimes injects.
    // Only removes the list, not the surrounding context.
    if (content.includes(SKILLS_PHRASE)) {
      const splitIdx = content.indexOf(SKILLS_PHRASE);
      const cleanContent =
        content.slice(0, splitIdx).trim() +
        "\n[ContextForge: Repetitive skills list removed to save tokens]";

      if (cleanContent.length < content.length) {
        charsSaved  += content.length - cleanContent.length;
        prunedCount++;
        content = cleanContent;
      }
    }

    // ── Duplicate detection ──────────────────────────────────────────────
    // SHA-256 of the (possibly pruned) content.
    // Exact byte-for-byte duplicates are removed. Dynamic content
    // (different dates, session IDs) produces different hashes and is kept.
    const promptHash = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");

    if (seenSystemPrompts.has(promptHash)) {
      // Duplicate — skip entirely
      charsSaved += content.length;
      prunedCount++;
      continue;
    }

    seenSystemPrompts.add(promptHash);

    // Push the (possibly pruned) message — spread only if content changed
    if (content !== msg.content) {
      newMessages.push({ ...msg, content });
    } else {
      newMessages.push(msg);
    }
  }

  if (prunedCount > 0) {
    const tokensSaved = Math.floor(charsSaved / 4);
    payload._cf_sysPromptTokensSaved = tokensSaved;
  }

  return { ...payload, messages: newMessages };
}