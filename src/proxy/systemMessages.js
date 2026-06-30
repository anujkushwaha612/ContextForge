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
  if (systemMessages.length <= 1) {
    return payload;
  }

  // First pass — handle skills list pruning in-place
  payload.messages = payload.messages.map((msg) => {
    if (msg.role === "system" && typeof msg.content === "string") {
      if (
        msg.content.includes(
          "The following skills are available for use with the Skill tool:",
        )
      ) {
        const parts = msg.content.split(
          "The following skills are available for use with the Skill tool:",
        );
        const cleanContent =
          parts[0].trim() +
          "\n[ContextForge: Repetitive skills list removed to save tokens]";

        if (cleanContent.length < msg.content.length) {
          charsSaved += msg.content.length - cleanContent.length;
          prunedCount++;
          return { ...msg, content: cleanContent };
        }
      }
    }
    return msg;
  });

  // Second pass — remove duplicate system messages entirely
  payload.messages = payload.messages.filter((msg) => {
    if (msg.role !== "system" || typeof msg.content !== "string") return true;

    const promptHash = crypto
      .createHash("sha256")
      .update(msg.content)
      .digest("hex");

    if (seenSystemPrompts.has(promptHash)) {
      charsSaved += msg.content.length;
      prunedCount++;
      return false; // remove from array entirely
    }

    seenSystemPrompts.add(promptHash);
    return true;
  });

  if (prunedCount > 0) {
    const tokensSaved = Math.floor(charsSaved / 4);
//     console.log(
//       `[SysPrompt Pruner] ✂️  Removed ${prunedCount} redundant system blocks (saved ~${tokensSaved} tokens)`,
//     );
    payload._cf_sysPromptTokensSaved = tokensSaved;
  }

  return payload;
}