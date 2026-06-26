/**
 * messageOrigin.js
 *
 * Determines whether the current request represents a genuine
 * repository work task or an agent status update/acknowledgment.
 *
 * Uses conversation structure, not token count.
 * Token count is a symptom — message origin is the cause.
 *
 * Origin types:
 *   HUMAN_TASK     → user sent a new coding instruction
 *   AGENT_STATUS   → assistant is reporting completion/status
 *   TOOL_FOLLOWUP  → LLM is processing tool results (mid tool-call loop)
 *   CONTINUATION   → mid-session follow-up to prior work
 *
 * Key structural facts learned from real Claude Code payloads:
 *   - Tool results arrive as role:"user" with content type:"tool_result"
 *     (there is no role:"tool" in the Anthropic wire format)
 *   - Assistant messages mid-task contain type:"tool_use" blocks
 *   - The first user message often has a <system-reminder> harness injection
 *     prepended — the real task is in a later text block
 */

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract all content blocks from a message, normalising string → [{type:"text"}].
 * @param {string|Array|null} content
 * @returns {Array<{type:string, [key:string]:any}>}
 */
function toBlocks(content) {
  if (!content) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

/**
 * Extract plain text from a message content field.
 * Strips <system-reminder> harness injections before returning.
 * Skips tool_result / tool_use blocks — we only want human-authored text.
 */
function extractText(content) {
  return toBlocks(content)
    .filter((b) => b.type === "text")
    .map((b) => (b.text || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Returns true if this user message is purely a tool result response.
 * In the Anthropic wire format, tool results come back as role:"user"
 * messages whose content blocks are all type:"tool_result".
 */
function isToolResultMessage(msg) {
  if (msg.role !== "user") return false;
  const blocks = toBlocks(msg.content);
  if (blocks.length === 0) return false;
  return blocks.every((b) => b.type === "tool_result");
}

/**
 * Returns true if this assistant message issued at least one tool call.
 * Tool calls appear as type:"tool_use" blocks in the content array.
 */
function assistantCalledTools(msg) {
  if (msg.role !== "assistant") return false;
  return toBlocks(msg.content).some((b) => b.type === "tool_use");
}

// ─────────────────────────────────────────────────────────────────────────────
// Status phrase detection
// These are phrases Claude uses when reporting completion.
// They appear in the LAST assistant message before the current user turn.
// Only match when the assistant message has NO tool_use blocks —
// a message with tool_use is mid-task reasoning, not a status report.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_STATUS_PATTERNS = [
  /^done\b/i,
  /^(the )?patch (was |has been )?applied/i,
  /^(the )?log (has been |was )?removed/i,
  /^(the |i've |i have )?(re-?indexed|verified|confirmed)/i,
  /^(the )?graph has been re-?indexed/i,
  /^(updated|modified|changed|renamed|refactored)\b/i,
  /^(added|inserted|removed|deleted)\b/i,
  /\bsuccessfully (applied|patched|updated|removed|added)\b/i,
  /\bthe (file|function|method|class) (now|has been)\b/i,
  /\bno (further|other) changes (needed|required)\b/i,
];

/**
 * Check if a message content string looks like an agent status update.
 * Only checks the first 200 chars of the extracted text.
 * Requires the caller to confirm there are no tool_use blocks.
 */
function isAgentStatusMessage(content) {
  if (!content || typeof content !== "string") return false;
  const trimmed = content.trim().slice(0, 200);
  return AGENT_STATUS_PATTERNS.some((p) => p.test(trimmed));
}

// ─────────────────────────────────────────────────────────────────────────────
// Core detector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse the conversation structure to determine message origin.
 *
 * Decision logic (evaluated in order):
 *
 *   1. TOOL_FOLLOWUP  — the most recent user message is a tool result block.
 *      The LLM is mid tool-call loop; this is not a human turn at all.
 *
 *   2. CONTINUATION   — any of the last 4 messages contain a tool_use block
 *      (assistant called a tool recently) or was a tool result user message.
 *      We are mid-session; keep tools active.
 *
 *   3. AGENT_STATUS   — the last assistant message is a pure status report
 *      (no tool_use blocks) AND the current user text is short (< 150 chars).
 *      This is an acknowledgment loop, not a new task.
 *
 *   4. HUMAN_TASK     — everything else: treat as a fresh coding instruction.
 *
 * @param {object[]} messages - Full messages array from the request body
 * @returns {{ origin: string, reason: string }}
 */
export function detectMessageOrigin(messages) {
  if (!messages || messages.length === 0) {
    return { origin: "HUMAN_TASK", reason: "no_history" };
  }

  // ── The current turn is the last message ────────────────────────────────
  const currentMsg = messages[messages.length - 1];

  // ── Rule 1: Tool result user message — mid tool-call loop ───────────────
  // In Anthropic's wire format, the LLM's tool call produces a user-role
  // message with type:"tool_result" blocks. This is NOT a human task.
  if (isToolResultMessage(currentMsg)) {
    return {
      origin: "TOOL_FOLLOWUP",
      reason: "current_message_is_tool_result",
    };
  }

  // ── Gather context from recent history ──────────────────────────────────
  // Look back at the last 4 messages (excluding the current turn).
  const history = messages.slice(0, -1);
  const recentHistory = history.slice(-4);

  // Find the last assistant message and last human-authored user message.
  let lastAssistantMsg = null;
  let lastHumanUserMsg = null;

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!lastAssistantMsg && m.role === "assistant") {
      lastAssistantMsg = m;
    }
    if (!lastHumanUserMsg && m.role === "user" && !isToolResultMessage(m)) {
      lastHumanUserMsg = m;
    }
    if (lastAssistantMsg && lastHumanUserMsg) break;
  }

  // ── Rule 2: Recent tool activity — we are mid-session ───────────────────
  // If any recent message was a tool result (user role, tool_result blocks)
  // OR the assistant recently called a tool, this is a continuation.
  const hasRecentTools = recentHistory.some(
    (m) => isToolResultMessage(m) || assistantCalledTools(m)
  );
  if (hasRecentTools) {
    return {
      origin: "CONTINUATION",
      reason: "recent_tool_activity",
    };
  }

  // ── Rule 3: Agent status exchange ───────────────────────────────────────
  // If the previous assistant turn was a pure status report (no tool calls)
  // AND the current user message is short → acknowledgment loop.
  if (lastAssistantMsg && !assistantCalledTools(lastAssistantMsg)) {
    const lastAssistantText = extractText(lastAssistantMsg.content);
    const currentUserText   = extractText(currentMsg.content);

    if (
      isAgentStatusMessage(lastAssistantText) &&
      currentUserText.trim().length < 150
    ) {
      return {
        origin: "AGENT_STATUS",
        reason: `last_assistant_was_status: "${lastAssistantText.slice(0, 60)}"`,
      };
    }
  }

  // ── Rule 4: Fresh conversation ───────────────────────────────────────────
  if (messages.length <= 2) {
    return { origin: "HUMAN_TASK", reason: "fresh_conversation" };
  }

  // ── Rule 5: Default — treat as human task ────────────────────────────────
  return { origin: "HUMAN_TASK", reason: "default" };
}

/**
 * Returns true if this origin requires repository capabilities.
 * AGENT_STATUS and TOOL_FOLLOWUP never do — the planner handles everything else.
 */
export function requiresRepositoryWork(origin) {
  return origin !== "AGENT_STATUS" && origin !== "TOOL_FOLLOWUP";
}