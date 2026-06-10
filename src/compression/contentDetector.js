/**
 * contentDetector.js
 *
 * Production-grade content classifier for LLM tool results.
 *
 * Architecture: Weighted Evidence Engine (WEE)
 * -------------------------------------------
 * Runs all detectors in parallel and calculates a confidence score for each.
 *
 * Robustness Strategy:
 * 1. Strategic Sampling: head + mid + tail, kept SEPARATE (not concatenated)
 *    to prevent split markers from poisoning anchored regex matches.
 * 2. Evidence Weighing: Strong (+0.5) vs Weak (+0.1, capped at +0.4).
 * 3. Negative Constraints: Conflicting signals reduce score (-0.4 per penalty).
 * 4. Confidence Threshold: Below 0.35 → "text" default.
 * 5. Code Override: Strong code signals always win over log/text
 *    to prevent source files with date comments from being pruned as logs.
 */

import crypto from "node:crypto";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

const CACHE_MAX            = 2000;
const SAMPLE_SIZE          = 1024;
const CONFIDENCE_THRESHOLD = 0.35;
const PENALTY_WEIGHT       = 0.4;  // reduced from 0.7 — penalties should demote, not destroy

const _cache = new Map();
const _stats = {
  cacheHit:        0,
  totalClassified: 0,
  byType: { json: 0, code: 0, log: 0, diff: 0, text: 0, markdown: 0 },
};

// ─────────────────────────────────────────────
// Signal Definitions
//
// Penalty design rules:
//   - Penalties should DEMOTE a type, not zero it out
//   - Only penalize on unmistakable signals of a DIFFERENT type
//   - Code penalty must NOT fire on JS object literals (quoted keys are valid JS)
//   - Log penalty must NOT fire on source files that mention log levels in comments
// ─────────────────────────────────────────────

const SIGNALS = {
  json: {
    strong: [
      // Must close correctly — not just start with {
      // Checked against full text in _classifyJson fast-path
      /^[\s\n]*\{\s*"\w+":/,          // object with first quoted key
      /^[\s\n]*\[\s*\{/,              // array of objects
      /^[\s\n]*\[\s*"[^"]*"\s*[,\]]/,  // array of strings
    ],
    weak: [
      /:\s*\[/, /:\s*\{/, /"(\w+)":/, /true\b/, /false\b/, /null\b/,
    ],
    // Only penalize on unmistakable NON-json code patterns
    // NOT quoted keys — those are valid in both JSON and JS
    penalty: [
      /\bfunction\s+\w+\s*\(/,        // named function declaration
      /\bconst\s+\w+\s*=\s*(?!["'\d{[])/,  // const without immediate literal
      /\bimport\s+\{[^}]+\}\s+from\s+['"]/,  // ES module import
      /=>\s*\{/,                      // arrow function body
      /\bclass\s+\w+/,               // class declaration
    ],
  },

  code: {
    strong: [
      // Module-level keywords at line start — unmistakable code
      /^(import|export)\s+(default\s+)?(function|class|const|let|var|\{)/m,
      /^(const|let|var)\s+\w+\s*=/m,
      /^(function|async function)\s+\w+\s*\(/m,
      /^class\s+\w+(\s+extends\s+\w+)?\s*\{/m,
      // Language-specific unmistakable patterns
      /^def\s+\w+\s*\(/m,             // Python
      /^pub(lic)?\s+fn\s+\w+/m,      // Rust
      /^func\s+\w+/m,                // Go
      /^#include\s*[<"]/m,           // C/C++
    ],
    weak: [
      /[{};]/, /=>/, /===/, /!==/, /\?\?/,
      /\b(if|while|for|switch|try|catch|throw)\b/,
      /^\s*\/\/.+$/m,                // single line comment
      /^\s*\/\*[\s\S]*?\*\//m,       // block comment
    ],
    // Code penalties: only fire on things that are NEVER in code files
    // Do NOT penalize for markdown headings (READMEs embedded in code comments)
    // Do NOT penalize for quoted keys (valid JS object literal syntax)
    penalty: [
      /^diff --git\s/m,              // unmistakably a diff
      /^@@\s+-\d+,\d+\s+\+\d+,\d+ @@/m,  // diff hunk
    ],
  },

  log: {
    strong: [
      // ISO timestamp — strong signal but only if NOT in a comment
      // Require it at line start or after common log prefixes
      /^[\d\-T:Z.]+\s+(INFO|WARN|ERROR|DEBUG|TRACE)/m,
      /^\[[\d\-T:Z.]+\]\s+/m,        // [timestamp] prefix
      // Log level bracket ONLY at line start (not inside comments or strings)
      /^\[(INFO|WARN(?:ING)?|ERROR|DEBUG|TRACE|FATAL|CRITICAL)\]/m,
      // Structured log format: level=INFO or "level":"INFO"
      /\blevel[=:]["']?(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)/i,
    ],
    weak: [
      /^\d{2}:\d{2}:\d{2}/m,
      /\b(exception|stacktrace)\b/i,
      /^\s*at\s+\w+[\w.]+\s*\(/m,    // stack frame
      /^\s*\[\d+\]\s+/m,             // PID prefix
    ],
    // Penalize hard when the content is clearly source code
    penalty: [
      /^(import|export)\s+/m,
      /^(const|let|var|function|class)\s+/m,
      /^def\s+\w+\s*\(/m,
      /^pub(lic)?\s+fn\s+/m,
    ],
  },

  diff: {
    strong: [
      /^diff --git\s/m,
      /^@@\s+-\d+,\d+\s+\+\d+,\d+ @@/m,
      /^--- a\/.+\n\+\+\+ b\/.+/m,
    ],
    weak: [
      /^\+(?!\+\+)[^\n]/m,           // added line (not +++)
      /^-(?!--)[^\n]/m,              // removed line (not ---)
      /^@@\s+/m,
    ],
    penalty: [
      /^#{1,6} /m,
      /^(import|export|const)\s+/m,
    ],
  },

  markdown: {
    strong: [
      /^#{1,6} \w/m,                 // ATX heading
      /^```\w*\s*$/m,                // fenced code block
      /^\[.{1,80}\]\(https?:\/\//m,  // hyperlink
      /^---\s*$/m,                   // frontmatter or HR
    ],
    weak: [
      /^[-*+] \w/m,                  // unordered list
      /^\d+\. \w/m,                  // ordered list
      /\*\*\w+.*?\*\*/,              // bold
      /`[^`]+`/,                     // inline code
    ],
    penalty: [
      /^(import|export|const|let|var)\s+/m,
      /^diff --git/m,
      /^[\s\n]*\{\s*"\w+":/,         // JSON object
    ],
  },
};

// ─────────────────────────────────────────────
// Sampling — SEPARATE windows, not concatenated
//
// Why separate: anchored regexes like /^import/m match start-of-line.
// If we concatenate "head\n---SPLIT---\nmid", the split marker itself
// becomes a line boundary and /^{/ matches "---SPLIT---\n{" incorrectly.
// ─────────────────────────────────────────────

function getSamples(text) {
  if (text.length <= SAMPLE_SIZE * 3) {
    return [text]; // small file — use in full, no need to slice
  }

  const head = text.slice(0, SAMPLE_SIZE);
  const mid  = text.slice(
    Math.floor(text.length / 2) - Math.floor(SAMPLE_SIZE / 2),
    Math.floor(text.length / 2) + Math.floor(SAMPLE_SIZE / 2),
  );
  const tail = text.slice(-SAMPLE_SIZE);

  return [head, mid, tail]; // SEPARATE — caller tests each independently
}

// ─────────────────────────────────────────────
// Score calculation — tests each sample window separately
// ─────────────────────────────────────────────

function calculateScore(samples, type) {
  const signals = SIGNALS[type];
  let score = 0;

  // Strong signals: test against ALL samples, award once per pattern
  // (prevents a single sample dominating by matching the same pattern 3x)
  for (const reg of signals.strong) {
    for (const sample of samples) {
      if (reg.test(sample)) {
        score += 0.5;
        break; // count this pattern once regardless of how many samples match
      }
    }
  }

  // Weak signals: incremental, capped at 0.4 total
  let weakCount = 0;
  for (const reg of signals.weak) {
    for (const sample of samples) {
      if (reg.test(sample)) {
        weakCount++;
        break; // count once per pattern
      }
    }
  }
  score += Math.min(weakCount * 0.1, 0.4);

  // Penalties: demote score for conflicting signals
  // Reduced weight (0.4 not 0.7) — penalty should demote, not eliminate
  for (const reg of signals.penalty) {
    for (const sample of samples) {
      if (reg.test(sample)) {
        score -= PENALTY_WEIGHT;
        break; // count once per pattern
      }
    }
  }

  return Math.max(0, Math.min(1, score));
}

// ─────────────────────────────────────────────
// JSON fast-path validation
//
// The JSON strong signals match opening brackets, but we also
// need to verify the content actually closes correctly.
// This prevents truncated JSON from beating valid code files.
// ─────────────────────────────────────────────

function _looksLikeCompleteJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const first = trimmed[0];
  const last  = trimmed[trimmed.length - 1];
  return (first === "{" && last === "}") || (first === "[" && last === "]");
}

// ─────────────────────────────────────────────
// Code override
//
// If ANY code strong signal fires, code cannot lose to log or text.
// This prevents the "JS file with date comment classified as log" bug.
// Code can still lose to diff (diff > code is correct) and json (if valid).
// ─────────────────────────────────────────────

function _hasStrongCodeSignal(samples) {
  for (const reg of SIGNALS.code.strong) {
    for (const sample of samples) {
      if (reg.test(sample)) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// Main classifier
// ─────────────────────────────────────────────

function _classify(text) {
  const samples = getSamples(text);

  // ── JSON fast-path ──
  // Check structure before running full scoring
  // Prevents JS object literals from scoring as JSON
  const firstSample = samples[0];
  const trimmedHead = firstSample.trim();
  if (
    (trimmedHead.startsWith("{") || trimmedHead.startsWith("[")) &&
    _looksLikeCompleteJson(text)
  ) {
    // Still run scoring to catch JSON with embedded code (JS-in-JSON edge case)
    const jsonScore = calculateScore(samples, "json");
    const codeScore = calculateScore(samples, "code");
    if (jsonScore > codeScore) return "json";
  }

  // ── Full scoring ──
  const scores = {};
  for (const type of Object.keys(SIGNALS)) {
    scores[type] = calculateScore(samples, type);
  }

  // ── Code override ──
  // A file with module-level import/export/function/class is always code.
  // log and text cannot beat it even with timestamps or level brackets.
  if (_hasStrongCodeSignal(samples)) {
    const codeScore = scores.code;
    // Only diff and json can beat code (and only if they score significantly higher)
    if (scores.diff > codeScore + 0.3) return "diff";
    if (scores.json > codeScore + 0.3) return "json";
    return "code";
  }

  // ── Winner selection ──
  let bestType  = "text";
  let bestScore = 0;

  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestType  = type;
    }
  }

  return bestScore >= CONFIDENCE_THRESHOLD ? bestType : "text";
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

function _cacheKey(text) {
  return crypto
    .createHash("md5")
    .update(text.slice(0, 512))
    .digest("hex")
    .slice(0, 16);
}

export async function initMagika() {
  console.log("[Classifier] ✅ Production Weighted-Evidence Engine ready");
}

export function classifyContent(text) {
  if (typeof text !== "string" || text.length === 0) return "text";

  const key = _cacheKey(text);
  if (_cache.has(key)) {
    _stats.cacheHit++;
    return _cache.get(key);
  }

  const result = _classify(text);

  _stats.totalClassified++;
  _stats.byType[result] = (_stats.byType[result] || 0) + 1;

  if (_cache.size >= CACHE_MAX) {
    _cache.delete(_cache.keys().next().value);
  }
  _cache.set(key, result);

  return result;
}

export function classifyContentAsync(text) {
  return Promise.resolve(classifyContent(text));
}

export function getClassifierStats() {
  return { ..._stats, cacheSize: _cache.size };
}