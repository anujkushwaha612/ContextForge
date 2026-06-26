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
 * skips user messages entirely — so the file content is invisible to:
 *   scrubToolResults, tagToolResults, pruneToolResults,
 *   interceptAndVaultMassiveToolResults, astCompressor, semanticDedup
 *
 * This extractor runs BEFORE those stages and converts inline file
 * content into synthetic role=tool messages so the full pipeline can
 * operate on them normally.
 *
 * For large files (> GEMINI_FAT_CATCH_THRESHOLD chars), it vaults the raw
 * content immediately and replaces the tool result with a short vault stub,
 * mimicking Claude Code's lazy-fetch behavior for maximum token savings.
 *
 * Input (after toInternal):
 *   { role: "user", content: "prompt\n--- Content from referenced files ---\n..." }
 *
 * Output:
 *   { role: "user", content: "prompt" }           ← user prompt only
 *   { role: "assistant", content: null,            ← synthetic tool call
 *     tool_calls: [{ id: "cf_inline_...", type: "function",
 *                    function: { name: "read_file",
 *                                arguments: '{"file_path":"filename.js"}' } }] }
 *   { role: "tool", tool_call_id: "cf_inline_...", ← synthetic tool result
 *     name: "read_file", content: "stub or compressed content" }
 *
 * The synthetic messages are injected immediately after the user message
 * that contained them. Conversation sequence integrity is preserved:
 *   user → assistant(tool_call) → tool → [next real message]
 *
 * On turns where no file content is embedded, this function is a no-op
 * and returns the payload unmodified.
 *
 * Only runs when clientAdapter.name === "gemini" (enforced at call site
 * in server.js).
 */

import { saveToVault } from "../logging/cacheDb.js";


// ─────────────────────────────────────────────
// Detection patterns
// ─────────────────────────────────────────────

// Gemini CLI file reference block delimiter
const FILE_CONTENT_START = "--- Content from referenced files ---";
const FILE_CONTENT_END   = "--- End of content ---";

// Threshold for immediate vaulting (Fat Catch) of extracted files
// 5,000 chars ≈ 1,250 tokens — everything above this goes straight to vault
const GEMINI_FAT_CATCH_THRESHOLD = 5000;

// Header pattern: "Content from @filename.ext:" or "Content from filename.ext:"
// Captures the filename including path separators and extensions.
const FILE_HEADER_PATTERN = /^Content from @?(.+?):\s*$/m;

/**
 * Check if a user message string contains Gemini CLI inline file content.
 *
 * @param {string} content
 * @returns {boolean}
 */
function _hasInlineFileContent(content) {
  return (
    typeof content === "string" &&
    content.includes(FILE_CONTENT_START)
  );
}

/**
 * Parse a file content block string (the text between FILE_CONTENT_START
 * and FILE_CONTENT_END) into individual file entries.
 *
 * Input example:
 *   "\nContent from @langraph-agent.js:\n// file content here\n\n--- End of content ---"
 *
 * Output:
 *   [{ filename: "langraph-agent.js", content: "// file content here" }]
 *
 * @param {string} block  — text from after FILE_CONTENT_START to end of message
 * @returns {Array<{ filename: string, content: string }>}
 */
function _parseFileBlocks(block) {
  // Strip the end delimiter if present
  const withoutEnd = block.includes(FILE_CONTENT_END)
    ? block.substring(0, block.lastIndexOf(FILE_CONTENT_END))
    : block;

  const files  = [];
  const lines  = withoutEnd.split("\n");

  let currentFile    = null;
  let currentLines   = [];

  for (const line of lines) {
    const headerMatch = line.match(FILE_HEADER_PATTERN);

    if (headerMatch) {
      // Save previous file if any
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

  // Save last file
  if (currentFile !== null && currentLines.length > 0) {
    files.push({
      filename: currentFile,
      content:  currentLines.join("\n").trim(),
    });
  }

  return files;
}

/**
 * Extract inline file content from a single user message string.
 *
 * Returns:
 *   { userPrompt, fileBlocks }
 *
 * userPrompt  — the user's actual question/instruction (before the delimiter)
 * fileBlocks  — array of { filename, content } extracted from the file section
 *
 * @param {string} content
 * @returns {{ userPrompt: string, fileBlocks: Array<{ filename: string, content: string }> }}
 */
function _extractFromUserMessage(content) {
  const delimIdx = content.indexOf(FILE_CONTENT_START);

  const userPrompt  = content.substring(0, delimIdx).trim();
  const fileSection = content.substring(delimIdx + FILE_CONTENT_START.length);
  const fileBlocks  = _parseFileBlocks(fileSection);

  return { userPrompt, fileBlocks };
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

/**
 * Extract Gemini CLI inline file content from user messages and convert
 * to synthetic role=tool messages so the compression pipeline can process them.
 *
 * For files exceeding GEMINI_FAT_CATCH_THRESHOLD (5,000 chars), the raw content
 * is vaulted immediately and replaced with a short stub. This prevents large
 * files from ever reaching the LLM inline, boosting turn-1 compression to 80%+.
 *
 * This is a no-op for:
 *   - Non-user messages
 *   - User messages with no file content delimiter
 *   - Empty payloads
 *
 * @param {object} payload — OpenAI-format internal payload (after toInternal)
 * @returns {object}       — payload with inline file content extracted
 */
export function extractGeminiInlineContent(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  // Fast path: no user messages with inline content → return unchanged
  const hasAny = payload.messages.some(
    (m) => m.role === "user" && _hasInlineFileContent(m.content),
  );
  if (!hasAny) return payload;

  const newMessages = [];
  let extractedCount = 0;
  let extractedChars = 0;
  let vaultedFiles = 0;

  for (const msg of payload.messages) {
    // ── Non-user or no inline content → pass through unchanged ──
    if (msg.role !== "user" || !_hasInlineFileContent(msg.content)) {
      newMessages.push(msg);
      continue;
    }

    const { userPrompt, fileBlocks } = _extractFromUserMessage(msg.content);

    if (fileBlocks.length === 0) {
      // Delimiter found but no parseable files — pass through unchanged
      newMessages.push(msg);
      continue;
    }

    // ── Push the user message with only the prompt text ──
    // If userPrompt is empty (message was ONLY file content),
    // keep a minimal placeholder so the conversation role sequence
    // stays valid (cannot have two consecutive assistant messages).
    newMessages.push({
      ...msg,
      content: userPrompt || "[file reference]",
    });

    // ── Push synthetic assistant + tool pairs for each file ──
    for (const file of fileBlocks) {
      const syntheticId = `cf_inline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      let toolContent = file.content;

      // ── Fat Catch vaulting for large extracted files ──
      if (file.content.length > GEMINI_FAT_CATCH_THRESHOLD) {
        const vaultId = saveToVault(file.content);
        console.log(
          `[GeminiExtractor] 🗜️  Fat Catch: ${file.filename} ` +
          `(${file.content.length} chars → Vault ${vaultId})`
        );
        toolContent =
          `[CF_VAULT:${vaultId}] ${Math.round(file.content.length / 4)} tokens compressed. ` +
          `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`
        vaultedFiles++;
      }

      // Synthetic tool call (assistant turn)
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

      // Synthetic tool result — the file content goes here,
      // now visible to every pipeline stage that gates on role=tool
      newMessages.push({
        role:         "tool",
        tool_call_id: syntheticId,
        name:         "read_file",
        content:      toolContent,
        // Pre-populate metadata so tagToolResults backfill works immediately
        _filename:    file.filename,
        _toolName:    "read_file",
        _args:        { file_path: file.filename },
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
      (vaultedFiles > 0 ? ` (${vaultedFiles} vaulted via Fat Catch)` : "")
    );
  }

  return { ...payload, messages: newMessages };
}