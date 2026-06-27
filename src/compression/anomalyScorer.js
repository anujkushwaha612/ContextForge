/**
 * anomalyScorer.js
 *
 * JS layer over the C++ anomaly detection engine.
 *
 * Responsibilities:
 *   - Walk extracted JSON nodes and group numeric values by field name
 *   - Call C++ detectAnomaliesBatch (single boundary crossing for all fields)
 *   - Map anomalous item indices back to node indices in the original array
 *   - Return a Set<nodeIndex> of always-keep nodes for sliceJsonOutput
 *
 * What stays in JS (not worth C++ boundary cost):
 *   - JSON node grouping (Map operations, string comparisons)
 *   - Error path detection (regex on string values)
 *   - Score integration with keyword scorer
 *
 * What lives in C++ (numeric math, O(n) per field):
 *   - Mean, std, percentiles, IQR
 *   - Z-score per value
 *   - CUSUM changepoint detection
 *   - IQR fence outlier detection
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const native  = require("../../native/build/Release/contextforge_native.node");

// ─────────────────────────────────────────────
// Error signal patterns — always keep these
// regardless of anomaly score
// ─────────────────────────────────────────────

const ERROR_VALUE_PATTERNS = [
  /\berror\b/i,
  /\bfail(?:ed|ure)?\b/i,
  /\bexception\b/i,
  /\btimeout\b/i,
  /\bnull\b/i,
  /\bundefined\b/i,
];

const ERROR_STATUS_CODES = new Set([
  400, 401, 403, 404, 408, 409, 422, 429,
  500, 502, 503, 504,
]);

// ─────────────────────────────────────────────
// Numeric field extraction
// ─────────────────────────────────────────────

/**
 * Given a flat list of JSON nodes (from extractJsonNodes in jsonSlicer.js),
 * groups them by their leaf field name and extracts numeric values.
 *
 * Only works on arrays-of-objects patterns — the dominant case in API
 * responses (log entries, metrics, search results, etc.)
 *
 * Example:
 *   nodes = [
 *     { path: "$[0].latency_ms", value: 42 },
 *     { path: "$[1].latency_ms", value: 8400 },
 *     { path: "$[0].status",     value: 200 },
 *     { path: "$[1].status",     value: 500 },
 *   ]
 *
 *   Returns:
 *   {
 *     latency_ms: { values: [42, 8400], itemIndices: [0, 1] },
 *     status:     { values: [200, 500], itemIndices: [0, 1] },
 *   }
 *
 * @param {Array<{path: string, value: any, leaf: boolean}>} nodes
 * @returns {Map<string, {values: number[], nodeIndices: number[]}>}
 */
function extractNumericFields(nodes) {
  // Map: fieldName → { values: number[], nodeIndices: number[] }
  const fieldMap = new Map();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    // Only leaf nodes with numeric values
    if (!node.leaf) continue;
    if (typeof node.value !== "number" || !isFinite(node.value)) continue;

    // Extract the field name from the path
    // "$[42].latency_ms" → "latency_ms"
    // "$.results[3].score" → "score"
    const fieldName = extractFieldName(node.path);
    if (!fieldName) continue;

    if (!fieldMap.has(fieldName)) {
      fieldMap.set(fieldName, { values: [], nodeIndices: [] });
    }

    const entry = fieldMap.get(fieldName);
    entry.values.push(node.value);
    entry.nodeIndices.push(i);
  }

  // Only return fields with enough data for statistical analysis
  const result = new Map();
  for (const [name, entry] of fieldMap) {
    if (entry.values.length >= 5) {
      result.set(name, entry);
    }
  }

  return result;
}

/**
 * Extract the leaf field name from a JSON path string.
 * @param {string} path - e.g. "$[42].latency_ms" or "$.data.items[3].score"
 * @returns {string|null}
 */
function extractFieldName(path) {
  if (!path || typeof path !== "string") return null;

  // Match the last ".fieldName" or last "[fieldName]" segment
  const dotMatch = path.match(/\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (dotMatch) return dotMatch[1];

  // Array index only path like "$[3]" — use parent field
  const bracketMatch = path.match(/\.([a-zA-Z_][a-zA-Z0-9_]*)\[\d+\]$/);
  if (bracketMatch) return bracketMatch[1];

  return null;
}

// ─────────────────────────────────────────────
// Error node detection (non-numeric)
// ─────────────────────────────────────────────

/**
 * Detect nodes that are errors based on string value patterns
 * or HTTP status codes — these are always-keep regardless of score.
 *
 * @param {Array} nodes
 * @returns {Set<number>} node indices to always keep
 */
function detectErrorNodes(nodes) {
  const errorIndices = new Set();

  for (let i = 0; i < nodes.length; i++) {
    const { path, value } = nodes[i];

    if (typeof value === "string") {
      if (ERROR_VALUE_PATTERNS.some(p => p.test(value))) {
        errorIndices.add(i);
        continue;
      }
    }

    if (typeof value === "number") {
      if (ERROR_STATUS_CODES.has(value)) {
        // Check if the field name looks like a status field
        const fieldName = extractFieldName(path) || "";
        if (/status|code|http|response/i.test(fieldName)) {
          errorIndices.add(i);
          // Also flag sibling nodes in the same array item
          // (the entire record containing the error is relevant)
          const itemPrefix = path.replace(/\.[^.[\]]+$/, "");
          for (let j = 0; j < nodes.length; j++) {
            if (j !== i && nodes[j].path.startsWith(itemPrefix)) {
              errorIndices.add(j);
            }
          }
        }
      }
    }
  }

  return errorIndices;
}

// ─────────────────────────────────────────────
// First/Last preservation
// ─────────────────────────────────────────────

/**
 * Keep first N and last N items from each array-structured field.
 * This preserves the narrative arc of time-series data.
 *
 * @param {Array} nodes
 * @param {number} n - items to keep from head and tail
 * @returns {Set<number>} node indices to keep
 */
function detectFirstLastNodes(nodes, n = 2) {
  const keepIndices = new Set();

  // Group nodes by their parent array path
  // "$[0].field" → parent is "$"
  // "$.results[3].field" → parent is "$.results"
  const byParent = new Map();

  for (let i = 0; i < nodes.length; i++) {
    const parent = getArrayParent(nodes[i].path);
    if (!parent) continue;

    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push({ nodeIdx: i, path: nodes[i].path });
  }

  for (const [parent, group] of byParent) {
    if (group.length < n * 2 + 5) {
      // Too small to warrant head/tail — keep all
      for (const { nodeIdx } of group) keepIndices.add(nodeIdx);
      continue;
    }

    // Sort by array index extracted from path
    group.sort((a, b) => {
      const idxA = extractArrayIndex(a.path, parent);
      const idxB = extractArrayIndex(b.path, parent);
      return idxA - idxB;
    });

    // Keep first n and last n
    for (let i = 0; i < Math.min(n, group.length); i++) {
      keepIndices.add(group[i].nodeIdx);
    }
    for (let i = Math.max(0, group.length - n); i < group.length; i++) {
      keepIndices.add(group[i].nodeIdx);
    }
  }

  return keepIndices;
}

function getArrayParent(path) {
  const match = path.match(/^(.*)\[\d+\]/);
  return match ? match[1] : null;
}

function extractArrayIndex(path, parentPrefix) {
  const suffix = path.slice(parentPrefix.length);
  const match = suffix.match(/^\[(\d+)\]/);
  return match ? parseInt(match[1], 10) : 0;
}

// ─────────────────────────────────────────────
// Main export: scoreNodesByAnomaly
// ─────────────────────────────────────────────

/**
 * Scores all nodes in a JSON node array using statistical anomaly detection.
 * Returns a Set of node indices that should ALWAYS be kept (regardless of K).
 *
 * Called from sliceJsonOutput in jsonSlicer.js to augment the keyword scorer.
 *
 * @param {Array<{path: string, value: any, leaf: boolean}>} nodes
 * @param {object} options
 * @param {number} [options.zThreshold=2.0]      - Z-score threshold for anomaly
 * @param {number} [options.iqrMultiplier=1.5]   - IQR multiplier for fence
 * @param {number} [options.firstLastN=2]         - Head/tail items to preserve
 * @returns {{
 *   alwaysKeep: Set<number>,
 *   anomalyStats: Map<string, object>,
 *   detectionSummary: string
 * }}
 */
export function scoreNodesByAnomaly(nodes, options = {}) {
  const {
    zThreshold    = 2.0,
    iqrMultiplier = 1.5,
    firstLastN    = 2,
  } = options;

  const alwaysKeep = new Set();
  const anomalyStats = new Map();

  if (!nodes || nodes.length < 5) {
    return {
      alwaysKeep,
      anomalyStats,
      detectionSummary: "too few nodes",
    };
  }

  // ── Pass 1: Error nodes (string/status based) — pure JS ──
  const errorNodes = detectErrorNodes(nodes);
  for (const idx of errorNodes) alwaysKeep.add(idx);

  // ── Pass 2: First/Last preservation — pure JS ──
  const firstLastNodes = detectFirstLastNodes(nodes, firstLastN);
  for (const idx of firstLastNodes) alwaysKeep.add(idx);

  // ── Pass 3: Statistical anomaly detection — C++ ──
  const numericFields = extractNumericFields(nodes);

  if (numericFields.size > 0) {
    // Build the batch input object for C++
    // Single JS→C++ boundary crossing for ALL fields
    const batchInput = {};
    for (const [fieldName, { values }] of numericFields) {
      batchInput[fieldName] = values;
    }

    let batchResult = null;
    try {
      batchResult = native.detectAnomaliesBatch(
        batchInput,
        zThreshold,
        iqrMultiplier,
      );
    } catch (err) {
      console.warn(`[AnomalyScorer] C++ batch detection failed: ${err.message}`);
    }

    if (batchResult) {
      // Map anomaly item-indices back to node indices
      for (const [fieldName, { nodeIndices }] of numericFields) {
        const fieldResult = batchResult[fieldName];
        if (!fieldResult) continue;

        const { anomalyIndices, stats } = fieldResult;
        anomalyStats.set(fieldName, stats);

        for (const itemIdx of anomalyIndices) {
          if (itemIdx < nodeIndices.length) {
            const nodeIdx = nodeIndices[itemIdx];
            alwaysKeep.add(nodeIdx);

            // Also keep the parent record's sibling nodes
            // e.g. if latency_ms at index 42 is anomalous, keep all
            // fields from item 42 (status, endpoint, timestamp, etc.)
            const anomalousPath = nodes[nodeIdx].path;
            const itemPrefix    = getArrayParent(anomalousPath);
            if (itemPrefix) {
              const itemIdxInPath = extractArrayIndex(anomalousPath, itemPrefix);
              for (let ni = 0; ni < nodes.length; ni++) {
                if (
                  nodes[ni].path.startsWith(itemPrefix) &&
                  extractArrayIndex(nodes[ni].path, itemPrefix) === itemIdxInPath
                ) {
                  alwaysKeep.add(ni);
                }
              }
            }
          }
        }
      }
    }
  }

  // ── Build summary for logging ──
  const fieldSummaries = [];
  for (const [fieldName, stats] of anomalyStats) {
    fieldSummaries.push(
      `${fieldName}(μ=${stats.mean.toFixed(1)},σ=${stats.stddev.toFixed(1)})`
    );
  }

  const detectionSummary =
    `${alwaysKeep.size} nodes always-keep | ` +
    `${errorNodes.size} errors | ` +
    `${firstLastNodes.size} head/tail | ` +
    `${numericFields.size} numeric fields analyzed` +
    (fieldSummaries.length > 0 ? ` [${fieldSummaries.slice(0, 3).join(", ")}]` : "");

  return { alwaysKeep, anomalyStats, detectionSummary };
}

/**
 * Get stats for a single field — useful for testing and debugging.
 * @param {number[]} values
 * @returns {object} FieldStats
 */
export function getFieldStats(values) {
  try {
    return native.computeFieldStats(values);
  } catch (err) {
    console.warn(`[AnomalyScorer] computeFieldStats failed: ${err.message}`);
    return null;
  }
}