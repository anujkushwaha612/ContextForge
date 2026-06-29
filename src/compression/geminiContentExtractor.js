/**
 * geminiContentExtractor.js
 *
 * Gemini CLI sends file contents embedded inside user message parts[]
 * using a delimiter pattern:
 *
 *   parts: [
 *     { text: "user prompt here" },
 *     { text: "\n--- Content from referenced files ---" },
 *     { text: "\nContent from @filename.js:\n" },
 *     { text: "// entire file content here..." },
 *     { text: "\n--- End of content ---" }
 *   ]
 *
 * After toInternal(), these parts are concatenated into one giant user
 * message string. Every pipeline stage gates on role === "tool" and
 * skips user messages entirely — so the file content is invisible to
 * the compression pipeline.
 *
 * This extractor runs BEFORE those stages and converts inline file
 * content into synthetic role=tool messages so the full pipeline can
 * operate on them normally.
 *
 * Fat Catch threshold:
 *   5,000 chars — intentionally LOW.
 *   Gemini CLI reads files client-side and injects them inline, but
 *   ContextForge has graph tools that make reading the full file
 *   unnecessary. By vaulting early we force the LLM to use
 *   contextforge_query_graph(find_symbol) instead of reading the raw
 *   file — which is faster, cheaper, and more precise.
 *
 *   The vault stub message explicitly instructs the LLM to prefer
 *   graph tools over contextforge_retrieve, matching the Claude Code
 *   workflow exactly.
 *
 * Input (after toInternal):
 *   { role: "user", content: "prompt\n--- Content from referenced files ---\n..." }
 *
 * Output:
 *   { role: "user", content: "prompt" }
 *   { role: "assistant", content: null, tool_calls: [{name: "read_file"}] }
 *   { role: "tool", content: "[CF_VAULT:xxx] ... prefer graph tools" }
 */

import { saveToVault } from "../logging/cacheDb.js";

// ─────────────────────────────────────────────
// Detection patterns
// ─────────────────────────────────────────────

const FILE_CONTENT_START = "--- Content from referenced files ---";
const FILE_CONTENT_END   = "--- End of content ---";

// 5,000 chars — same as before.
// Files larger than this are vaulted so the LLM uses graph tools instead.
// Files smaller than this (small configs, package.json) are fine inline.
const GEMINI_FAT_CATCH_THRESHOLD = 5_000;

const FILE_HEADER_PATTERN = /^Content from @?(.+?):\s*$/m;

function _hasInlineFileContent(content) {
  return (
    typeof content === "string" &&
    content.includes(FILE_CONTENT_START)
  );
}

function _parseFileBlocks(block) {
  const withoutEnd = block.includes(FILE_CONTENT_END)
    ? block.substring(0, block.lastIndexOf(FILE_CONTENT_END))
    : block;

  const files  = [];
  const lines  = withoutEnd.split("\n");

  let currentFile  = null;
  let currentLines = [];

  for (const line of lines) {
    const headerMatch = line.match(FILE_HEADER_PATTERN);

    if (headerMatch) {
      if (currentFile !== null) {
        files.push({
          filename: currentFile,
          content:  currentLines.join("\n").trim(),
        });
      }
      currentFile  = headerMatch[1].trim();
      currentLines = [];
      continue;
    }

    if (currentFile !== null) {
      currentLines.push(line);
    }
  }

  if (currentFile !== null && currentLines.length > 0) {
    files.push({
      filename: currentFile,
      content:  currentLines.join("\n").trim(),
    });
  }

  return files;
}

function _extractFromUserMessage(content) {
  const delimIdx = content.indexOf(FILE_CONTENT_START);

  const userPrompt  = content.substring(0, delimIdx).trim();
  const fileSection = content.substring(delimIdx + FILE_CONTENT_START.length);
  const fileBlocks  = _parseFileBlocks(fileSection);

  return { userPrompt, fileBlocks };
}

// ─────────────────────────────────────────────
// Vault stub message
//
// The stub explicitly directs the LLM toward graph tools.
// This is the key difference from the old stub which just said
// "use contextforge_retrieve" — that caused the retrieve loop.
//
// With graph tools injected (fixed by messageOrigin), the LLM
// will call find_symbol instead of retrieve, matching Claude Code.
// ─────────────────────────────────────────────

function _buildVaultStub(vaultId, filename, sizeChars) {
  const tokens = Math.round(sizeChars / 4);
  return (
    `[CF_VAULT:${vaultId}] ${filename} (${tokens} tokens) is available but not loaded inline.\n` +
    `PREFERRED: Use contextforge_query_graph with find_symbol to locate specific functions ` +
    `without loading the full file — faster and cheaper.\n` +
    `FALLBACK: Use contextforge_retrieve with vault_id="${vaultId}" only if you need ` +
    `content that find_symbol cannot locate (e.g. inline route handlers, config objects).`
  );
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

export function extractGeminiInlineContent(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  const hasAny = payload.messages.some(
    (m) => m.role === "user" && _hasInlineFileContent(m.content),
  );
  if (!hasAny) return payload;

  const newMessages  = [];
  let extractedCount = 0;
  let extractedChars = 0;
  let vaultedFiles   = 0;
  let inlineFiles    = 0;

  for (const msg of payload.messages) {
    if (msg.role !== "user" || !_hasInlineFileContent(msg.content)) {
      newMessages.push(msg);
      continue;
    }

    const { userPrompt, fileBlocks } = _extractFromUserMessage(msg.content);

    if (fileBlocks.length === 0) {
      newMessages.push(msg);
      continue;
    }

    newMessages.push({
      ...msg,
      content: userPrompt || "[file reference]",
    });

    for (const file of fileBlocks) {
      const syntheticId = `cf_inline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      let toolContent = file.content;
      let isVaulted   = false;

      if (file.content.length > GEMINI_FAT_CATCH_THRESHOLD) {
        // ── Vault large files ──
        // Use graph tools (find_symbol) instead of loading inline.
        // The stub message explicitly tells the LLM to prefer graph tools.
        const vaultId = saveToVault(file.content);
        console.log(
          `[GeminiExtractor] 🗜️  Fat Catch: ${file.filename} ` +
          `(${file.content.length} chars → Vault ${vaultId})`,
        );
        toolContent = _buildVaultStub(vaultId, file.filename, file.content.length);
        vaultedFiles++;
        isVaulted = true;
      } else {
        // ── Small files pass inline ──
        // package.json, .env, small configs — no graph tools needed.
        inlineFiles++;
        console.log(
          `[GeminiExtractor] 📄 Inline: ${file.filename} ` +
          `(${file.content.length} chars)`,
        );
      }

      // Synthetic tool call
      newMessages.push({
        role:    "assistant",
        content: null,
        tool_calls: [
          {
            id:   syntheticId,
            type: "function",
            function: {
              name:      "read_file",
              arguments: JSON.stringify({ file_path: file.filename }),
            },
          },
        ],
      });

      // Synthetic tool result
      newMessages.push({
        role:         "tool",
        tool_call_id: syntheticId,
        name:         "read_file",
        content:      toolContent,
        _filename:    file.filename,
        _toolName:    "read_file",
        _args:        { file_path: file.filename },
        _vaulted:     isVaulted,
      });

      extractedCount++;
      extractedChars += file.content.length;
    }
  }

  if (extractedCount > 0) {
    console.log(
      `[GeminiExtractor] 📄 Extracted ${extractedCount} inline file(s) ` +
      `(${extractedChars} chars, ~${Math.round(extractedChars / 4)} tokens) ` +
      `→ synthetic tool messages` +
      (inlineFiles  > 0 ? ` (${inlineFiles} inline)`  : "") +
      (vaultedFiles > 0 ? ` (${vaultedFiles} vaulted → use graph tools)` : ""),
    );
  }

  return { ...payload, messages: newMessages };
}