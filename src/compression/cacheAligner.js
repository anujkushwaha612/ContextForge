import crypto from "node:crypto";
import { statsEmitter } from "../proxy/statsEmitter.js";

// ─────────────────────────────────────────────
// Dynamic content patterns
// ─────────────────────────────────────────────
//
// Two sets of patterns:
//   DYNAMIC_PATTERNS      — Claude Code / Anthropic format
//   GEMINI_DYNAMIC_PATTERNS — Gemini CLI session_context format
//
// Both sets are checked by isDynamicLine(). Lines matching either
// set are classified as dynamic and excluded from the static prefix
// hash, preventing false "prefix changed" warnings on every turn.
// ─────────────────────────────────────────────

const DYNAMIC_PATTERNS = [
  // ── Claude Code / Anthropic ──
  /^.*Today(?:'s)? date is .+/i,
  /^.*Current date:? .+/i,
  /^.*The current (?:month|year|date) is .+/i,
  /^.*Session ID:? .+/i,
  /^.*session_id.+/i,
  /^.*device_id.+/i,
  /^.*account_uuid.+/i,
  /^.*Current branch:? .+/i,
  /^.*Status:\s*$/,
  /^.*Main branch.+/i,
  /^\s*[ MADRCU!?]{1,2}\s+\S+/,
  /^.*Recent commits:?\s*$/i,
  /^[a-f0-9]{7,40}\s+.+/,
  /^x-anthropic-billing-header:.+/i,
  /^.*Primary working directory:? .+/i,
  /^.*Additional working directories:?\s*$/i,
  /^\s*-\s*[A-Z]:\/.+/,
  /^\s*-\s*\/\S+/,
  /^.*You are powered by the model named .+/i,
  /^.*The exact model ID is .+/i,
  /^.*Assistant knowledge cutoff .+/i,
  /^.*The most recent Claude models .+/i,
  /^.*Git user:? .+/i,
  /^.*Platform:? .+/i,
  /^.*Shell:? .+/i,
  /^.*OS Version:? .+/i,

  // ── Gemini CLI session_context ──
  // These appear in the <session_context> block sent as the first
  // user message every turn. They change per-session or per-turn
  // and must not pollute the static prefix hash.
  /^My operating system is:.+/i,
  /^The project's temporary directory is:.+/i,
  /^- \*\*Workspace Directories:\*\*/i,
  /^Showing up to \d+ items.+/i,
  /^- \*\*Directory Structure:\*\*/i,
  /^<session_context>/i,
  /^<\/session_context>/i,
  /^This is the Gemini CLI\./i,
  /^We are setting up the context for our chat\./i,
];

const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// ─────────────────────────────────────────────
// Per-client state
// ─────────────────────────────────────────────
// Module-level singletons caused cross-client contamination:
// Anthropic streak state was overwritten by Gemini requests
// and vice versa, causing false "prefix changed" warnings
// and incorrect hit rate calculations.
//
// Each client type gets its own isolated state bucket.
// ─────────────────────────────────────────────

const _clientState = new Map();

function _getState(clientName) {
  if (!_clientState.has(clientName)) {
    _clientState.set(clientName, {
      lastStaticHash:   null,
      lastStaticTokens: 0,
      lastStaticPrefix: "", // FIX 2: Track old prefix for diagnostic logging
      consecutiveHits:  0,
      totalAlignments:  0,
      totalHits:        0,  // FIX 3: Track total hits separately for accurate hit rate
    });
  }
  return _clientState.get(clientName);
}

// ─────────────────────────────────────────────
// isDynamicLine
// ─────────────────────────────────────────────

function isDynamicLine(line) {
  return DYNAMIC_PATTERNS.some((p) => p.test(line));
}

// ─────────────────────────────────────────────
// splitSystemContent
// ─────────────────────────────────────────────

function splitSystemContent(content) {
  if (!content || typeof content !== "string") {
    return { staticContent: content || "", dynamicContent: "" };
  }

  const lines        = content.split("\n");
  const staticLines  = [];
  const dynamicLines = [];

  let inDynamicSection     = false;
  let dynamicSectionIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      if (inDynamicSection) {
        dynamicLines.push(line);
        let nextNonEmpty = i + 1;
        while (
          nextNonEmpty < lines.length &&
          lines[nextNonEmpty].trim().length === 0
        ) {
          nextNonEmpty++;
        }
        if (
          nextNonEmpty < lines.length &&
          !isDynamicLine(lines[nextNonEmpty])
        ) {
          const nextIndent = lines[nextNonEmpty].search(/\S/);
          if (nextIndent <= dynamicSectionIndent) {
            inDynamicSection = false;
          }
        }
      } else {
        staticLines.push(line);
      }
      continue;
    }

    if (isDynamicLine(line)) {
      dynamicLines.push(line);
      inDynamicSection     = true;
      dynamicSectionIndent = line.search(/\S/);
      continue;
    }

    if (inDynamicSection) {
      const currentIndent = line.search(/\S/);
      const isSubItem     = currentIndent > dynamicSectionIndent;
      const isListItem    =
        trimmed.startsWith("-") && currentIndent >= dynamicSectionIndent;

      if (isSubItem || isListItem) {
        dynamicLines.push(line);
        continue;
      }
      inDynamicSection = false;
    }

    staticLines.push(line);
  }

  return {
    staticContent:  staticLines.join("\n").trim(),
    dynamicContent: dynamicLines.join("\n").trim(),
  };
}

// ─────────────────────────────────────────────
// extractSystemReminders
// ─────────────────────────────────────────────

function extractSystemReminders(content) {
  if (!content || typeof content !== "string") {
    return { cleanContent: content || "", extractedReminders: "" };
  }

  const reminders    = [];
  const cleanContent = content
    .replace(SYSTEM_REMINDER_PATTERN, (match) => {
      reminders.push(match);
      return "";
    })
    .trim();

  return {
    cleanContent,
    extractedReminders: reminders.join("\n").trim(),
  };
}

// ─────────────────────────────────────────────
// alignCachePrefix — main export
// ─────────────────────────────────────────────

export function alignCachePrefix(payload, clientName = "anthropic") {
  if (
    !payload.messages       ||
    !Array.isArray(payload.messages) ||
    payload.messages.length === 0
  ) {
    return payload;
  }

  // ── Get per-client state ──
  const state = _getState(clientName);
  state.totalAlignments++;

  // ── Step 1: Separate system messages from conversation ──
  const systemMessages       = [];
  const conversationMessages = [];

  for (const msg of payload.messages) {
    if (msg.role === "system") {
      systemMessages.push(msg);
    } else {
      conversationMessages.push(msg);
    }
  }

  if (systemMessages.length === 0) return payload;

  // ── Step 2: Split each system message into static/dynamic ──
  const allStaticParts  = [];
  const allDynamicParts = [];

  for (const sysMsg of systemMessages) {
    const { staticContent, dynamicContent } = splitSystemContent(sysMsg.content);
    if (staticContent.length > 0)  allStaticParts.push(staticContent);
    if (dynamicContent.length > 0) allDynamicParts.push(dynamicContent);
  }

  // ── Step 3: Extract <system-reminder> from first user message ──
  // Reminders go into dynamic (they change per turn)
  let firstUserIdx = conversationMessages.findIndex((m) => m.role === "user");

  if (firstUserIdx >= 0) {
    const firstUser = conversationMessages[firstUserIdx];
    if (typeof firstUser.content === "string") {
      const { cleanContent, extractedReminders } =
        extractSystemReminders(firstUser.content);

      if (extractedReminders.length > 0) {
        allDynamicParts.push(extractedReminders);
      }

      if (cleanContent.length === 0) {
        // User message was ONLY a system reminder — remove it entirely
        conversationMessages.splice(firstUserIdx, 1);
      } else {
        conversationMessages[firstUserIdx] = {
          ...firstUser,
          content: cleanContent,
        };
      }
    }
  }

  // ── Step 4: Build prefix strings ──
  const staticPrefix   = allStaticParts.join("\n\n");
  const dynamicContext = allDynamicParts.join("\n\n");

  // ── Step 5: Stability check — uses per-client state ──
  const staticHash = crypto
    .createHash("sha256")
    .update(staticPrefix)
    .digest("hex")
    .slice(0, 16);

  if (state.lastStaticHash === staticHash) {
    state.consecutiveHits++;
    state.totalHits++; // FIX 3: Increment actual total hits
  } else {
    if (state.lastStaticHash !== null) {
      const delta = Math.round(staticPrefix.length / 4) - state.lastStaticTokens;
      console.log(
        `[CacheAligner] ⚠️ Static prefix changed ` +
        `(client: ${clientName}, new hash: ${staticHash}, ` +
        `previous streak: ${state.consecutiveHits} hits, ` +
        `token delta: ${delta > 0 ? "+" : ""}${delta})`,
      );
      
      // FIX 2: Diagnostic output showing exactly what changed
      // console.log(`[CacheAligner] 🔍 OLD PREFIX (first 300 chars):\n${state.lastStaticPrefix.slice(0, 300)}`);
      // console.log(`[CacheAligner] 🔍 NEW PREFIX (first 300 chars):\n${staticPrefix.slice(0, 300)}`);
    }
    state.consecutiveHits  = 1;
    state.lastStaticHash   = staticHash;
    state.lastStaticTokens = Math.round(staticPrefix.length / 4);
    state.lastStaticPrefix = staticPrefix; // FIX 2: Store new prefix for future comparisons
  }

  // ── Step 6: Assemble aligned messages ──
  //
  // CRITICAL DESIGN RULE:
  // Dynamic context MUST go into the system message — NOT as a user/assistant
  // pair injected before conversationMessages.
  //
  // Why: conversationMessages contains real tool call sequences:
  //   assistant { tool_calls: [A, B, C] }
  //   tool(A) → tool(B) → tool(C)
  //
  // Inserting a fake user message before these breaks the sequence.
  // The MsgValidator sees tool messages not preceded by assistant → drops them.
  // Claude receives empty tool results → retries → orphan loop.
  //
  // Solution: merge static + dynamic into ONE system message.
  // The static part is byte-identical across turns → cache hits.
  // The dynamic part follows immediately after → no sequence disruption.

  const systemContent = dynamicContext.length > 0
    ? `${staticPrefix}\n\n[Session Context — updated each turn]\n${dynamicContext}`
    : staticPrefix;

  const alignedMessages = [
    { role: "system", content: systemContent },
    ...conversationMessages,   // ← conversation history untouched, sequences intact
  ];

  // ── Step 7: Stats — uses per-client state ──
  const staticTokens  = Math.round(staticPrefix.length / 4);
  const dynamicTokens = Math.round(dynamicContext.length / 4);
  
  // FIX 3: Corrected hit rate formula
  const hitRate = state.totalAlignments > 0 
    ? ((state.totalHits / state.totalAlignments) * 100).toFixed(1) 
    : "0.0";

  console.log(
    `[CacheAligner] 📌 [${clientName}] Prefix: ${staticTokens} tokens (hash: ${staticHash}) | ` +
    `Dynamic: ${dynamicTokens} tokens | ` +
    `Streak: ${state.consecutiveHits} | ` +
    `Hit rate: ${hitRate}%`,
  );

  // ── Dashboard hook ──
  statsEmitter.recordCacheAlignStreak(
    state.consecutiveHits,
    parseFloat(hitRate),
  );

  return { ...payload, messages: alignedMessages };
}

// ─────────────────────────────────────────────
// Stats exports
// ─────────────────────────────────────────────

export function getCacheAlignerStats(clientName = null) {
  if (clientName) {
    return { ...(_getState(clientName)) };
  }
  // Return all clients
  const result = {};
  for (const [name, state] of _clientState.entries()) {
    result[name] = { ...state };
  }
  return result;
}

export function resetCacheAlignerStats(clientName = null) {
  if (clientName) {
    _clientState.delete(clientName);
  } else {
    _clientState.clear();
  }
}