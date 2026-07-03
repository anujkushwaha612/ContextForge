/**
 * CCR module entry point.
 * Wires together tool injection, context tracking, and session registry.
 */

export {
  CCR_TOOL_NAME,
  CCRToolInjector,
  scanForMarkers,
  parseCCRToolCall,
} from "./toolInjection.js";
export { SessionRegistry, sessionRegistry } from "./sessionRegistry.js";

import { CCRToolInjector, scanForMarkers } from "./toolInjection.js";
import { sessionRegistry, SessionRegistry } from "./sessionRegistry.js";
import { countTokens } from "../compression/compressionHelper.js";

// ContextTracker kept for export compatibility but no longer used in pipeline.
// Proactive expansion was disabled (Phase 1) and context tracking added
// overhead without measurable benefit. Removed from hot path.
export { ContextTracker } from "./contextTracker.js";
export const contextTracker = null;

const CCR_MIN_TOKENS = 18000;

// ─────────────────────────────────────────────
// Per-session marker scan cache
// Key: sessionId → Set of already-scanned message IDs
// ─────────────────────────────────────────────
const _scannedMessageIds = new Map();

// CCR-6 FIX: this cache was unbounded — one Set per session, never
// cleaned. sessionRegistry TTL-evicts ITS map, but this one grew for the
// life of the daemon (long-running proxy = slow leak; also stale sets
// survived registry cleanup and silently broke discovery recording).
const MAX_SCAN_SESSIONS = 500;
function touchScanCache(sessionId) {
  if (_scannedMessageIds.has(sessionId)) {
    // refresh LRU position
    const v = _scannedMessageIds.get(sessionId);
    _scannedMessageIds.delete(sessionId);
    _scannedMessageIds.set(sessionId, v);
    return v;
  }
  const v = new Set();
  _scannedMessageIds.set(sessionId, v);
  if (_scannedMessageIds.size > MAX_SCAN_SESSIONS) {
    // evict oldest (Map preserves insertion order)
    _scannedMessageIds.delete(_scannedMessageIds.keys().next().value);
  }
  return v;
}

function getFastContentPreview(content, maxLength) {
  if (typeof content === "string") return content.slice(0, maxLength);
  if (Array.isArray(content)) {
    let preview = "";
    for (const block of content) {
      if (typeof block.text === "string") {
        preview += block.text.slice(0, maxLength - preview.length);
      } else if (block.type) {
        preview += `[${block.type}]`;
      }
      if (preview.length >= maxLength) break;
    }
    return preview.slice(0, maxLength);
  }
  return "[Object]";
}

function scanNewMessagesOnly(sessionId, messages) {
  const seen = touchScanCache(sessionId); // CCR-6
  const newMsgs = [];

  for (const msg of messages) {
    let msgId;
    if (msg.tool_call_id) {
      msgId = "tool:" + msg.tool_call_id;
    } else if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      msgId = "asst:" + (msg.tool_calls[0]?.id ?? msg.content?.slice(0, 32) ?? "");
    } else {
      msgId = msg.role + ":" + getFastContentPreview(msg.content, 64);
    }

    if (!seen.has(msgId)) {
      seen.add(msgId);
      newMsgs.push(msg);
    }
  }

  return newMsgs.length > 0 ? scanForMarkers(newMsgs) : [];
}

/**
 * Main CCR pipeline function.
 *
 * Injection rule (fixed):
 *   Inject contextforge_retrieve if and only if the current payload
 *   contains [CF_VAULT:] stubs that have NOT yet been retrieved.
 *
 *   Once a vault is retrieved (LLM called contextforge_retrieve for it),
 *   that vault ID is added to session.retrievedVaultIds. On the next turn
 *   we scan the payload for vault stubs and subtract already-retrieved IDs.
 *   If the remaining set is empty → no injection.
 *
 * This replaces the broken sticky-on logic where:
 *   - session.hasDoneCCR = true permanently after first retrieval
 *   - session.knownVaultIds accumulated forever
 *   - Both conditions caused inject=true on every subsequent turn
 */
export function applyCCRPipeline(payload, tokenCount = null) {
  const tokens = tokenCount ?? countTokens(payload);

  if (tokens < CCR_MIN_TOKENS) {
    return payload;
  }

  const sessionId = SessionRegistry.deriveSessionId(payload);
  const workspaceKey = SessionRegistry.deriveWorkspaceKey(payload);
  const session = sessionRegistry.getOrCreate(sessionId, workspaceKey);
  session.incrementTurn();

  // ── Step 1: Find vault stubs in NEW messages only ─────────────────────
  const newVaultIds = scanNewMessagesOnly(sessionId, payload.messages);

  for (const vaultId of newVaultIds) {
    session.addDiscoveredVaultId(vaultId);
    // Track which turn each vault was first discovered
    session.vaultDiscoveredAtTurn(vaultId);
  }

  // ── Step 2: Compute UNRETRIEVED vaults in current payload ─────────────
  const allCurrentVaultIds = scanForMarkers(payload.messages);
  const currentTurn = session.turnNumber;

  // CCR-5 FIX: record discovery turn for EVERY vault currently visible,
  // not only those found by the incremental scan. The old code recorded
  // discovery only via newVaultIds — if the scan cache had already seen
  // the message (cache outliving a TTL-evicted session, dedup'd message
  // ids colliding on identical 64-char previews), the discovery turn was
  // never set and the staleness filter fell back to `?? currentTurn` →
  // turnsUnretrieved was ALWAYS 0 → the vault NEVER went stale → the
  // retrieve schema was re-injected forever. Reproduced: 5 passes, still
  // injecting. vaultDiscoveredAtTurn is idempotent (first-write-wins).
  for (const id of allCurrentVaultIds) {
    session.vaultDiscoveredAtTurn(id);
  }

  // ── Step 3: Filter to vaults that are both unretrieved AND recent ─────
  // If a vault has been unretrieved for more than MAX_UNRETRIEVED_TURNS,
  // the LLM is clearly not going to retrieve it — it is using native tools
  // or has moved on. Stop injecting the retrieve schema for stale vaults.
  const MAX_UNRETRIEVED_TURNS = 3;

  const unretrievedVaultIds = allCurrentVaultIds.filter((id) => {
    if (session.retrievedVaultIds.has(id)) return false; // already retrieved

    // Check staleness — how many turns since this vault was first seen?
    const discoveredAt = session.vaultDiscoveredTurn?.get(id) ?? currentTurn;
    const turnsUnretrieved = currentTurn - discoveredAt;

    if (turnsUnretrieved > MAX_UNRETRIEVED_TURNS) {
      // Vault has been sitting unretrieved for too long.
      // LLM is not going to retrieve it — mark as stale, stop injecting.
      return false;
    }

    return true;
  });

  const shouldInject = unretrievedVaultIds.length > 0;

  if (!shouldInject) {
    return payload;
  }

  const injector = new CCRToolInjector({ provider: "openai" });
  injector._detectedVaultIds = unretrievedVaultIds;

  const { messages, tools, toolWasInjected } = injector.processRequest(
    payload.messages,
    payload.tools,
    { sessionHasDoneCCR: false }
  );

  if (toolWasInjected) {
    console.log(
      `[CCR] 💉 contextforge_retrieve injected — ` +
        `${unretrievedVaultIds.length} unretrieved vault(s) in context ` +
        `(session=${sessionId.slice(0, 8)})`
    );
  }

  return {
    ...payload,
    messages,
    tools: tools || payload.tools,
    _sessionId: sessionId,
    _workspaceKey: workspaceKey,
  };
}

/**
 * Called by upstreamRequest.js when the LLM successfully retrieves a vault.
 *
 * FIX: Now marks the specific vault as RETRIEVED (not just "CCR done").
 * This prevents the tool from being re-injected on future turns for
 * vaults whose content is already in the LLM context window.
 */
export function recordCCRSuccess(payload, vaultId) {
  if (!payload._sessionId || !vaultId) return;

  const session = sessionRegistry.getOrCreate(payload._sessionId, payload._workspaceKey || "");

  session.markVaultRetrieved(vaultId);

  console.log(
    `[CCR] ✅ Vault ${vaultId} marked as retrieved — ` +
      `will not re-inject for this vault ` +
      `(session=${payload._sessionId.slice(0, 8)})`
  );
}
