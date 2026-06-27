import { saveToVault } from "../logging/cacheDb.js";
// ─────────────────────────────────────────────
const MINIFIED_AVG_LINE_LENGTH = 500; // chars/line → treat as minified
const MINIFIED_MIN_CHARS = 5_000; // don't bother for tiny files

export function interceptAndVaultMassiveToolResults(
  payload,
  charThreshold = 15000,
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

  payload.messages = payload.messages.map((msg) => {
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg;

    const content = msg.content;
    const contentLength = content.length;

    // ── Fix 1: Minified code fast-path ──────────────────────────────────────
    // If ContentRouter tagged this as code AND the average line length
    // exceeds the minified threshold, vault immediately — regardless of
    // charThreshold. Minified code is unreadable inline and will never
    // compress via AST (no multi-line structure to reduce).
    //
    // Guard: only fire when the file is large enough to matter (>5k chars).
    // This prevents single-line config snippets from being needlessly vaulted.
    if (msg._cf_type === "code" && contentLength > MINIFIED_MIN_CHARS) {
      const lines = content.split("\n");
      const avgLine = contentLength / lines.length;

      if (avgLine > MINIFIED_AVG_LINE_LENGTH) {
        const vaultId = saveToVault(content);
        console.log(
          `[Fat Catch] 🗜️  Minified code detected ` +
            `(${contentLength} chars, avg line ${Math.round(avgLine)} chars) ` +
            `-> Vaulted ${vaultId}`,
        );
        return {
          ...msg,
          _cf_vaulted: true, // FIX F7: Flag to skip downstream dedup
          content:
            `[CF_VAULT:${vaultId}] ${Math.round(contentLength / 4)} tokens compressed. ` +
            `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`,
        };
      }
    }

    // ── Standard Fat Catch (unchanged) ──────────────────────────────────────
    if (contentLength > charThreshold) {
      const vaultId = saveToVault(content);
      console.log(
        `[Fat Catch] 🕸️ Intercepted massive tool result (${contentLength} chars) -> Offloaded to ${vaultId}` +
          ` [threshold=${charThreshold}]`,
      );
      return {
        ...msg,
        _cf_vaulted: true, // FIX F7: Flag to skip downstream dedup
        content:
          `[CF_VAULT:${vaultId}] ${Math.round(contentLength / 4)} tokens compressed. ` +
          `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`,
      };
    }

    return msg;
  });

  return payload;
}


