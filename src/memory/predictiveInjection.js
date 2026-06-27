// ============================================================
// PHASE 3, FEATURE 7: PREDICTIVE CONTEXT INJECTION
// ============================================================

// ─────────────────────────────────────────────
// Source code context detector
// Prevents false positives when the LLM reads
// source files that contain the word "error" in
// comments, variable names, regex literals, etc.
// ─────────────────────────────────────────────

/**
 * Heuristics that indicate the content is source code being read,
 * not an actual runtime error output.
 */
const SOURCE_CODE_SIGNALS = [
  // Line numbers prefixed (e.g. "146    // comment")
  /^\s*\d{1,4}\s{1,8}[^\s]/m,
  // Common code constructs
  /\bexport\s+(function|const|class|default)\b/,
  /\bimport\s+\{[^}]+\}\s+from\b/,
  /\/\/\s*(TODO|FIXME|NOTE|HACK|LOG|ERROR|WARN)/i,
  // Regex literals inside strings (the ERR_ case)
  /\/\\b\w+\\b\//,
  /\/\\\w+\//,
  // Stack traces are NOT source code — they have "at " prefixes
];

const STACK_TRACE_SIGNALS = [
  /^\s+at\s+\S+\s+\(/m, // "  at functionName (file:line)"
  /^\s+at\s+async\s+/m, // "  at async ..."
];

/**
 * Returns true if content looks like source code being read,
 * not a runtime error output.
 * Stack traces are excluded — they look like code but ARE errors.
 */
function isSourceCodeContent(content) {
  if (typeof content !== "string") return false;

  // If it has stack trace signals, it's a real error — not source code
  if (STACK_TRACE_SIGNALS.some((p) => p.test(content))) return false;

  const matchCount = SOURCE_CODE_SIGNALS.filter((p) => p.test(content)).length;
  // Require at least 2 signals to avoid false positives on short snippets
  return matchCount >= 2;
}

// ─────────────────────────────────────────────
// Failure detection
// ─────────────────────────────────────────────

/**
 * Patterns that indicate a tool result is a genuine runtime failure.
 *
 * Rules for adding patterns here:
 *  - Must be specific enough to not match source code comments
 *  - "error" alone is NOT enough — must have structural context
 *  - Prefer anchored or compound patterns over single keywords
 */
const FAILURE_SIGNALS = [
  // Shell / process errors
  /\bcommand not found\b/i,
  /\bno such file or directory\b/i,
  /\bpermission denied\b/i,
  /\bfailed with exit code\b/i,
  /\bexited with code [^0]\b/i,
  /\bnpm ERR!\b/, // must have the ! — not just ERR
  /\bEACCES\b/,
  /\bENOENT\b/,
  /\bECONNREFUSED\b/,
  /\bEADDRINUSE\b/,
  /\bEPERM\b/,

  // Node.js module errors
  /\bcannot find module\b/i,
  /\bmodule not found\b/i,

  // JavaScript runtime exceptions — must appear at line start or after newline
  // to avoid matching "SyntaxError" inside a comment or regex
  /(?:^|\n)\s*SyntaxError:/,
  /(?:^|\n)\s*TypeError:/,
  /(?:^|\n)\s*ReferenceError:/,
  /(?:^|\n)\s*RangeError:/,
  /(?:^|\n)\s*Error:/, // capital E, colon required

  // Property access errors (specific enough)
  /\bcannot read propert(?:y|ies) of\b/i,
  /\bis not defined\b/i,
  /\bis not a function\b/i,

  // Tool-level error wrappers (from Claude / MCP)
  /<tool_use_error>/i,
  /\bNo such tool available\b/i,
];

const TRIVIAL_ERROR_PATTERNS = [
  /no such file or directory/i,
  /command not found/i,
  /not a git repository/i,
  /already exists/i,
  /is not a directory/i,
  /permission denied/i,
  /cannot find module/i,
];

function isTrivialError(content) {
  if (typeof content !== "string") return false;
  const lineCount = content.split("\n").filter((l) => l.trim()).length;
  // Only trivial if BOTH: matches a trivial pattern AND is short (< 6 lines)
  // A 20-line stack trace with "permission denied" is NOT trivial
  return lineCount < 6 && TRIVIAL_ERROR_PATTERNS.some((p) => p.test(content));
}

/**
 * Detects whether a tool result content looks like a genuine runtime failure.
 * Guards against false positives from source code reads.
 */
function isFailedToolResult(content) {
  if (typeof content !== "string") return false;

  // Early exit: if this looks like source code, skip it entirely
  // This handles the "146  // Log level bracket [ERROR]" false positive
  if (isSourceCodeContent(content)) return false;

  return FAILURE_SIGNALS.some((pattern) => pattern.test(content));
}

// ─────────────────────────────────────────────
// Signal extraction
// ─────────────────────────────────────────────

/**
 * Extracts the most meaningful error snippet for the BM25 search query.
 * Prefers lines that contain strong signals over generic matches.
 */
function extractErrorSignal(content) {
  const lines = content.split("\n");

  // Priority 1: lines with strong structural signals (exceptions, tool errors)
  const STRONG_SIGNALS = [
    /(?:^|\s)(?:SyntaxError|TypeError|ReferenceError|RangeError|Error):/,
    /<tool_use_error>/i,
    /\bNo such tool available\b/i,
    /\bENOENT\b/,
    /\bECONNREFUSED\b/,
    /\bnpm ERR!\b/,
  ];

  for (const line of lines) {
    if (STRONG_SIGNALS.some((p) => p.test(line))) {
      return line.trim().slice(0, 200);
    }
  }

  // Priority 2: first line that matches any failure signal
  for (const line of lines) {
    if (FAILURE_SIGNALS.some((p) => p.test(line))) {
      return line.trim().slice(0, 200);
    }
  }

  return content.slice(0, 200);
}

// ─────────────────────────────────────────────
// Suggestion builder
// ─────────────────────────────────────────────

/**
 * Builds the suggestion block appended to the error message.
 */
function buildSuggestionBlock(searchQuery, results) {
  const lines = [
    ``,
    `---`,
    `[ContextForge Predictive Suggestion]`,
    `Detected a command failure. Searched your project vault for relevant context.`,
    `Query used: "${searchQuery.slice(0, 100)}"`,
    ``,
  ];

  for (let i = 0; i < results.length; i++) {
    const score =
      results[i].sparseScore !== undefined
        ? results[i].sparseScore
        : results[i].combinedScore || 0;

    lines.push(`[Match ${i + 1} | BM25 Relevance: ${score.toFixed(2)}]`);
    lines.push(results[i].breadcrumb || results[i].text?.slice(0, 300) || "");
    lines.push("");
  }

  lines.push(
    `If this context is relevant, use contextforge_retrieve ` +
      `with a specific search_query to load the full section.`,
  );
  lines.push(`---`);

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────

/**
 * Walks tool results from the CURRENT TURN ONLY to detect genuine runtime
 * failures and append predictive BM25 suggestions from the project vault.
 *
 * FIX: Previously walked ALL messages in payload.messages, so failed grep
 * tool results from turn N were re-detected on turns N+1, N+2, etc.,
 * causing 4x repeated log lines and wasted retriever queries every pipeline
 * run. Now only scans tool results that appear after the last assistant
 * message — i.e. the responses that just came back this turn.
 */
export function applyPredictiveInjection(payload, hybridRetriever) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;
  if (!hybridRetriever) return payload;

  // ── Find the start of the current turn's tool results ──
  // The current turn is everything after the last assistant message.
  // Tool results before that are from previous turns and must not be
  // re-scanned — they were already processed when they first appeared.
  let currentTurnStart = 0;
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    if (payload.messages[i].role === "assistant") {
      currentTurnStart = i + 1;
      break;
    }
  }

  // No assistant message found — this is the first turn, scan everything.
  // (Shouldn't happen in practice but safe fallback.)
  const currentTurnMessages = payload.messages.slice(currentTurnStart);

  // Quick exit: nothing to scan in this turn
  if (currentTurnMessages.length === 0) return payload;

  let injectCount = 0;

  // Build updated messages: keep history untouched, only mutate current turn
  const historicalMessages = payload.messages.slice(0, currentTurnStart);
  const updatedTurnMessages = currentTurnMessages.map((msg) => {
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg;

    // ── Gate 1: is this actually a failure? ──
    if (!isFailedToolResult(msg.content)) return msg;

    // ── Gate 2: is it trivially short and self-explanatory? ──
    if (isTrivialError(msg.content)) {
      console.log(
        `[Predictive Injection] ⏭️  Skipping trivial error ` +
          `(${msg.content.split("\n").filter((l) => l.trim()).length} lines)`,
      );
      return msg;
    }

    try {
      const errorSignal = extractErrorSignal(msg.content);

      // Enrich query with recent user intent from the full history
      let searchQuery = errorSignal;
      for (let i = payload.messages.length - 1; i >= 0; i--) {
        if (payload.messages[i].role === "user") {
          const userText =
            typeof payload.messages[i].content === "string"
              ? payload.messages[i].content
              : "";
          if (userText.length > 0) {
            searchQuery = `${userText.slice(0, 100)} ${errorSignal}`;
          }
          break;
        }
      }

      console.log(
        `[Predictive Injection] 🔍 Failure detected: "${errorSignal.slice(0, 80)}"`,
      );

      let results = [];
      try {
        results = hybridRetriever.sparseSearch(searchQuery, 5, 1.5);
      } catch (searchErr) {
        console.warn(
          `[Predictive Injection] Search error: ${searchErr.message}`,
        );
        return msg;
      }

      if (!results || results.length === 0) return msg;

      const meaningful = results.filter(
        (r) => (r.breadcrumb || "").length > 100,
      );

      if (meaningful.length === 0) {
        console.log(
          `[Predictive Injection] Results ignored (breadcrumb too short)`,
        );
        return msg;
      }

      const suggestion = buildSuggestionBlock(searchQuery, meaningful);
      console.log(
        `[Predictive Injection] 💡 Injected ${meaningful.length} high-quality hint(s)`,
      );
      injectCount++;

      return { ...msg, content: msg.content + suggestion };
    } catch (err) {
      console.warn(`[Predictive Injection] ⚠️ Failed: ${err.message}`);
      return msg;
    }
  });

  payload.messages = [...historicalMessages, ...updatedTurnMessages];

  if (injectCount > 0) {
    console.log(
      `[Predictive Injection] Summary: ${injectCount} result(s) enriched`,
    );
  }

  return payload;
}

