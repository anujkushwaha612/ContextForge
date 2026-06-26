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
export { ContextTracker } from "./contextTracker.js";
export { SessionRegistry, sessionRegistry } from "./sessionRegistry.js";

import { CCRToolInjector, scanForMarkers } from "./toolInjection.js";
import { ContextTracker } from "./contextTracker.js";
import { sessionRegistry, SessionRegistry } from "./sessionRegistry.js";
import { countTokens } from "../compression/compressionHelper.js";

export const contextTracker = new ContextTracker();

const CCR_MIN_TOKENS = 18000;

// ─────────────────────────────────────────────
// Per-session marker scan cache
// Key: sessionId → Set of already-scanned message indices
// Prevents re-scanning history messages on every turn
// ─────────────────────────────────────────────
const _scannedMessageIds = new Map(); // sessionId → Set<tool_call_id>

/**
 * Scan only NEW messages — messages not seen in a prior turn.
 * Uses tool_call_id as a stable identifier for tool messages.
 * For other message types uses a content hash prefix.
 *
 * @param {string} sessionId
 * @param {object[]} messages
 * @returns {string[]} vault IDs found in new messages only
 */
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
  if (!_scannedMessageIds.has(sessionId)) {
    _scannedMessageIds.set(sessionId, new Set());
  }

  const seen = _scannedMessageIds.get(sessionId);
  const newMsgs = [];

  for (const msg of messages) {
    // Build a stable identity for this message
    let msgId;
    if (msg.tool_call_id) {
      msgId = "tool:" + msg.tool_call_id;
    } else if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      msgId =
        "asst:" + (msg.tool_calls[0]?.id ?? msg.content?.slice(0, 32) ?? "");
    } else {
      // For user/system messages, use role + fast preview
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
 * Called from server.js before forwarding request to LLM.
 *
 * Fix 1: Accept pre-counted token count from pipeline to avoid
 *        double-counting (pipeline already counted before this stage).
 * Fix 2: Only scan NEW messages for vault markers (O(1) per turn
 *        instead of O(history)).
 * Fix 3 (Phase 1): Proactive expansion disabled — it added 200-500 tokens
 *        speculatively without meaningful precision. The retrieve tool
 *        is injected on-demand; LLM pulls context when it needs it.
 *
 * @param {object} payload        - The translated OpenAI payload
 * @param {number} [tokenCount]   - Pre-counted tokens from pipeline (optional)
 * @returns {object}
 */
export function applyCCRPipeline(payload, tokenCount = null) {
  // Fix 1: Use pre-counted value if provided, count only if not
  const tokens = tokenCount ?? countTokens(payload);

  if (tokens < CCR_MIN_TOKENS) {
    // console.log(`[CCR] ⏭️  Skipped — ${tokens} tokens below threshold`);
    return payload;
  }

  // Derive session and workspace identity
  const sessionId = SessionRegistry.deriveSessionId(payload);
  const workspaceKey = SessionRegistry.deriveWorkspaceKey(payload);
  const session = sessionRegistry.getOrCreate(sessionId, workspaceKey);
  const turnNumber = session.incrementTurn();

  // Fix 2: Only scan messages we haven't seen before
  const newVaultIds = scanNewMessagesOnly(sessionId, payload.messages);

  // Inject tool if needed
  const injector = new CCRToolInjector({ provider: "openai" });

  // Manually set detected vault IDs from our incremental scan
  injector._detectedVaultIds = [
    ...session.knownVaultIds, // vaults from prior turns (sticky)
    ...newVaultIds,           // vaults found in new messages
  ];

  const { messages, tools, toolWasInjected } = injector.processRequest(
    payload.messages,
    payload.tools,
    { sessionHasDoneCCR: session.hasDoneCCR },
  );

  if (toolWasInjected) {
    console.log(
      `[CCR] 💉 contextforge_retrieve injected ` +
        `(session=${sessionId.slice(0, 8)} workspace=${workspaceKey.slice(0, 8)})`,
    );
  } else if (session.hasDoneCCR) {
    console.log(
      `[CCR] 🔒 contextforge_retrieve kept (sticky-on, session=${sessionId.slice(0, 8)})`,
    );
  }

  // Track new vault IDs in context tracker (kept for future query-matching
  // improvements — only the proactive push is disabled, not the tracking itself)
  for (const vaultId of newVaultIds) {
    // Register in session for sticky tracking
    session.addKnownVaultId?.(vaultId);

    contextTracker.trackCompression({
      vaultId,
      turnNumber,
      workspaceKey,
      queryContext: extractLastUserQuery(messages),
      sampleContent: "",
    });
  }

  // ── Proactive expansion — DISABLED (Phase 1 dead-weight removal) ──
  //
  // Audit finding: Fires speculatively and adds 200-500 tokens of vault
  // context the LLM never uses. The retrieve tool injected above already
  // gives the LLM on-demand access. Proactive push causes net-negative
  // compression on sessions where the predicted vault isn't relevant.
  //
  // To re-enable: gate on confidence > 0.85 and verify precision in logs.
  //
  // const currentQuery = extractLastUserQuery(messages);
  // if (currentQuery) {
  //   const recommendations = contextTracker.analyzeQuery(currentQuery, {
  //     currentTurn: turnNumber,
  //     workspaceKey,
  //   });
  //   if (recommendations.length > 0) {
  //     console.log(
  //       `[CCR] 🔮 Proactive expansion: ${recommendations.length} vault(s) relevant to query`,
  //     );
  //     payload._ccrRecommendations = recommendations;
  //   }
  // }

  return {
    ...payload,
    messages,
    tools: tools || payload.tools,
    _sessionId: sessionId,
    _workspaceKey: workspaceKey,
    _turnNumber: turnNumber,
  };
}

export function recordCCRSuccess(payload, vaultId) {
  if (!payload._sessionId) return;

  const session = sessionRegistry.getOrCreate(
    payload._sessionId,
    payload._workspaceKey || "",
  );
  session.markCCRDone(vaultId);

  console.log(
    `[CCR] ✅ CCR success recorded — tool now sticky for session ` +
      payload._sessionId.slice(0, 8),
  );
}

function extractLastUserQuery(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return getFastContentPreview(messages[i].content, 200);
    }
  }
  return "";
}