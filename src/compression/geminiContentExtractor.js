/**
 * geminiContentExtractor.js
 *   This extractor now ONLY converts inline @-content into properly-tagged
 *   synthetic tool messages (_cf_type, _filename set). ALL compression
 *   decisions belong to the unified pipeline downstream:
 *     - fatCatch vaults junk (lockfiles/minified/base64) and oversized text
 *       at policy thresholds
 *     - keep-newest dedup collapses repeated @-mentions across turns
 *     - age-gated AST compression skeletonizes OLD @-content but never the
 *       file the user JUST attached (attaching a file is an explicit signal
 *       the user wants the model to see it — vaulting it immediately, as the
 *       old 5k threshold did, fought the user's intent)
 *
 * Fixes:
 *   GX-1: Own vaulting/threshold/stub removed — one policy for all content.
 *   GX-2: Synthetic tool_call IDs are now DETERMINISTIC (hash of message
 *         index + filename + content length). The old Date.now()+random IDs
 *         changed on EVERY request — Gemini CLI resends full history each
 *         turn, so all translator message/prefix caches missed every time,
 *         and upstream prompt caching was permanently defeated.
 *   GX-3: _cf_type set here (by extension) so dedup/AST/fatCatch recognize
 *         these messages even if tagToolResults doesn't know the synthetic
 *         "read_file" name. _cf_synthetic marks provenance.
 *   GX-4: Array-content user messages (text+image parts) are now scanned
 *         too — previously only string content was handled.
 */

// ─────────────────────────────────────────────
// Detection patterns (verified against gemini-cli's atCommandProcessor:
// REFERENCE_CONTENT_START/END constants + "Content from @path:" headers)
// ─────────────────────────────────────────────

const FILE_CONTENT_START = "--- Content from referenced files ---";
const FILE_CONTENT_END   = "--- End of content ---";
const FILE_HEADER_PATTERN = /^Content from @?(.+?):\s*$/m;

// GX-3: extension → _cf_type (mirrors the pipeline's own EXT_TO_LANG intent)
const CODE_EXTS = new Set([
  "js","mjs","cjs","jsx","ts","tsx","py","go","rs","java","rb","kt","swift",
  "c","cpp","h","hpp","cs","vue","svelte","sh","bash","sql","graphql","proto",
]);

function cfTypeFor(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (CODE_EXTS.has(ext)) return "code";
  if (ext === "md" || ext === "mdx" || ext === "rst") return "markdown";
  if (ext === "json" || ext === "yaml" || ext === "yml" || ext === "toml") return "json";
  return "text";
}

// GX-2: deterministic ID — stable across requests for the same logical message
function syntheticId(msgIndex, filename, contentLength) {
  let h = 0x811c9dc5;
  const s = `${msgIndex}|${filename}|${contentLength}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `cf_at_${h.toString(16).padStart(8, "0")}`;
}

function _hasInlineFileContent(content) {
  return typeof content === "string" && content.includes(FILE_CONTENT_START);
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
// Main export
// ─────────────────────────────────────────────

export function extractGeminiInlineContent(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  // GX-4: also detect inline content inside array-content text blocks
  const msgHasInline = (m) => {
    if (m.role !== "user") return false;
    if (_hasInlineFileContent(m.content)) return true;
    if (Array.isArray(m.content)) {
      return m.content.some(
        (b) => b?.type === "text" && _hasInlineFileContent(b.text)
      );
    }
    return false;
  };

  if (!payload.messages.some(msgHasInline)) return payload;

  const newMessages  = [];
  let extractedCount = 0;
  let extractedChars = 0;

  for (let msgIndex = 0; msgIndex < payload.messages.length; msgIndex++) {
    const msg = payload.messages[msgIndex];

    if (!msgHasInline(msg)) {
      newMessages.push(msg);
      continue;
    }

    // Normalize: string content directly; array content → extract from the
    // text block containing the delimiter, keep other blocks (images) intact.
    let sourceText;
    let residualBlocks = null;

    if (typeof msg.content === "string") {
      sourceText = msg.content;
    } else {
      residualBlocks = [];
      sourceText = "";
      for (const b of msg.content) {
        if (b?.type === "text" && _hasInlineFileContent(b.text)) {
          sourceText = b.text;
        } else {
          residualBlocks.push(b);
        }
      }
    }

    const { userPrompt, fileBlocks } = _extractFromUserMessage(sourceText);

    if (fileBlocks.length === 0) {
      newMessages.push(msg);
      continue;
    }

    // The user's actual prompt (plus any non-text blocks like images)
    if (residualBlocks && residualBlocks.length > 0) {
      newMessages.push({
        ...msg,
        content: [
          { type: "text", text: userPrompt || "[file reference]" },
          ...residualBlocks,
        ],
      });
    } else {
      newMessages.push({
        ...msg,
        content: userPrompt || "[file reference]",
      });
    }

    for (const file of fileBlocks) {
      // GX-2: deterministic — same conversation state → same ID every request
      const id = syntheticId(msgIndex, file.filename, file.content.length);

      // Synthetic tool call
      newMessages.push({
        role:    "assistant",
        content: null,
        tool_calls: [
          {
            id,
            type: "function",
            function: {
              name:      "read_file",
              arguments: JSON.stringify({ file_path: file.filename }),
            },
          },
        ],
      });

      // Synthetic tool result — FULL content, properly tagged.
      // GX-1: no vaulting here. fatCatch/dedup/AST downstream apply the
      // same pressure-aware, age-gated policy they apply to everything.
      newMessages.push({
        role:         "tool",
        tool_call_id: id,
        name:         "read_file",
        content:      file.content,
        _filename:    file.filename,
        _toolName:    "read_file",
        _args:        { file_path: file.filename },
        _cf_type:     cfTypeFor(file.filename),   // GX-3
        _cf_synthetic: true,                       // provenance marker
      });

      extractedCount++;
      extractedChars += file.content.length;
    }
  }

  if (extractedCount > 0) {
    console.log(
      `[GeminiExtractor] 📄 Normalized ${extractedCount} inline @-file(s) ` +
      `(${extractedChars} chars, ~${Math.round(extractedChars / 4)} tokens) ` +
      `→ tagged tool messages (pipeline decides compression)`,
    );
  }

  return { ...payload, messages: newMessages };
}
