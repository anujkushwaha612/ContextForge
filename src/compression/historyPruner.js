/**
 * historyPruner.js
 *
 * Prunes stale vault retrieve results from conversation history.
 *
 * Problem:
 *   Each contextforge_retrieve hop adds ~2,000-3,000 chars of source
 *   code into currentPayload.messages. These messages accumulate across
 *   turns — Claude Code sends the full history every request, so the
 *   baseline grows by ~800 tokens per turn indefinitely.
 *
 * Solution:
 *   Replace the content of completed retrieve results with a short stub.
 *   "Completed" means the retrieval happened before the current user turn
 *   (the human has replied, so the agentic loop that used this content
 *   is finished). The stub preserves conversation coherence — the LLM
 *   knows it retrieved something — without paying the token cost.
 *
 * Two collapse triggers:
 *
 *   1. Turn boundary (primary):
 *      Any retrieve result that appears before the last user message is
 *      historical. The human replied, meaning the loop concluded.
 *      These are always safe to collapse.
 *
 *   2. Post-patch invalidation (secondary, within same turn):
 *      If a retrieve for vault X is followed by a successful patch that
 *      references the same file, the retrieved content is now stale —
 *      the file has changed. Collapse it even within the current turn.
 *
 * What is NOT collapsed:
 *   - The most recent retrieve result (LLM may still be using it)
 *   - Graph query results (JSON, short, not the problem)
 *   - Read file chunk results (raw source, LLM needs for patching)
 *   - Memory tool results (small, unrelated)
 *   - Anything already pruned (_cf_pruned flag)
 *   - Short results under 500 chars (not worth pruning)
 */

import { passesTokenGate } from "./compressionHelper.js";

const PRUNE_THRESHOLD_CHARS = 500;

const PRUNE_STUB =
  "[ContextForge: Vault content was retrieved and used in a prior turn. " +
  "Source code omitted to reduce context size. " +
  "Call contextforge_retrieve again if you need the current file state.]";

/**
 * HP-1 FIX: Match retrieve tool names in ALL their wire forms.
 * Through Claude Code MCP the name arrives as
 * "mcp__contextforge__contextforge_retrieve"; direct API clients send
 * "contextforge_retrieve". The old exact-equality check matched only the
 * bare form — the pruner NEVER fired in real MCP sessions (0 log lines in
 * the S3-refactor session despite 4+ retrieves).
 */
function isRetrieveToolName(name) {
  return typeof name === "string" && name.endsWith("contextforge_retrieve");
}

/**
 * Extract vault ID from a retrieve result message content.
 * Returns null if not a vault retrieve result.
 */
function extractVaultIdFromContent(content) {
  if (typeof content !== "string") return null;
  const match = content.match(/\[CF_VAULT:(cf_vault_[a-f0-9]+)\]/);
  return match ? match[1] : null;
}

/**
 * Extract file path from a patch tool call arguments string.
 * Used for post-patch invalidation within the same turn.
 */
function extractFilePathFromPatchArgs(toolCall) {
  if (!toolCall?.function?.arguments) return null;
  try {
    const args = JSON.parse(toolCall.function.arguments);
    return args.file_path || null;
  } catch {
    return null;
  }
}

/**
 * Prune stale vault retrieve results from conversation history.
 *
 * @param {object} payload - Full pipeline payload with messages array
 * @returns {object} - Payload with stale retrieve results collapsed
 */
export function pruneStaleToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;
  if (payload.messages.length < 3) return payload;

  // ── Find the last human-authored user message index ───────────────────
  // Messages before this index are historical — the human has replied,
  // meaning any agentic loop that produced those messages has concluded.
  let lastUserIdx = -1;
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const msg = payload.messages[i];
    if (msg.role !== "user") continue;

    // Skip Anthropic-format tool result messages (role:"user" with tool_result blocks)
    if (
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      msg.content.every((b) => b.type === "tool_result")
    )
      continue;

    lastUserIdx = i;
    break;
  }

  // HP-3 FIX: was `lastUserIdx <= 0`, which disabled the WHOLE pruner —
  // including post-patch invalidation — for single-user-message sessions
  // (i.e. every single-task agentic run). Only bail when there is no user
  // message at all; with lastUserIdx === 0 the historical trigger simply
  // never fires (nothing precedes the first message) but post-patch
  // invalidation still works.
  if (lastUserIdx < 0) return payload;

  // ── Build maps for exact vault tracking ────────────────────────────────
  const toolCallToFilePath = new Map();
  const retrieveToolCallToVaultId = new Map();
  const vaultToFilePath = new Map();
  // HP-2 FIX: identify retrieve RESULTS via tool_call_id, not msg.name —
  // some translation paths drop `name` on tool results entirely.
  const retrieveCallIds = new Set();

  for (const msg of payload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (isRetrieveToolName(tc.function?.name)) retrieveCallIds.add(tc.id);
        if (!tc.function?.arguments) continue;
        try {
          const args = JSON.parse(tc.function.arguments);
          if (args.file_path) {
            toolCallToFilePath.set(tc.id, args.file_path.replace(/\\/g, "/").toLowerCase());
          }
          if (isRetrieveToolName(tc.function.name) && args.vault_id) {
            retrieveToolCallToVaultId.set(tc.id, args.vault_id);
          }
        } catch {}
      }
    } else if (msg.role === "tool" && msg.tool_call_id) {
      const vaultId = extractVaultIdFromContent(typeof msg.content === "string" ? msg.content : "");
      if (vaultId && toolCallToFilePath.has(msg.tool_call_id)) {
        vaultToFilePath.set(vaultId, toolCallToFilePath.get(msg.tool_call_id));
      }
    }
  }

  /** A tool message is a retrieve result if its name matches OR its
   *  tool_call_id maps back to a retrieve tool_call (HP-1 + HP-2). */
  function isRetrieveResult(msg) {
    if (msg.role !== "tool") return false;
    if (isRetrieveToolName(msg.name)) return true;
    return msg.tool_call_id ? retrieveCallIds.has(msg.tool_call_id) : false;
  }

  // ── Build set of vault IDs that have been successfully patched ─────────
  // Used for post-patch invalidation within the current turn (after lastUserIdx).
  // If vault X was retrieved and then a patch tool ran on the same file,
  // the retrieval is stale even within the current hop chain.
  const patchedFiles = new Set();
  for (let i = lastUserIdx; i < payload.messages.length; i++) {
    const msg = payload.messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;

    for (const tc of msg.tool_calls) {
      const name = tc.function?.name || "";
      if (name === "contextforge_patch_ast" || name.includes("patch_ast")) {
        const filePath = extractFilePathFromPatchArgs(tc);
        if (filePath) patchedFiles.add(filePath.replace(/\\/g, "/").toLowerCase());
      }
    }
  }

  // ── Find the most recent retrieve result index ─────────────────────────
  // We never prune the most recent retrieve — the LLM may still be
  // actively using that content in the current hop.
  let mostRecentRetrieveIdx = -1;
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    if (isRetrieveResult(payload.messages[i])) {
      mostRecentRetrieveIdx = i;
      break;
    }
  }

  // ── Prune pass ────────────────────────────────────────────────────────
  let prunedCount = 0;
  let charsSaved = 0;
  const newMessages = [];

  for (let i = 0; i < payload.messages.length; i++) {
    const msg = payload.messages[i];

    // Only target tool messages from contextforge_retrieve (any wire form)
    if (!isRetrieveResult(msg)) {
      newMessages.push(msg);
      continue;
    }

    // Never prune the most recent retrieve
    if (i === mostRecentRetrieveIdx) {
      newMessages.push(msg);
      continue;
    }

    // Already pruned — skip
    if (msg._cf_pruned) {
      newMessages.push(msg);
      continue;
    }

    // Too short to be worth pruning
    if (typeof msg.content !== "string" || msg.content.length <= PRUNE_THRESHOLD_CHARS) {
      newMessages.push(msg);
      continue;
    }

    // ── Trigger 1: Historical (before last user message) ─────────────────
    const isHistorical = i < lastUserIdx;

    // ── Trigger 2: Post-patch invalidation (within current turn) ─────────
    // Check if the vault this retrieve returned has since been patched.
    // We use a simple heuristic: if any file was patched after lastUserIdx
    // and the retrieve content mentions that file path, it is stale.
    let isPatchInvalidated = false;
    if (!isHistorical && patchedFiles.size > 0) {
      const vaultId = retrieveToolCallToVaultId.get(msg.tool_call_id);
      const vaultFilePath = vaultId ? vaultToFilePath.get(vaultId) : null;
      if (vaultFilePath && patchedFiles.has(vaultFilePath)) {
        isPatchInvalidated = true;
      }
    }

    if (!isHistorical && !isPatchInvalidated) {
      // Not historical and not patch-invalidated — keep it
      newMessages.push(msg);
      continue;
    }

    // ── Prune this message ────────────────────────────────────────────────
    // A1 (headroom analysis): token-validation gate. The 500-char floor
    // above usually guarantees the ~200-char stub wins, but the stub can
    // still grow a short/dense retrieve result in tokens; char length was
    // the only comparison before.
    if (!passesTokenGate(msg.content, PRUNE_STUB)) {
      newMessages.push(msg);
      continue;
    }
    const originalLen = msg.content.length;
    charsSaved += originalLen - PRUNE_STUB.length;
    prunedCount++;

    newMessages.push({
      ...msg,
      content: PRUNE_STUB,
      _cf_pruned: true,
    });
  }

  if (prunedCount > 0) {
    console.log(
      `[HistoryPruner] ✂️  Pruned ${prunedCount} stale retrieve result(s) — ` +
        `saved ~${Math.floor(charsSaved / 4)} tokens`
    );
    payload._cf_historyPrunedTokens = Math.floor(charsSaved / 4);
  }

  return { ...payload, messages: newMessages };
}
