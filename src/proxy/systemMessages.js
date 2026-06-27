import crypto from "node:crypto";
// ============================================================
// INLINE SYSTEM MESSAGE DEDUPLICATOR & PRUNER
// ============================================================

export function deduplicateSystemMessages(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  const seenSystemPrompts = new Set();
  let prunedCount = 0;
  let charsSaved = 0;

  const systemMessages = payload.messages.filter((m) => m.role === "system");

  // If there's only ONE system message, never touch it
  // It contains the full behavioral context Nemotron needs
  if (systemMessages.length <= 1) {
    return payload;
  }

  payload.messages = payload.messages.map((msg) => {
    if (msg.role === "system" && typeof msg.content === "string") {
      // 1. Destroy the repetitive "Skills" manual injected by Claude Code
      if (
        msg.content.includes(
          "The following skills are available for use with the Skill tool:",
        )
      ) {
        const parts = msg.content.split(
          "The following skills are available for use with the Skill tool:",
        );
        // Keep whatever was before it (usually important context), but drop the massive list
        const cleanContent =
          parts[0].trim() +
          "\n[ContextForge: Repetitive skills list removed to save tokens]";

        if (cleanContent.length < msg.content.length) {
          charsSaved += msg.content.length - cleanContent.length;
          msg.content = cleanContent;
          prunedCount++;
        }
      }

      // 2. Standard Deduplication: If we've seen this exact system prompt before, drop it
      const promptHash = crypto
        .createHash("sha256")
        .update(msg.content)
        .digest("hex");
      if (seenSystemPrompts.has(promptHash)) {
        charsSaved += msg.content.length;
        msg.content = "[ContextForge: Redundant system prompt removed]";
        prunedCount++;
      } else {
        seenSystemPrompts.add(promptHash);
      }
    }
    return msg;
  });

  if (prunedCount > 0) {
    const tokensSaved = Math.floor(charsSaved / 4);
    console.log(
      `[SysPrompt Pruner] ✂️  Removed ${prunedCount} redundant system blocks (saved ~${tokensSaved} tokens)`,
    );
    // FIX 8: Stamp savings onto payload for StageTimer observability
    payload._cf_sysPromptTokensSaved = tokensSaved;
  }

  return payload;
}

