import { saveToVault } from "../logging/cacheDb.js";
// ============================================================
// PHASE 2, FEATURE 5: TARGETED LOG & DIFF PRUNER
// ============================================================

/**
 * Important patterns that must be kept in log output.
 * Lines matching these patterns AND lines near them are retained.
 */
const LOG_KEEP_PATTERNS = [
  /\bERROR\b/i,
  /\bFAIL(?:ED|URE)?\b/i,
  /\bCRITICAL\b/i,
  /\bFATAL\b/i,
  /\bPANIC\b/i,
  /\bEXCEPTION\b/i,
  /\bTRACE\b/i,
  /\bABORT\b/i,
  /\bKILLED\b/i,
  /\bSEGV\b/i, // segfault
  /\bSIGNAL\b/i,
  /\bUNEXPECTED\b/i,
  /\bTIMEOUT\b/i,
  /\bDENIED\b/i,
  /\bFORBIDDEN\b/i,
  /\bERR_\w+/i, // node error codes
  /^\s+at\s/, // stack trace line (e.g., "    at Module._compile (...)")
  /^\s+[a-zA-Z0-9._]+\(.+:\d+:\d+\)/, // another stack trace style
  /\brefused\b/i,
  /\bnot found\b/i,
  /\bmissing\b/i,
  /\bundefined\b/i,
  /\bnull\b/i,
  /\bNaN\b/i,
];

const CONTEXT_BEFORE = 2; // lines to keep before an important line
const CONTEXT_AFTER = 3; // lines to keep after an important line
const HEAD_LINES = 5; // always keep first N lines
const TAIL_LINES = 3; // always keep last N lines

export function pruneLogOutput(text) {
  if (typeof text !== "string" || text.length === 0)
    return { kept: text, vaulted: false };

  const lines = text.split(/\r?\n/);
  if (lines.length < HEAD_LINES + TAIL_LINES + 5) {
    // Too short to prune meaningfully
    return { kept: text, vaulted: false };
  }

  // Mark lines to keep
  const keep = new Array(lines.length).fill(false);

  // Always keep head and tail
  for (let i = 0; i < Math.min(HEAD_LINES, lines.length); i++) keep[i] = true;
  for (let i = Math.max(0, lines.length - TAIL_LINES); i < lines.length; i++)
    keep[i] = true;

  // Mark important lines based on patterns
  const importantIndices = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (LOG_KEEP_PATTERNS.some((re) => re.test(line))) {
      importantIndices.push(i);
      keep[i] = true;
    }
  }

  // Expand context around important lines (without overlapping head/tail too much)
  for (const idx of importantIndices) {
    for (let c = 1; c <= CONTEXT_BEFORE; c++) {
      const before = idx - c;
      if (before >= 0 && !keep[before]) keep[before] = true;
    }
    for (let c = 1; c <= CONTEXT_AFTER; c++) {
      const after = idx + c;
      if (after < lines.length && !keep[after]) keep[after] = true;
    }
  }

  // Build pruned result
  const keptLines = [];
  let removedCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      keptLines.push(lines[i]);
    } else {
      removedCount++;
    }
  }

  const totalRemovedChars = lines
    .filter((_, i) => !keep[i])
    .reduce((sum, l) => sum + l.length + 1, 0); // +1 for newline

  // If we removed less than 30% of lines, just return original (no meaningful savings)
  if (removedCount < lines.length * 0.3) {
    return { kept: text, vaulted: false };
  }

  // Build compressed output with indicators where lines were pruned
  const resultLines = [];
  let inGap = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (inGap) {
        resultLines.push(`  [... ${removedCount} verbose lines pruned ...]`);
        inGap = false;
      }
      resultLines.push(lines[i]);
    } else {
      inGap = true;
    }
  }
  if (inGap) {
    resultLines.push(`  [... ${removedCount} verbose lines pruned ...]`);
  }

  const keptText = resultLines.join("\n");
  return {
    kept: keptText,
    vaulted: true,
    originalText: text,
    removedLines: removedCount,
    removedChars: totalRemovedChars,
  };
}

/**
 * Prunes a unified diff by collapsing large sections of unchanged
 * context lines that have no nearby changes.
 *
 * Strategy:
 * - Keep all hunk headers (@@ ... @@)
 * - Keep all added (+) and removed (-) lines
 * - Keep unchanged lines if they are within CONTEXT_RANGE of any change
 * - Replace long runs of completely unchanged context with [... N lines omitted ...]
 */
const DIFF_CONTEXT_RANGE = 3; // lines of unchanged context to keep around changes

export function pruneDiffOutput(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { kept: text, vaulted: false };
  }

  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;

  // Track which lines are "important" (headers, changes)
  const important = new Array(totalLines).fill(false);

  // Mark all hunk headers and +/- lines as important
  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    if (line.startsWith("@@") || line.startsWith("+") || line.startsWith("-")) {
      important[i] = true;
    }
  }

  // Expand around important lines: mark unchanged context lines within range
  const keep = [...important];
  for (let i = 0; i < totalLines; i++) {
    if (important[i]) {
      for (let d = 1; d <= DIFF_CONTEXT_RANGE; d++) {
        if (i - d >= 0 && lines[i - d].startsWith(" ") && !keep[i - d]) {
          keep[i - d] = true;
        }
        if (
          i + d < totalLines &&
          lines[i + d].startsWith(" ") &&
          !keep[i + d]
        ) {
          keep[i + d] = true;
        }
      }
    }
  }

  // Build pruned output
  const resultLines = [];
  let inOmittedBlock = false;
  let omittedCount = 0;

  for (let i = 0; i < totalLines; i++) {
    if (keep[i]) {
      if (inOmittedBlock && omittedCount > 0) {
        resultLines.push(`[... ${omittedCount} unchanged lines omitted ...]`);
        inOmittedBlock = false;
        omittedCount = 0;
      }
      resultLines.push(lines[i]);
    } else {
      inOmittedBlock = true;
      omittedCount++;
    }
  }

  if (inOmittedBlock && omittedCount > 0) {
    resultLines.push(`[... ${omittedCount} unchanged lines omitted ...]`);
  }

  const keptText = resultLines.join("\n");

  // Only vault if we actually saved significant space
  const removedLines = totalLines - keep.filter(Boolean).length;
  if (removedLines < totalLines * 0.2) {
    // Not worth vaulting – diff is already tight
    return { kept: text, vaulted: false };
  }

  return {
    kept: keptText,
    vaulted: true,
    originalText: text,
    removedLines,
    removedChars: lines
      .filter((_, i) => !keep[i])
      .reduce((sum, l) => sum + l.length + 1, 0),
  };
}

/*
 * Prunes markdown by collapsing large unchanged sections.
 * Keeps: headings, code blocks, lists with errors, first/last paragraphs
 * Removes: long prose paragraphs with no structural markers
 */
export function pruneMarkdownOutput(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { kept: text, vaulted: false };
  }

  const lines = text.split(/\r?\n/);
  if (lines.length < 20) return { kept: text, vaulted: false };

  const keep = new Array(lines.length).fill(false);

  // Always keep structural lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^#{1,6}\s/.test(line);
    const isCodeFence = /^```/.test(line);
    const isList = /^[-*+]\s|^\d+\.\s/.test(line);
    const isBlockquote = /^>/.test(line);
    const hasError = LOG_KEEP_PATTERNS.some((p) => p.test(line));
    const isHorizontalRule = /^[-*_]{3,}\s*$/.test(line);

    if (
      isHeading ||
      isCodeFence ||
      isList ||
      isBlockquote ||
      hasError ||
      isHorizontalRule
    ) {
      keep[i] = true;
      // Keep surrounding context
      if (i > 0) keep[i - 1] = true;
      if (i < lines.length - 1) keep[i + 1] = true;
    }
  }

  // Always keep first 5 and last 3 lines
  for (let i = 0; i < Math.min(5, lines.length); i++) keep[i] = true;
  for (let i = Math.max(0, lines.length - 3); i < lines.length; i++)
    keep[i] = true;

  const removedCount = keep.filter(Boolean).length;
  if (removedCount < lines.length * 0.3) {
    return { kept: text, vaulted: false };
  }

  // Build output with gap markers
  const result = [];
  let gapCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (gapCount > 0) {
        result.push(`[... ${gapCount} lines of prose omitted ...]`);
        gapCount = 0;
      }
      result.push(lines[i]);
    } else {
      gapCount++;
    }
  }
  if (gapCount > 0) result.push(`[... ${gapCount} lines of prose omitted ...]`);

  const removedLines = lines.length - keep.filter(Boolean).length;
  return {
    kept: result.join("\n"),
    vaulted: removedLines > lines.length * 0.3,
    originalText: text,
    removedLines,
    removedChars: lines
      .filter((_, i) => !keep[i])
      .reduce((sum, l) => sum + l.length + 1, 0),
  };
}

/**
 * Processes all tool results in the payload that have a _cf_type tag,
 * applying the appropriate pruner.
 */
export function pruneToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  let pruneStats = {
    log: 0,
    diff: 0,
    markdown: 0,
    charsSaved: 0,
    linesRemoved: 0,
    vaultsCreated: 0,
    skipped: 0,
  };

  payload.messages = payload.messages.map((msg) => {
    if (
      msg.role === "tool" &&
      typeof msg.content === "string" &&
      msg._cf_type
    ) {
      // Skip already-processed messages — SemanticDedup and AST Compressor
      // run before Pruner in the pipeline. Messages they've already handled
      // should not be re-pruned.
      if (msg._prunedVaultId || msg._cf_deduped || msg._compressedVaultId || msg._dedupVaultId) {
        pruneStats.skipped++;
        return msg;
      }

      const beforeLen = msg.content.length;
      let result;

      switch (msg._cf_type) {
        case "log":
          result = pruneLogOutput(msg.content);
          pruneStats.log++;
          break;
        case "diff":
          result = pruneDiffOutput(msg.content);
          pruneStats.diff++;
          break;
        case "markdown":
          result = pruneMarkdownOutput(msg.content);
          pruneStats.markdown++;
          break;
        default:
          return msg;
      }

      if (result.vaulted && result.originalText) {
        const vaultId = saveToVault(result.originalText);
        pruneStats.vaultsCreated++;
        pruneStats.charsSaved += beforeLen - result.kept.length;
        pruneStats.linesRemoved += result.removedLines || 0;

        console.log(
          `[Log Pruner] ${msg._cf_type.toUpperCase()} pruned: ` +
            `removed ${result.removedLines} lines ` +
            `(~${Math.floor((result.removedChars || 0) / 4)} tokens) → Vault ${vaultId}`,
        );

        // ── Append vault retrieval stub ──
        // The pruner returns kept text with gap markers but no vault reference.
        // Without the stub the LLM cannot retrieve the full content.
        // Framed as tool call to avoid MCP skill misrouting.
        const vaultStub =
          `\n[CF_VAULT:${vaultId}] Full content available. ` +
          `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read the complete output.`;

        return {
          ...msg,
          content: result.kept + vaultStub,
          _prunedVaultId: vaultId,
        };
      }

      msg.content = result.kept;
      return msg;
    }

    // ── User content blocks (Anthropic pre-translation) ──
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((block) => {
          if (
            block.type === "tool_result" &&
            typeof block.content === "string" &&
            block._cf_type
          ) {
            if (block._prunedVaultId || block._cf_deduped || block._compressedVaultId || block._dedupVaultId) {
              pruneStats.skipped++;
              return block;
            }

            const beforeLen = block.content.length;
            let result;

            switch (block._cf_type) {
              case "log":
                result = pruneLogOutput(block.content);
                break;
              case "diff":
                result = pruneDiffOutput(block.content);
                break;
              case "markdown":
                result = pruneMarkdownOutput(block.content);
                break;
              default:
                return block;
            }

            if (result.vaulted && result.originalText) {
              const vaultId = saveToVault(result.originalText);
              console.log(
                `[Log Pruner] ${block._cf_type.toUpperCase()} pruned (Anthropic block): ` +
                  `removed ${result.removedLines} lines ` +
                  `(~${Math.floor((result.removedChars || 0) / 4)} tokens) → Vault ${vaultId}`,
              );

              // ── Append vault retrieval stub (same as above) ──
              const vaultStub =
                `\n[CF_VAULT:${vaultId}] Full content available. ` +
                `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read the complete output.`;

              return {
                ...block,
                content: result.kept + vaultStub,
                _prunedVaultId: vaultId,
              };
            }

            return { ...block, content: result.kept };
          }
          return block;
        }),
      };
    }

    return msg;
  });

  const processed = pruneStats.log + pruneStats.diff + pruneStats.markdown;
  if (processed > 0 || pruneStats.skipped > 0) {
    console.log(
      `[Pruner Summary] Processed ${pruneStats.log} logs, ` +
        `${pruneStats.diff} diffs, ${pruneStats.markdown} markdown | ` +
        `Lines removed: ${pruneStats.linesRemoved} | ` +
        `Chars saved: ${pruneStats.charsSaved} (~${Math.floor(pruneStats.charsSaved / 4)} tokens) | ` +
        `Vaults: ${pruneStats.vaultsCreated} | ` +
        `Skipped (already pruned): ${pruneStats.skipped}`,
    );
  }

  return payload;
}


