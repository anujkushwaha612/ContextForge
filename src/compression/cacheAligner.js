import crypto from "node:crypto";

// ─────────────────────────────────────────────
// Dynamic content patterns
// ─────────────────────────────────────────────

const DYNAMIC_PATTERNS = [
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
];

const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// ─────────────────────────────────────────────
// Static content fingerprinting
// ─────────────────────────────────────────────

let _lastStaticHash   = null;
let _lastStaticTokens = 0;
let _consecutiveHits  = 0;
let _totalAlignments  = 0;

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

export function alignCachePrefix(payload) {
  if (
    !payload.messages       ||
    !Array.isArray(payload.messages) ||
    payload.messages.length === 0
  ) {
    return payload;
  }

  _totalAlignments++;

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

  // ── Step 5: Stability check ──
  const staticHash = crypto
    .createHash("sha256")
    .update(staticPrefix)
    .digest("hex")
    .slice(0, 16);

  if (_lastStaticHash === staticHash) {
    _consecutiveHits++;
  } else {
    if (_lastStaticHash !== null) {
      const delta = Math.round(staticPrefix.length / 4) - _lastStaticTokens;
      console.log(
        `[CacheAligner] ⚠️ Static prefix changed ` +
        `(new hash: ${staticHash}, ` +
        `previous streak: ${_consecutiveHits} hits, ` +
        `token delta: ${delta > 0 ? "+" : ""}${delta})`,
      );
    }
    _consecutiveHits  = 1;
    _lastStaticHash   = staticHash;
    _lastStaticTokens = Math.round(staticPrefix.length / 4);
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

  // ── Step 7: Stats ──
  const staticTokens  = Math.round(staticPrefix.length / 4);
  const dynamicTokens = Math.round(dynamicContext.length / 4);
  const hitRate       = ((_consecutiveHits - 1) / _totalAlignments * 100).toFixed(1);

  console.log(
    `[CacheAligner] 📌 Prefix: ${staticTokens} tokens (hash: ${staticHash}) | ` +
    `Dynamic: ${dynamicTokens} tokens | ` +
    `Streak: ${_consecutiveHits} | ` +
    `Hit rate: ${hitRate}%`,
  );

  return { ...payload, messages: alignedMessages };
}

// ─────────────────────────────────────────────
// Stats exports
// ─────────────────────────────────────────────

export function getCacheAlignerStats() {
  return {
    lastStaticHash:  _lastStaticHash,
    consecutiveHits: _consecutiveHits,
    totalAlignments: _totalAlignments,
    estimatedCacheHitRate:
      _totalAlignments > 0
        ? ((_consecutiveHits - 1) / _totalAlignments * 100).toFixed(1) + "%"
        : "N/A",
  };
}

export function resetCacheAlignerStats() {
  _lastStaticHash   = null;
  _consecutiveHits  = 0;
  _totalAlignments  = 0;
  _lastStaticTokens = 0;
}