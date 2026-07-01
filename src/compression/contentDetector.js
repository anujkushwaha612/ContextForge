/**
 * contentDetector.js
 *
 * Production-grade content classifier for LLM tool results.
 *
 * Architecture: Weighted Evidence Engine (WEE)
 * -------------------------------------------
 * Runs all detectors and calculates a confidence score for each type.
 *
 * Robustness Strategy:
 * 1. Strategic Sampling: head + mid + tail, kept SEPARATE (not concatenated)
 *    to prevent split markers from poisoning anchored regex matches.
 * 2. Evidence Weighing: Strong (+0.5) vs Weak (+0.1, capped at +0.4).
 * 3. Negative Constraints: Conflicting signals reduce score (-0.4 per penalty).
 * 4. Confidence Threshold: Below 0.35 → "text" default.
 * 5. Code Override: Strong code signals always win over log/text
 *    to prevent source files with date comments from being pruned as logs.
 *
 * Fixes applied:
 *   CD-1: Cache key now includes content length to distinguish files with
 *         identical first 512 chars (e.g. two files from same project with
 *         the same standard import header).
 *
 *   CD-4: _hasStrongCodeSignal eliminated — calculateScore now returns
 *         { score, hadStrongSignal } so code strong signals are not
 *         tested twice per classification call.
 */

import crypto from "node:crypto";

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

const CACHE_MAX            = 2000;
const SAMPLE_SIZE          = 1024;
const CONFIDENCE_THRESHOLD = 0.35;
const PENALTY_WEIGHT       = 0.4;

const _cache = new Map();
const _stats = {
  cacheHit:        0,
  totalClassified: 0,
  byType: { json: 0, code: 0, log: 0, diff: 0, text: 0, markdown: 0 },
};

// ─────────────────────────────────────────────
// Signal Definitions
// ─────────────────────────────────────────────

const SIGNALS = {
  json: {
    strong: [
      /^[\s\n]*\{\s*"\w+":/,
      /^[\s\n]*\[\s*\{/,
      /^[\s\n]*\[\s*"[^"]*"\s*[,\]]/,
    ],
    weak: [
      /:\s*\[/, /:\s*\{/, /"(\w+)":/, /true\b/, /false\b/, /null\b/,
    ],
    penalty: [
      /\bfunction\s+\w+\s*\(/,
      /\bconst\s+\w+\s*=\s*(?!["'\d{[])/,
      /\bimport\s+\{[^}]+\}\s+from\s+['"]/,
      /=>\s*\{/,
      /\bclass\s+\w+/,
    ],
  },

  code: {
    strong: [
      /^(import|export)\s+(default\s+)?(function|class|const|let|var|\{)/m,
      /^(const|let|var)\s+\w+\s*=/m,
      /^(function|async function)\s+\w+\s*\(/m,
      /^class\s+\w+(\s+extends\s+\w+)?\s*\{/m,
      /^def\s+\w+\s*\(/m,
      /^pub(lic)?\s+fn\s+\w+/m,
      /^func\s+\w+/m,
      /^#include\s*[<"]/m,
    ],
    weak: [
      /[{};]/, /=>/, /===/, /!==/, /\?\?/,
      /\b(if|while|for|switch|try|catch|throw)\b/,
      /^\s*\/\/.+$/m,
      /^\s*\/\*[\s\S]*?\*\//m,
    ],
    penalty: [
      /^diff --git\s/m,
      /^@@\s+-\d+,\d+\s+\+\d+,\d+ @@/m,
    ],
  },

  log: {
    strong: [
      /^[\d\-T:Z.]+\s+(INFO|WARN|ERROR|DEBUG|TRACE)/m,
      /^\[[\d\-T:Z.]+\]\s+/m,
      /^\[(INFO|WARN(?:ING)?|ERROR|DEBUG|TRACE|FATAL|CRITICAL)\]/m,
      /\blevel[=:]["']?(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)/i,
    ],
    weak: [
      /^\d{2}:\d{2}:\d{2}/m,
      /\b(exception|stacktrace)\b/i,
      /^\s*at\s+\w+[\w.]+\s*\(/m,
      /^\s*\[\d+\]\s+/m,
    ],
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
      /^\+(?!\+\+)[^\n]/m,
      /^-(?!--)[^\n]/m,
      /^@@\s+/m,
    ],
    penalty: [
      /^#{1,6} /m,
      /^(import|export|const)\s+/m,
    ],
  },

  markdown: {
    strong: [
      /^#{1,6} \w/m,
      /^```\w*\s*$/m,
      /^\[.{1,80}\]\(https?:\/\//m,
      /^---\s*$/m,
    ],
    weak: [
      /^[-*+] \w/m,
      /^\d+\. \w/m,
      /\*\*\w+.*?\*\*/,
      /`[^`]+`/,
    ],
    penalty: [
      /^(import|export|const|let|var)\s+/m,
      /^diff --git/m,
      /^[\s\n]*\{\s*"\w+":/,
    ],
  },
};

// ─────────────────────────────────────────────
// Sampling — SEPARATE windows, not concatenated
// ─────────────────────────────────────────────

function getSamples(text) {
  if (text.length <= SAMPLE_SIZE * 3) {
    return [text];
  }

  const head = text.slice(0, SAMPLE_SIZE);
  const mid  = text.slice(
    Math.floor(text.length / 2) - Math.floor(SAMPLE_SIZE / 2),
    Math.floor(text.length / 2) + Math.floor(SAMPLE_SIZE / 2),
  );
  const tail = text.slice(-SAMPLE_SIZE);

  return [head, mid, tail];
}

// ─────────────────────────────────────────────
// Score calculation
//
// CD-4: Now returns { score, hadStrongSignal } so the caller does not
//       need to re-run strong signal tests in a separate pass.
//       Previously _hasStrongCodeSignal re-ran all code.strong patterns
//       after calculateScore had already tested them.
// ─────────────────────────────────────────────

function calculateScore(samples, type) {
  const signals = SIGNALS[type];
  let score          = 0;
  let hadStrongSignal = false;

  // Strong signals: test each pattern against all samples, award once
  for (const reg of signals.strong) {
    for (const sample of samples) {
      if (reg.test(sample)) {
        score += 0.5;
        hadStrongSignal = true;
        break;
      }
    }
  }

  // Weak signals: incremental, capped at 0.4 total
  let weakCount = 0;
  for (const reg of signals.weak) {
    for (const sample of samples) {
      if (reg.test(sample)) {
        weakCount++;
        break;
      }
    }
  }
  score += Math.min(weakCount * 0.1, 0.4);

  // Penalties: demote score for conflicting signals
  for (const reg of signals.penalty) {
    for (const sample of samples) {
      if (reg.test(sample)) {
        score -= PENALTY_WEIGHT;
        break;
      }
    }
  }

  return {
    score:          Math.max(0, Math.min(1, score)),
    hadStrongSignal,
  };
}

// ─────────────────────────────────────────────
// JSON completeness check
// ─────────────────────────────────────────────

function _looksLikeCompleteJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const first = trimmed[0];
  const last  = trimmed[trimmed.length - 1];
  return (first === "{" && last === "}") || (first === "[" && last === "]");
}

// ─────────────────────────────────────────────
// Main classifier
// ─────────────────────────────────────────────

function _classify(text) {
  const samples = getSamples(text);

  // ── JSON fast-path ──
  const firstSample = samples[0];
  const trimmedHead = firstSample.trim();
  if (
    (trimmedHead.startsWith("{") || trimmedHead.startsWith("[")) &&
    _looksLikeCompleteJson(text)
  ) {
    const { score: jsonScore } = calculateScore(samples, "json");
    const { score: codeScore } = calculateScore(samples, "code");
    if (jsonScore > codeScore) return "json";
  }

  // ── Full scoring — CD-4: capture hadStrongSignal from code result ──
  const scores           = {};
  let codeHadStrongSignal = false;

  for (const type of Object.keys(SIGNALS)) {
    const { score, hadStrongSignal } = calculateScore(samples, type);
    scores[type] = score;
    if (type === "code" && hadStrongSignal) {
      codeHadStrongSignal = true;
    }
  }

  // ── Code override ──
  // A file with module-level import/export/function/class is always code.
  // Only diff and json can beat it, and only by a significant margin.
  if (codeHadStrongSignal) {
    const codeScore = scores.code;
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
// Cache key
//
// CD-1: Now includes content length so two files with identical first
//       512 chars but different lengths get different cache keys.
//       Common case: multiple controller files from the same project
//       sharing the same standard import header.
// ─────────────────────────────────────────────

function _cacheKey(text) {
  return crypto
    .createHash("md5")
    .update(`${text.length}:${text.slice(0, 512)}`)
    .digest("hex")
    .slice(0, 16);
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

// Stub preserved for interface compatibility — previously was Magika init
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