/**
 * Content type detection for multi-format compression.
 * Direct port of headroom/transforms/content_detector.py
 * with additions for ContextForge's tool result shapes.
 *
 * Detection priority:
 *   1. JSON array (SmartCrusher compatible)
 *   2. Git diff (high confidence threshold)
 *   3. HTML (needs extraction not compression)
 *   4. Search results (grep/ripgrep format)
 *   5. Build/log output
 *   6. Source code
 *   7. Plain text (fallback)
 */

// ─────────────────────────────────────────────
// Content type enum
// ─────────────────────────────────────────────

export const ContentType = {
  JSON_ARRAY:     "json_array",
  JSON_OBJECT:    "json_object",  // non-array JSON (your existing "json" type)
  SOURCE_CODE:    "source_code",
  SEARCH_RESULTS: "search",
  BUILD_OUTPUT:   "build",
  GIT_DIFF:       "diff",
  HTML:           "html",
  PLAIN_TEXT:     "text",
};

// ─────────────────────────────────────────────
// Pre-compiled patterns (module-level, zero re-compile cost)
// ─────────────────────────────────────────────

const SEARCH_RESULT_PATTERN = /^[^\s:]+:\d+:/m;

// Extended diff detection — handles merge commits, combined diffs
const DIFF_HEADER_PATTERN = /^(diff --git|diff --combined |diff --cc |--- a\/|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|@@@+\s+-\d+)/m;
const DIFF_CHANGE_PATTERN  = /^[+-][^+-]/m;

// HTML patterns
const HTML_DOCTYPE_PATTERN    = /^\s*<!doctype\s+html/i;
const HTML_TAG_PATTERN        = /<html[\s>]/i;
const HTML_HEAD_PATTERN       = /<head[\s>]/i;
const HTML_BODY_PATTERN       = /<body[\s>]/i;
const HTML_STRUCTURAL_PATTERN = /<(div|span|script|style|link|meta|nav|header|footer|aside|article|section|main)[\s>]/gi;

// Code patterns per language
const CODE_PATTERNS = {
  python: [
    /^\s*(def|class|import|from|async def)\s+\w+/m,
    /^\s*@\w+/m,
    /^\s*"""/m,
    /^\s*if __name__\s*==/m,
  ],
  javascript: [
    /^\s*(function|const|let|var|class|import|export)\s+/m,
    /^\s*(async\s+function|=>\s*\{)/m,
    /^\s*module\.exports/m,
    /^\s*require\(/m,
  ],
  typescript: [
    /^\s*(interface|type|enum|namespace)\s+\w+/m,
    /:\s*(string|number|boolean|any|void)\b/,
    /^\s*(abstract|readonly)\s+/m,
  ],
  go: [
    /^\s*(func|type|package|import)\s+/m,
    /^\s*func\s+\([^)]+\)\s+\w+/m,
    /:=\s*/,
  ],
  rust: [
    /^\s*(fn|struct|enum|impl|mod|use|pub)\s+/m,
    /^\s*#\[/m,
    /\blet\s+mut\b/,
  ],
  java: [
    /^\s*(public|private|protected)\s+(class|interface|enum)/m,
    /^\s*@\w+/m,
    /^\s*package\s+[\w.]+;/m,
  ],
};

// Log/build output patterns
const LOG_PATTERNS = [
  /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i,
  /\b(WARN|WARNING)\b/i,
  /\b(INFO|DEBUG|TRACE)\b/i,
  /^\s*\d{4}-\d{2}-\d{2}/m,
  /^\s*\[\d{2}:\d{2}:\d{2}\]/m,
  /^={3,}|^-{3,}/m,
  /^\s*(PASSED|FAILED|SKIPPED)\b/m,
  /^npm ERR!|^yarn error|^cargo error/m,
  /Traceback \(most recent call last\)/,
  /^\w*(Error|Exception):/m,
  /^\s*at\s+[\w.$]+\(/m,
  // ContextForge additions — patterns your classifier missed
  /^\s*error\s+TS\d+:/m,           // TypeScript compiler
  /\berror\[E\d+\]/,               // Rust compiler
  /^\s*✓|^\s*✗|^\s*×/m,          // test runners (vitest, jest)
  /\bexited with code [^0]/i,      // shell exit codes
  /^vite|^webpack|^rollup|^esbuild/m,
  /\d+:\d+\s+(error|warning)/m,   // generic linter format
];

// ─────────────────────────────────────────────
// Main detector
// ─────────────────────────────────────────────

/**
 * Detect content type with confidence scoring.
 *
 * @param {string} content
 * @returns {{ contentType: string, confidence: number, metadata: object }}
 */
export function detectContentType(content) {
  if (!content || !content.trim()) {
    return { contentType: ContentType.PLAIN_TEXT, confidence: 0.0, metadata: {} };
  }

  // 1. JSON (highest priority)
  const jsonResult = tryDetectJson(content);
  if (jsonResult) return jsonResult;

  // 2. Git diff (very distinctive)
  const diffResult = tryDetectDiff(content);
  if (diffResult && diffResult.confidence >= 0.7) return diffResult;

  // 3. HTML
  const htmlResult = tryDetectHtml(content);
  if (htmlResult && htmlResult.confidence >= 0.7) return htmlResult;

  // 4. Search results
  const searchResult = tryDetectSearch(content);
  if (searchResult && searchResult.confidence >= 0.6) return searchResult;

  // 5. Build/log output
  const logResult = tryDetectLog(content);
  if (logResult && logResult.confidence >= 0.5) return logResult;

  // 6. Source code
  const codeResult = tryDetectCode(content);
  if (codeResult && codeResult.confidence >= 0.5) return codeResult;

  // 7. Fallback
  return { contentType: ContentType.PLAIN_TEXT, confidence: 0.5, metadata: {} };
}

// ─────────────────────────────────────────────
// Individual detectors
// ─────────────────────────────────────────────

function tryDetectJson(content) {
  const trimmed = content.trimStart();

  // JSON array
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const isDictArray = parsed.length > 0 &&
          parsed.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
        return {
          contentType: ContentType.JSON_ARRAY,
          confidence: 1.0,
          metadata: { itemCount: parsed.length, isDictArray },
        };
      }
    } catch (_) {}
  }

  // JSON object (non-array)
  if (trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return {
        contentType: ContentType.JSON_OBJECT,
        confidence: 0.95,
        metadata: {},
      };
    } catch (_) {}
  }

  // NDJSON — multiple JSON objects, one per line
  if (trimmed.includes("\n")) {
    const lines = trimmed.split("\n").filter((l) => l.trim());
    const jsonLines = lines.filter((l) => {
      try { JSON.parse(l); return true; } catch (_) { return false; }
    });
    if (jsonLines.length > 2 && jsonLines.length / lines.length > 0.7) {
      return {
        contentType: ContentType.JSON_ARRAY,
        confidence: 0.85,
        metadata: { itemCount: jsonLines.length, isDictArray: false, isNDJSON: true },
      };
    }
  }

  return null;
}

function tryDetectDiff(content) {
  // Scan up to 500 lines (handles git log -p preambles)
  const lines = content.split("\n").slice(0, 500);

  let headerMatches = 0;
  let changeMatches = 0;

  for (const line of lines) {
    if (DIFF_HEADER_PATTERN.test(line)) headerMatches++;
    if (DIFF_CHANGE_PATTERN.test(line)) changeMatches++;
  }

  if (headerMatches === 0) return null;

  const confidence = Math.min(1.0, 0.5 + headerMatches * 0.2 + changeMatches * 0.05);

  return {
    contentType: ContentType.GIT_DIFF,
    confidence,
    metadata: { headerMatches, changeLines: changeMatches },
  };
}

function tryDetectHtml(content) {
  const sample = content.slice(0, 3000);

  const hasDoctype  = HTML_DOCTYPE_PATTERN.test(sample);
  const hasHtmlTag  = HTML_TAG_PATTERN.test(sample);
  const hasHead     = HTML_HEAD_PATTERN.test(sample);
  const hasBody     = HTML_BODY_PATTERN.test(sample);
  const structuralCount = (sample.match(HTML_STRUCTURAL_PATTERN) || []).length;

  if (!hasDoctype && !hasHtmlTag && structuralCount < 3) return null;

  let confidence = 0;
  if (hasDoctype)  confidence += 0.5;
  if (hasHtmlTag)  confidence += 0.3;
  if (hasHead)     confidence += 0.1;
  if (hasBody)     confidence += 0.1;
  confidence += Math.min(0.3, structuralCount * 0.03);
  confidence = Math.min(1.0, confidence);

  if (confidence < 0.5) return null;

  return {
    contentType: ContentType.HTML,
    confidence,
    metadata: { hasDoctype, hasHtmlTag, structuralTags: structuralCount },
  };
}

function tryDetectSearch(content) {
  const lines = content.split("\n").slice(0, 100);
  if (!lines.length) return null;

  let matchingLines = 0;
  for (const line of lines) {
    if (line.trim() && SEARCH_RESULT_PATTERN.test(line)) matchingLines++;
  }

  if (matchingLines === 0) return null;

  const nonEmpty = lines.filter((l) => l.trim()).length;
  if (!nonEmpty) return null;

  const ratio = matchingLines / nonEmpty;
  if (ratio < 0.3) return null;

  const confidence = Math.min(1.0, 0.4 + ratio * 0.6);
  return {
    contentType: ContentType.SEARCH_RESULTS,
    confidence,
    metadata: { matchingLines, totalLines: nonEmpty },
  };
}

function tryDetectLog(content) {
  const lines = content.split("\n").slice(0, 200);
  if (!lines.length) return null;

  let patternMatches = 0;
  let errorMatches = 0;

  for (const line of lines) {
    for (let i = 0; i < LOG_PATTERNS.length; i++) {
      if (LOG_PATTERNS[i].test(line)) {
        patternMatches++;
        if (i < 2) errorMatches++; // ERROR or WARN patterns
        break;
      }
    }
  }

  if (patternMatches === 0) return null;

  const nonEmpty = lines.filter((l) => l.trim()).length;
  if (!nonEmpty) return null;

  const ratio = patternMatches / nonEmpty;
  if (ratio < 0.1) return null;

  const confidence = Math.min(1.0, 0.3 + ratio * 0.5 + errorMatches * 0.05);
  return {
    contentType: ContentType.BUILD_OUTPUT,
    confidence,
    metadata: { patternMatches, errorMatches, totalLines: nonEmpty },
  };
}

function tryDetectCode(content) {
  const lines = content.split("\n").slice(0, 100);
  if (!lines.length) return null;

  const languageScores = {};

  for (const line of lines) {
    for (const [lang, patterns] of Object.entries(CODE_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          languageScores[lang] = (languageScores[lang] || 0) + 1;
          break;
        }
      }
    }
  }

  if (Object.keys(languageScores).length === 0) return null;

  const bestLang = Object.entries(languageScores)
    .sort(([, a], [, b]) => b - a)[0];
  const [lang, score] = bestLang;

  // Need at least 3 pattern matches (their threshold — much stricter than yours)
  if (score < 3) return null;

  const nonEmpty = lines.filter((l) => l.trim()).length;
  const ratio = score / Math.max(nonEmpty, 1);
  const confidence = Math.min(1.0, 0.4 + ratio * 0.4 + score * 0.02);

  return {
    contentType: ContentType.SOURCE_CODE,
    confidence,
    metadata: { language: lang, patternMatches: score },
  };
}

// ─────────────────────────────────────────────
// Drop-in replacement for helper.js classifyContent
// Maps new ContentType values to your existing pipeline's type strings
// ─────────────────────────────────────────────

/**
 * Drop-in replacement for classifyContent() in helper.js.
 * Returns the same string values your pipeline already uses.
 */
export function classifyContent(text) {
  const result = detectContentType(text);

  switch (result.contentType) {
    case ContentType.JSON_ARRAY:
    case ContentType.JSON_OBJECT:
      return "json";
    case ContentType.SOURCE_CODE:
      return "code";
    case ContentType.GIT_DIFF:
      return "diff";
    case ContentType.BUILD_OUTPUT:
      return "log";
    case ContentType.SEARCH_RESULTS:
      return "search"; // new type — add a search compressor handler
    case ContentType.HTML:
      return "html";   // new type — route to text compressor for now
    default:
      return "text";
  }
}

/**
 * Full detection result with confidence and metadata.
 * Use this when you need more than just the type string.
 */
export function detectWithConfidence(text) {
  return detectContentType(text);
}