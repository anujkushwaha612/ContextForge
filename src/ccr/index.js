/**
 * CCR module entry point.
 * Wires together tool injection, context tracking, and session registry.
 */

export { CCR_TOOL_NAME, CCRToolInjector, scanForMarkers, parseCCRToolCall }
  from "./toolInjection.js";
export { ContextTracker }
  from "./contextTracker.js";
export { SessionRegistry, sessionRegistry }
  from "./sessionRegistry.js";

import { CCRToolInjector, scanForMarkers } from "./toolInjection.js";
import { ContextTracker } from "./contextTracker.js";
import { sessionRegistry, SessionRegistry } from "./sessionRegistry.js";

// Process-wide context tracker
// Scoped per workspace via workspaceKey parameter
export const contextTracker = new ContextTracker();

/**
 * Main CCR pipeline function.
 * Called from server.js before forwarding request to LLM.
 *
 * @param {object} payload - The translated OpenAI payload
 * @returns {object} - Payload with CCR tool injected if needed
 */
export function applyCCRPipeline(payload) {
  // Derive session and workspace identity
  const sessionId    = SessionRegistry.deriveSessionId(payload);
  const workspaceKey = SessionRegistry.deriveWorkspaceKey(payload);
  const session      = sessionRegistry.getOrCreate(sessionId, workspaceKey);

  const turnNumber = session.incrementTurn();

  // Scan for compression markers in this request's messages
  const injector = new CCRToolInjector({ provider: "openai" });
  const { messages, tools, toolWasInjected } = injector.processRequest(
    payload.messages,
    payload.tools,
    { sessionHasDoneCCR: session.hasDoneCCR }  // PR-B7 sticky-on
  );

  if (toolWasInjected) {
    console.log(
      `[CCR] 💉 contextforge_retrieve injected into tools[] ` +
      `(session=${sessionId.slice(0, 8)} workspace=${workspaceKey.slice(0, 8)})`
    );
  } else if (session.hasDoneCCR) {
    console.log(
      `[CCR] 🔒 contextforge_retrieve kept (sticky-on, session=${sessionId.slice(0, 8)})`
    );
  }

  // Track any new vault IDs detected in this turn
  const detectedVaultIds = injector.detectedVaultIds;
  for (const vaultId of detectedVaultIds) {
    contextTracker.trackCompression({
      vaultId,
      turnNumber,
      workspaceKey,
      queryContext: extractLastUserQuery(messages),
      sampleContent: "", // populated by compressors when they call trackCompression directly
    });
  }

  // Proactive expansion: check if current query needs context from past compressions
  const currentQuery = extractLastUserQuery(messages);
  if (currentQuery) {
    const recommendations = contextTracker.analyzeQuery(currentQuery, {
      currentTurn: turnNumber,
      workspaceKey,
    });

    if (recommendations.length > 0) {
      console.log(
        `[CCR] 🔮 Proactive expansion: ${recommendations.length} vault(s) relevant to query`
      );
      // Recommendations are logged but acted on by the Ghost Interceptor
      // when the LLM actually calls contextforge_retrieve
      payload._ccrRecommendations = recommendations;
    }
  }

  return {
    ...payload,
    messages,
    tools: tools || payload.tools,
    _sessionId:    sessionId,
    _workspaceKey: workspaceKey,
    _turnNumber:   turnNumber,
  };
}

/**
 * Called when the Ghost Interceptor successfully handles a vault retrieval.
 * Updates session state for sticky-on tracking.
 */
export function recordCCRSuccess(payload, vaultId) {
  if (!payload._sessionId) return;

  const session = sessionRegistry.getOrCreate(
    payload._sessionId,
    payload._workspaceKey || ""
  );
  session.markCCRDone(vaultId);

  console.log(
    `[CCR] ✅ CCR success recorded — tool now sticky for session ` +
    payload._sessionId.slice(0, 8)
  );
}

function extractLastUserQuery(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      return typeof content === "string"
        ? content.slice(0, 200)
        : JSON.stringify(content).slice(0, 200);
    }
  }
  return "";
}