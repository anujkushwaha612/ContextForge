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

// CA-2/CA-3 FIX: the old single DYNAMIC_PATTERNS list contained
// context-free patterns for git-status codes (/^\s*[ MADRCU!?]{1,2}\s+\S+/)
// and commit hashes (/^[a-f0-9]{7,40}\s+.+/). Those match ORDINARY PROSE:
//   "A user may ask you to explain code."   ← 'A ' = git status code
//   "! Important: never commit secrets."    ← '! ' = git status code
//   "deadbeef is a classic placeholder."    ← 7+ hex chars
// Reproduced: 6 of 7 instruction lines were silently MOVED out of the
// static prefix into the tail "Session Context" block — reordering the
// system prompt (behavior risk) AND destabilizing the prefix hash
// whenever such lines sat near real git output (defeating the very
// cache alignment this module exists for).
//
// New structure:
//   STANDALONE_DYNAMIC — specific, self-identifying dynamic lines.
//     Safe to match anywhere (dates, session ids, branch, platform…).
//   SECTION_HEADERS    — lines that OPEN a dynamic block ("Status:",
//     "Recent commits:", "Additional working directories:").
//   SECTION_CONTENT    — ambiguous shapes (git codes, hashes, dash-paths)
//     that are dynamic ONLY while inside an open dynamic section.
const STANDALONE_DYNAMIC = [
  // ── Claude Code / Anthropic ──
  /^.*Today(?:'s)? date is .+/i,
  /^.*Current date:? .+/i,
  /^.*The current (?:month|year|date) is .+/i,
  /^.*Session ID:? .+/i,
  /^.*session_id.+/i,
  /^.*device_id.+/i,
  /^.*account_uuid.+/i,
  /^.*Current branch:? .+/i,
  /^.*Main branch.+/i,
  /^x-anthropic-billing-header:.+/i,
  /^.*Primary working directory:? .+/i,
  /^.*You are powered by the model named .+/i,
  /^.*The exact model ID is .+/i,
  /^.*Assistant knowledge cutoff .+/i,
  /^.*The most recent Claude models .+/i,
  /^.*Git user:? .+/i,
  /^.*Platform:? .+/i,
  /^.*Shell:? .+/i,
  /^.*OS Version:? .+/i,

  // ── Gemini CLI session_context ──
  /^My operating system is:.+/i,
  /^The project's temporary directory is:.+/i,
  /^Showing up to \d+ items.+/i,
  /^<session_context>/i,
  /^<\/session_context>/i,
  /^This is the Gemini CLI\./i,
  /^We are setting up the context for our chat\./i,
];

const SECTION_HEADERS = [
  /^.*Status:\s*$/,
  /^.*Recent commits:?\s*$/i,
  /^.*Additional working directories:?\s*$/i,
  /^- \*\*Workspace Directories:\*\*/i,
  /^- \*\*Directory Structure:\*\*/i,
];

const SECTION_CONTENT = [
  /^\s*[ MADRCU!?]{1,2}\s+\S+/, // git porcelain status codes
  /^[a-f0-9]{7,40}\s+.+/, // commit hash + subject
  /^\s*-\s*[A-Z]:\/.+/, // dash-listed Windows paths
  /^\s*-\s*\/\S+/, // dash-listed unix paths
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
      lastStaticHash: null,
      lastStaticTokens: 0,
      consecutiveHits: 0,
      totalAlignments: 0,
      totalHits: 0, // FIX 3: Track total hits separately for accurate hit rate
    });
  }
  return _clientState.get(clientName);
}

// ─────────────────────────────────────────────
// isDynamicLine
// ─────────────────────────────────────────────

function isStandaloneDynamic(line) {
  return STANDALONE_DYNAMIC.some((p) => p.test(line));
}
function isSectionHeader(line) {
  return SECTION_HEADERS.some((p) => p.test(line));
}
function isSectionContent(line) {
  return SECTION_CONTENT.some((p) => p.test(line));
}
// Back-compat helper used by the blank-line lookahead: a line is "dynamic
// in any role" if it is standalone-dynamic or a section header.
function isDynamicLine(line) {
  return isStandaloneDynamic(line) || isSectionHeader(line);
}

// ─────────────────────────────────────────────
// splitSystemContent
// ─────────────────────────────────────────────

function splitSystemContent(content) {
  if (!content || typeof content !== "string") {
    return { staticContent: content || "", dynamicContent: "" };
  }

  const lines = content.split("\n");
  const staticLines = [];
  const dynamicLines = [];

  let inDynamicSection = false;
  let dynamicSectionIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      if (inDynamicSection) {
        dynamicLines.push(line);
        let nextNonEmpty = i + 1;
        while (nextNonEmpty < lines.length && lines[nextNonEmpty].trim().length === 0) {
          nextNonEmpty++;
        }
        if (nextNonEmpty < lines.length && !isDynamicLine(lines[nextNonEmpty])) {
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

    // CA-2/CA-3: section headers OPEN a dynamic block; standalone lines
    // move individually WITHOUT opening one (a date sentence in prose
    // must not swallow the lines after it).
    if (isSectionHeader(line)) {
      dynamicLines.push(line);
      inDynamicSection = true;
      dynamicSectionIndent = line.search(/\S/);
      continue;
    }

    if (isStandaloneDynamic(line)) {
      dynamicLines.push(line);
      continue;
    }

    if (inDynamicSection) {
      const currentIndent = line.search(/\S/);
      const isSubItem = currentIndent > dynamicSectionIndent;
      const isListItem = trimmed.startsWith("-") && currentIndent >= dynamicSectionIndent;

      // Ambiguous shapes (git codes / hashes / dash-paths) count as
      // section content ONLY here — inside an open section.
      if (isSubItem || isListItem || isSectionContent(line)) {
        dynamicLines.push(line);
        continue;
      }
      inDynamicSection = false;
    }

    staticLines.push(line);
  }

  return {
    staticContent: staticLines.join("\n").trim(),
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

  const reminders = [];
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
  if (!payload.messages || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return payload;
  }

  // ── Get per-client state ──
  const state = _getState(clientName);
  state.totalAlignments++;

  // ── Step 1: Separate system messages from conversation ──
  const systemMessages = [];
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
  const allStaticParts = [];
  const allDynamicParts = [];

  for (const sysMsg of systemMessages) {
    const { staticContent, dynamicContent } = splitSystemContent(sysMsg.content);
    if (staticContent.length > 0) allStaticParts.push(staticContent);
    if (dynamicContent.length > 0) allDynamicParts.push(dynamicContent);
  }

  // ── Step 3: Extract <system-reminder> from first user message ──
  // Reminders go into dynamic (they change per turn)
  let firstUserIdx = conversationMessages.findIndex((m) => m.role === "user");

  if (firstUserIdx >= 0) {
    const firstUser = conversationMessages[firstUserIdx];

    // CA-4d FIX: post-adapter Anthropic payloads carry the first user
    // message as a BLOCK ARRAY. The old string-only path silently skipped
    // them — reminders stayed inline, mutating per turn. Extract from
    // text blocks; drop blocks (or the whole message) left empty.
    if (Array.isArray(firstUser.content)) {
      const newBlocks = [];
      for (const block of firstUser.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          const { cleanContent, extractedReminders } = extractSystemReminders(block.text);
          if (extractedReminders.length > 0) allDynamicParts.push(extractedReminders);
          if (cleanContent.length > 0) newBlocks.push({ ...block, text: cleanContent });
        } else {
          newBlocks.push(block);
        }
      }
      if (newBlocks.length === 0) {
        conversationMessages.splice(firstUserIdx, 1);
      } else {
        conversationMessages[firstUserIdx] = { ...firstUser, content: newBlocks };
      }
    } else if (typeof firstUser.content === "string") {
      const { cleanContent, extractedReminders } = extractSystemReminders(firstUser.content);

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
  const staticPrefix = allStaticParts.join("\n\n");
  const dynamicContext = allDynamicParts.join("\n\n");

  // ── Step 5: Stability check — uses per-client state ──
  const staticHash = crypto.createHash("sha256").update(staticPrefix).digest("hex").slice(0, 16);

  if (state.lastStaticHash === staticHash) {
    state.consecutiveHits++;
    state.totalHits++; // FIX 3: Increment actual total hits
  } else {
    if (state.lastStaticHash !== null) {
      const delta = Math.round(staticPrefix.length / 4) - state.lastStaticTokens;
      //       console.log(
      //         `[CacheAligner] ⚠️ Static prefix changed ` +
      //         `(client: ${clientName}, new hash: ${staticHash}, ` +
      //         `previous streak: ${state.consecutiveHits} hits, ` +
      //         `token delta: ${delta > 0 ? "+" : ""}${delta})`,
      //       );
    }
    state.consecutiveHits = 1;
    state.lastStaticHash = staticHash;
    state.lastStaticTokens = Math.round(staticPrefix.length / 4);
    // PA-7 FIX (pipeline audit): lastStaticPrefix assignment removed. The
    // full static prefix string (kilobytes, system-prompt sized) was stored
    // on every change but NEVER READ — pure memory retention with no
    // consumer. The hash (lastStaticHash) is what all comparisons use.
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

  const systemContent =
    dynamicContext.length > 0
      ? `${staticPrefix}\n\n[Session Context — updated each turn]\n${dynamicContext}`
      : staticPrefix;

  const alignedMessages = [
    { role: "system", content: systemContent },
    ...conversationMessages, // ← conversation history untouched, sequences intact
  ];


  // FIX 3: Corrected hit rate formula
  const hitRate =
    state.totalAlignments > 0
      ? ((state.totalHits / state.totalAlignments) * 100).toFixed(1)
      : "0.0";

  //   console.log(
  //     `[CacheAligner] 📌 [${clientName}] Prefix: ${staticTokens} tokens (hash: ${staticHash}) | ` +
  //     `Dynamic: ${dynamicTokens} tokens | ` +
  //     `Streak: ${state.consecutiveHits} | ` +
  //     `Hit rate: ${hitRate}%`,
  //   );

  // ── Dashboard hook ──
  statsEmitter.recordCacheAlignStreak(state.consecutiveHits, parseFloat(hitRate));

  return { ...payload, messages: alignedMessages };
}

// ─────────────────────────────────────────────
// Stats exports
// ─────────────────────────────────────────────

export function getCacheAlignerStats(clientName = null) {
  if (clientName) {
    return { ..._getState(clientName) };
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
