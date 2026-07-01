import { saveToVault } from "../logging/cacheDb.js";
import { isShellToolResult } from "./toolScrubber.js";

// ─────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────

const MINIFIED_MIN_CHARS = 5_000;
const MINIFIED_LONG_LINE_THRESHOLD = 200;
const MINIFIED_LONG_LINE_RATIO = 0.8;

function isMinifiedCode(content) {
  if (content.length <= MINIFIED_MIN_CHARS) return false;

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  const longLines = lines.filter((l) => l.length > MINIFIED_LONG_LINE_THRESHOLD).length;
  return longLines / lines.length > MINIFIED_LONG_LINE_RATIO;
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

export function interceptAndVaultMassiveToolResults(payload, charThreshold = 150_000) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  if (process.env.CF_DISABLE_FAT_CATCH === "true") {
    console.warn("[Fat Catch] ⚠️  Bypassed via CF_DISABLE_FAT_CATCH=true environment variable");
    return payload;
  }

  function processContentWithThreshold(content, msgType) {
    // BUG-1 FIX: Never re-process already-vaulted or already-compressed content
    if (
      content.includes("[CF_VAULT:") ||
      content.includes("[CF_COMPRESSED_FILE vault_id:") ||
      content.startsWith("[CF_COMPRESSED]")
    ) {
      return content;
    }

    if (msgType === "code" && isMinifiedCode(content)) {
      const vaultId = saveToVault(content);
      console.log(
        `[Fat Catch] 🗜️  Minified code detected (${content.length} chars, ` +
          `>${Math.round(MINIFIED_LONG_LINE_RATIO * 100)}% long lines) -> Vaulted ${vaultId}`
      );
      return (
        `[CF_VAULT:${vaultId}] ${Math.round(content.length / 4)} tokens compressed. ` +
        `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`
      );
    }

    if (content.length > charThreshold) {
      const vaultId = saveToVault(content);
      console.log(
        `[Fat Catch] 🕸️ Intercepted massive tool result (${content.length} chars) ` +
          `-> Offloaded to ${vaultId} [threshold=${charThreshold}]`
      );
      return (
        `[CF_VAULT:${vaultId}] ${Math.round(content.length / 4)} tokens compressed. ` +
        `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`
      );
    }

    return content;
  }

  payload.messages = payload.messages.map((msg) => {
    // ── OpenAI format: role:"tool" ────────────────────────────────────────
    if (msg.role === "tool" && typeof msg.content === "string") {
      // Whitelist retrieve tool — always pass through unmodified
      if (msg.name === "contextforge_retrieve") return msg;

      // FIX: Never vault shell tool results — Bash/PowerShell output
      // must always reach the LLM fresh. Large directory listings or
      // command outputs vaulted here produce the same ECONNREFUSED
      // cascade as deduped shell results: LLM gets a stub, calls
      // contextforge_retrieve, retrieve fails → complete task failure.
      // _isShellTool is set by tagToolResults in toolScrubber.js.
      if (isShellToolResult(msg)) return msg;

      // BUG-2 FIX: Check flags set by upstream pipeline stages
      if (msg._cf_vaulted) return msg;
      if (msg._cf_deduped) return msg;
      if (msg._compressedVaultId) return msg;

      const newContent = processContentWithThreshold(msg.content, msg._cf_type);
      if (newContent !== msg.content) {
        return { ...msg, _cf_vaulted: true, content: newContent };
      }
      return msg;
    }

    // ── Anthropic format: role:"user" with tool_result blocks ────────────
    if (msg.role === "user" && Array.isArray(msg.content)) {
      let modified = false;
      const newContent = msg.content.map((block) => {
        if (block.type === "tool_result" && typeof block.content === "string") {
          // Whitelist retrieve tool
          if (block.name === "contextforge_retrieve") return block;

          // FIX: Same shell tool guard for Anthropic format path
          if (isShellToolResult(block)) return block;

          // BUG-4 FIX: Same guards as OpenAI format path
          if (block._cf_vaulted) return block;
          if (block._cf_deduped) return block;
          if (block._compressedVaultId) return block;

          const processed = processContentWithThreshold(block.content, block._cf_type);
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

