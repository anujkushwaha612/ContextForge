// src/compression/adaptiveSizer.js

import zlib from "node:zlib";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const native = require("../../native/build/Release/contextforge_native.node");

// ─────────────────────────────────────────────
// SimHash — now delegates to C++ native binding
// Falls back to JS if native unavailable (dev mode)
// ─────────────────────────────────────────────

function nativeCountUniqueSimhash(items, threshold) {
  try {
    // Single C++ call replaces N * len(item) MD5 calls
    return native.countUniqueSimhash(items, threshold);
  } catch (err) {
    // Fallback: pure JS (original implementation)
    console.warn("[AdaptiveSizer] Native SimHash unavailable, using JS fallback:", err.message);
    return jsCountUniqueSimhash(items, threshold);
  }
}

// JS fallback (kept for dev environments without native build)
function jsSimhash(text) {
  // Lightweight JS version using djb2 instead of MD5
  // Good enough for fallback, not as accurate
  const lower = text.toLowerCase();
  const v = new Int32Array(32);

  for (let i = 0; i < Math.max(1, lower.length - 3); i++) {
    let h = 5381;
    for (let k = i; k < i + 4 && k < lower.length; k++) {
      h = ((h << 5) + h) ^ lower.charCodeAt(k);
    }
    h = h >>> 0; // unsigned
    for (let b = 0; b < 32; b++) {
      v[b] += (h >> b) & 1 ? 1 : -1;
    }
  }

  let fp = 0n;
  for (let b = 0; b < 32; b++) {
    if (v[b] > 0) fp |= 1n << BigInt(b);
  }
  return fp;
}

function jsHammingDistance(a, b) {
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) { count += Number(xor & 1n); xor >>= 1n; }
  return count;
}

function jsCountUniqueSimhash(items, threshold = 3) {
  const fps = items.map(i => jsSimhash(String(i)));
  const clusters = [];
  for (const fp of fps) {
    if (!clusters.some(r => jsHammingDistance(fp, r) <= threshold)) {
      clusters.push(fp);
    }
  }
  return clusters.length;
}

// ─────────────────────────────────────────────
// Bigram coverage curve (stays in JS — cheap)
// ─────────────────────────────────────────────

export function computeUniqueBigramCurve(items) {
  const seenBigrams = new Set();
  const curve = [];
  for (const item of items) {
    const words = String(item).toLowerCase().split(/\s+/);
    if (words.length < 2) {
      seenBigrams.add(`${words[0] || ""}_`);
    } else {
      for (let j = 0; j < words.length - 1; j++) {
        seenBigrams.add(`${words[j]}_${words[j + 1]}`);
      }
    }
    curve.push(seenBigrams.size);
  }
  return curve;
}

// ─────────────────────────────────────────────
// Kneedle algorithm (stays in JS — pure math)
// ─────────────────────────────────────────────

export function findKnee(curve) {
  const n = curve.length;
  if (n < 3) return null;

  const yMin = curve[0];
  const yMax = curve[n - 1];
  if (yMax === yMin) return 1;

  const xRange = n - 1;
  const yRange = yMax - yMin;

  let maxDiff = -Infinity;
  let kneeIdx = null;

  for (let i = 0; i < n; i++) {
    const xNorm = i / xRange;
    const yNorm = (curve[i] - yMin) / yRange;
    const diff = yNorm - xNorm;
    if (diff > maxDiff) {
      maxDiff = diff;
      kneeIdx = i;
    }
  }

  if (maxDiff < 0.05) return null;
  return kneeIdx !== null ? kneeIdx + 1 : null;
}

// ─────────────────────────────────────────────
// zlib validation (stays in JS — I/O not CPU)
// ─────────────────────────────────────────────

function validateWithZlib(items, k, maxK, tolerance = 0.15) {
  if (k >= items.length || k >= maxK) return k;

  const fullText   = Buffer.from(items.join("\n"));
  const subsetText = Buffer.from(items.slice(0, k).join("\n"));

  if (fullText.length < 200) return k;

  const fullRatio   = zlib.deflateRawSync(fullText,   { level: 1 }).length / fullText.length;
  const subsetRatio = zlib.deflateRawSync(subsetText, { level: 1 }).length / subsetText.length;
  const ratioDiff   = Math.abs(fullRatio - subsetRatio);

  if (ratioDiff > tolerance) {
    const adjustedK = Math.min(Math.floor(k * 1.2), maxK);
    console.log(
      `[Adaptive Sizer] zlib validation: ratio_diff=${ratioDiff.toFixed(3)} > ${tolerance}, ` +
      `adjusting k=${k} → ${adjustedK}`
    );
    return adjustedK;
  }

  return k;
}

// ─────────────────────────────────────────────
// Main entry point — now policy-aware
// ─────────────────────────────────────────────

/**
 * @param {string[]} items   - Items in importance order
 * @param {object}   policy  - From getPolicyForModel() — optional
 *                             Falls back to hardcoded defaults if omitted
 */
export function computeOptimalK(items, policy = null) {
  const n = items.length;

  // Extract policy values with fallbacks
  const bias      = policy?.adaptiveSizerBias    ?? 1.0;
  const minK      = policy?.adaptiveSizerMinK    ?? 3;
  const maxK      = policy?.adaptiveSizerMaxK    ?? null;
  const threshold = policy?.simhashThreshold     ?? 3;

  const effectiveMax = maxK !== null ? Math.min(maxK, n) : n;

  // Trivial cases
  if (n <= 8) return Math.min(n, effectiveMax);

  // Tier 1: Native SimHash (C++ — ~200x faster than old MD5 version)
  const uniqueCount = nativeCountUniqueSimhash(
    items.map(String),
    threshold
  );

  if (uniqueCount <= 3) {
    return Math.min(Math.max(minK, uniqueCount), effectiveMax);
  }

  // Tier 2: Kneedle on bigram coverage
  const curve = computeUniqueBigramCurve(items);
  let knee = findKnee(curve);

  const diversityRatio = uniqueCount / n;

  if (knee === null) {
    const keepFraction = 0.3 + 0.7 * diversityRatio;
    knee = Math.max(minK, Math.floor(n * keepFraction));
  } else {
    if (diversityRatio > 0.7) {
      const diversityFloor = Math.max(
        minK,
        Math.floor(n * (0.3 + 0.7 * diversityRatio))
      );
      knee = Math.max(knee, diversityFloor);
    }
  }

  // Apply bias
  let k = Math.max(minK, Math.floor(knee * bias));
  k = Math.min(k, effectiveMax);

  // Tier 3: zlib sanity check
  if (maxK !== null) {
    k = validateWithZlib(items.map(String), k, effectiveMax);
  }

  k = Math.max(minK, Math.min(k, effectiveMax));

  console.log(
    `[Adaptive Sizer] n=${n} unique=${uniqueCount} ` +
    `diversity=${diversityRatio.toFixed(2)} knee=${knee} ` +
    `bias=${bias}(${policy?.mode ?? "default"}) → k=${k}`
  );

  return k;
}