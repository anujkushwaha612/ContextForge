import { saveToVault } from "../logging/cacheDb.js";
// ─────────────────────────────────────────────
const MINIFIED_AVG_LINE_LENGTH = 500; // chars/line → treat as minified
const MINIFIED_MIN_CHARS = 5_000; // don't bother for tiny files

export function interceptAndVaultMassiveToolResults(
  payload,
  charThreshold = 150000,
) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  // ── Kill-switch: CF_DISABLE_FAT_CATCH=true bypasses this stage entirely ──
  // Useful for debugging without removing the import / disabling the module.
  if (process.env.CF_DISABLE_FAT_CATCH === "true") {
    console.warn(
      "[Fat Catch] ⚠️  Bypassed via CF_DISABLE_FAT_CATCH=true environment variable",
    );
    return payload;
  }

  function processContent(content, msgType) {
    const contentLength = content.length;
    if (msgType === "code" && contentLength > MINIFIED_MIN_CHARS) {
      const lines = content.split("\n");
      const avgLine = contentLength / lines.length;
      if (avgLine > MINIFIED_AVG_LINE_LENGTH) {
        const vaultId = saveToVault(content);
        console.log(`[Fat Catch] 🗜️  Minified code detected (${contentLength} chars, avg line ${Math.round(avgLine)} chars) -> Vaulted ${vaultId}`);
        return `[CF_VAULT:${vaultId}] ${Math.round(contentLength / 4)} tokens compressed. Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`;
      }
    }
    if (contentLength > charThreshold) {
      const vaultId = saveToVault(content);
      console.log(`[Fat Catch] 🕸️ Intercepted massive tool result (${contentLength} chars) -> Offloaded to ${vaultId} [threshold=${charThreshold}]`);
      return `[CF_VAULT:${vaultId}] ${Math.round(contentLength / 4)} tokens compressed. Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`;
    }
    return content;
  }

  payload.messages = payload.messages.map((msg) => {
    // Whitelist contextforge_retrieve: if the LLM explicitly asks for a vaulted file, give it the FULL file!
    if (msg.role === "tool" && typeof msg.content === "string") {
      if (msg.name === "contextforge_retrieve") return msg;
      
      const newContent = processContent(msg.content, msg._cf_type);
      if (newContent !== msg.content) {
        return { ...msg, _cf_vaulted: true, content: newContent };
      }
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      let modified = false;
      const newContent = msg.content.map(block => {
        if (block.type === "tool_result" && typeof block.content === "string") {
          if (block.name === "contextforge_retrieve") return block;
          
          const processed = processContent(block.content, block._cf_type);
          if (processed !== block.content) {
            modified = true;
            return { ...block, _cf_vaulted: true, content: processed };
          }
        }
        return block;
      });
      if (modified) return { ...msg, content: newContent };
    }
    return msg;
  });

  return payload;
}