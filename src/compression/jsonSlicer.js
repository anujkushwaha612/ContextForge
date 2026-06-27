import { saveToVault } from "../logging/cacheDb.js";
import { computeOptimalK } from "./adaptiveSizer.js";
import { scoreNodesByAnomaly } from "./anomalyScorer.js";

// ============================================================
// PHASE 2, FEATURE 4: VECTOR-GUIDED JSON SLICER
// ============================================================

/**
 * Walks a parsed JSON value and extracts all "meaningful" leaf nodes
 * with their key paths. A leaf is a primitive value (string, number, bool, null)
 * or an empty object/array.
 */
function extractJsonNodes(obj, prefix = "$") {
  const nodes = [];

  if (obj === null || obj === undefined) {
    nodes.push({ path: prefix, value: null, leaf: true });
    return nodes;
  }

  if (typeof obj !== "object") {
    // Primitive leaf
    nodes.push({ path: prefix, value: obj, leaf: true });
    return nodes;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      nodes.push({ path: prefix, value: [], leaf: true });
    } else {
      for (let i = 0; i < obj.length; i++) {
        const childPath = `${prefix}[${i}]`;
        const childNodes = extractJsonNodes(obj[i], childPath);
        nodes.push(...childNodes);
      }
    }
    return nodes;
  }

  // Object
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    nodes.push({ path: prefix, value: {}, leaf: true });
  } else {
    for (const key of keys) {
      const childPath = `${prefix}.${key}`;
      const childNodes = extractJsonNodes(obj[key], childPath);
      nodes.push(...childNodes);
    }
  }

  return nodes;
}

/**
 * Scores a JSON node against query keywords.
 * Higher score = more relevant to what the user is asking.
 */
function scoreJsonNode(nodePath, nodeValue, queryKeywords) {
  if (!queryKeywords || queryKeywords.length === 0) return 0;

  const pathLower = nodePath.toLowerCase();
  const valueStr = String(nodeValue ?? "").toLowerCase();
  const combined = pathLower + " " + valueStr;

  let score = 0;
  for (const kw of queryKeywords) {
    const kwLower = kw.toLowerCase();
    // Exact match in path is strongest signal
    if (pathLower.includes(kwLower)) {
      score += 3;
    }
    // Partial word boundary match
    const wordBoundary = new RegExp(`\\b${kwLower}\\b`, "i");
    if (wordBoundary.test(combined)) {
      score += 2;
    }
    // Substring match anywhere
    if (combined.includes(kwLower)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Always keep these paths regardless of relevance score.
 */
const ALWAYS_KEEP_PATTERNS = [
  /\berror\b/i,
  /\bfail(?:ed|ure)?\b/i,
  /\bwarn(?:ing)?\b/i,
  /\bexception\b/i,
  /\bstack\s*trace\b/i,
  /\bstatus\s*code\b/i,
  /\bmessage\b/i,
];

function isAlwaysKeep(path) {
  return ALWAYS_KEEP_PATTERNS.some((re) => re.test(path));
}

/**
 * Extracts query keywords from the conversation context.
 * Looks at the last user message to understand intent.
 */
function extractQueryKeywords(messages) {
  if (!messages || !Array.isArray(messages)) return [];

  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content =
        typeof messages[i].content === "string"
          ? messages[i].content
          : JSON.stringify(messages[i].content);
      // Extract meaningful words (3+ chars, not stopwords)
      const stopwords = new Set([
        "the",
        "and",
        "for",
        "are",
        "but",
        "not",
        "you",
        "all",
        "can",
        "had",
        "her",
        "was",
        "one",
        "our",
        "out",
        "has",
        "have",
        "from",
        "that",
        "this",
        "with",
        "what",
        "when",
        "where",
        "which",
        "will",
        "would",
        "there",
        "their",
        "about",
        "should",
        "could",
        "been",
        "being",
        "does",
        "doing",
        "each",
        "every",
        "they",
        "them",
        "then",
        "just",
        "like",
        "make",
        "more",
        "only",
        "over",
        "such",
        "than",
        "into",
        "also",
        "very",
        "your",
        "some",
        "said",
        "look",
        "here",
      ]);
      return (
        content
          .toLowerCase()
          .match(/\b[a-z]{3,}\b/g)
          ?.filter((w) => !stopwords.has(w))
          ?.slice(0, 20) || []
      );
    }
  }
  return [];
}

/**
 * Builds a compact representation of the kept nodes.
 */
function buildJsonSliceSummary(keptNodes, totalNodes, vaultId) {
  const lines = [
    `[ContextForge JSON Slice - ${keptNodes.length} of ${totalNodes} nodes kept]`,
    `Vault ID: \`${vaultId}\``,
    "",
  ];

  // Group by top-level path prefix
  const byPrefix = {};
  for (const node of keptNodes) {
    const topLevel = node.path.split(".")[0].replace(/\[\d+\]/, "");
    if (!byPrefix[topLevel]) byPrefix[topLevel] = [];
    byPrefix[topLevel].push(node);
  }

  for (const [prefix, nodes] of Object.entries(byPrefix)) {
    if (nodes.length > 5) {
      lines.push(`### ${prefix} (${nodes.length} relevant entries)`);
      for (const n of nodes.slice(0, 5)) {
        const valStr = String(n.value ?? "null").slice(0, 80);
        lines.push(`  ${n.path}: ${valStr}`);
      }
      lines.push(`  ... +${nodes.length - 5} more`);
    } else {
      lines.push(`### ${prefix}`);
      for (const n of nodes) {
        const valStr = String(n.value ?? "null").slice(0, 80);
        lines.push(`  ${n.path}: ${valStr}`);
      }
    }
  }

  lines.push("");
  lines.push(
    `To retrieve the full ${totalNodes}-node JSON, call: ` +
      `\`contextforge_retrieve(vault_id: "${vaultId}")\``,
  );

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// Robust JSON parser — handles NDJSON, truncated JSON,
// JSON with trailing commas, mixed content
// ─────────────────────────────────────────────
function robustJsonParse(text) {
  if (!text || typeof text !== "string") return null;

  // Strategy 1: strict parse
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Strategy 2: extract first complete JSON structure
  // handles "some text before {..." and "...} some text after"
  const structureMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (structureMatch) {
    try {
      return JSON.parse(structureMatch[1]);
    } catch (_) {}
  }

  // Strategy 3: NDJSON — each line is a separate JSON object
  const ndjsonResults = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      ndjsonResults.push(JSON.parse(trimmed));
    } catch (_) {}
  }
  if (ndjsonResults.length > 0) return ndjsonResults;

  // Strategy 4: truncated JSON — try closing it
  // Handles cases where tool output was cut off mid-stream
  const openBraces = (text.match(/\{/g) || []).length;
  const closeBraces = (text.match(/\}/g) || []).length;
  const openBracks = (text.match(/\[/g) || []).length;
  const closeBracks = (text.match(/\]/g) || []).length;

  if (openBraces > closeBraces || openBracks > closeBracks) {
    const padded =
      text +
      "}".repeat(Math.max(0, openBraces - closeBraces)) +
      "]".repeat(Math.max(0, openBracks - closeBracks));
    try {
      return JSON.parse(padded);
    } catch (_) {}
  }

  return null; // genuine failure — not JSON at all
}

export function sliceJsonOutput(text, messages = [], policy = null) {
  if (typeof text !== "string" || text.length === 0) {
    return { kept: text, vaulted: false };
  }

  const tokenEstimate = Math.floor(text.length / 4);
  console.log(`[JSON Slicer] 🔍 Analyzing ${tokenEstimate} token JSON...`);

  let parsed = robustJsonParse(text);
  if (parsed === null) {
    console.log(`[JSON Slicer] ❌ All parse strategies failed — skipping`);
    return { kept: text, vaulted: false };
  }

  const nodes = extractJsonNodes(parsed);
  console.log(`[JSON Slicer] Extracted ${nodes.length} leaf nodes`);

  if (nodes.length < 10) {
    return { kept: text, vaulted: false };
  }

  // ── Anomaly scorer (C++ backed) — replaces old ALWAYS_KEEP_PATTERNS ──
  const { alwaysKeep, detectionSummary } = scoreNodesByAnomaly(nodes, {
    zThreshold: 2.0,
    iqrMultiplier: 1.5,
    firstLastN: 2,
  });

  console.log(`[JSON Slicer] 🔬 Anomaly detection: ${detectionSummary}`);

  // ── Keyword scorer (unchanged) ──
  const queryKeywords = extractQueryKeywords(messages);
  const scored = nodes.map((node) => ({
    ...node,
    alwaysKeep: alwaysKeep.has(nodes.indexOf(node)),
    score: scoreJsonNode(node.path, node.value, queryKeywords),
  }));

  const alwaysKeepNodes = scored.filter((n) => n.alwaysKeep);
  const scoredOnly = scored
    .filter((n) => !n.alwaysKeep)
    .sort((a, b) => b.score - a.score);

  const itemStrings = nodes.map((n) => `${n.path} ${String(n.value ?? "")}`);

  // ── policy now passed in as parameter — no longer references outer payload ──
  const optimalK = computeOptimalK(itemStrings, policy ?? null);
  const topScored = scoredOnly.slice(0, optimalK);

  const keptSet = new Map();
  for (const n of [...alwaysKeepNodes, ...topScored]) {
    keptSet.set(n.path, n);
  }
  const keptNodes = [...keptSet.values()];

  const removalRatio = 1 - keptNodes.length / nodes.length;
  console.log(
    `[JSON Slicer] Keeping ${keptNodes.length}/${nodes.length} nodes ` +
      `(${(removalRatio * 100).toFixed(1)}% reduction)`,
  );

  if (removalRatio < 0.5) {
    return { kept: text, vaulted: false };
  }

  const vaultId = saveToVault(text);
  const summary = buildJsonSliceSummary(keptNodes, nodes.length, vaultId);

  return {
    kept: summary,
    vaulted: true,
    vaultId,
    originalText: text,
    keptNodeCount: keptNodes.length,
    totalNodeCount: nodes.length,
  };
}

export function sliceJsonToolResults(payload) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;

  // ── Extract policy once here and pass down into sliceJsonOutput ──
  const policy = payload?.__policy ?? null;

  let sliceStats = { sliced: 0, nodesKept: 0, nodesTotal: 0, charsSaved: 0 };

  payload.messages = payload.messages.map((msg) => {
    if (
      msg.role === "tool" &&
      typeof msg.content === "string" &&
      msg._cf_type === "json"
    ) {
      const beforeLen = msg.content.length;
      const result = sliceJsonOutput(msg.content, payload.messages, policy);

      if (result.vaulted) {
        sliceStats.sliced++;
        sliceStats.nodesKept += result.keptNodeCount || 0;
        sliceStats.nodesTotal += result.totalNodeCount || 0;
        sliceStats.charsSaved += beforeLen - result.kept.length;

        return {
          ...msg,
          content: result.kept,
          _slicedVaultId: result.vaultId,
        };
      }
      return msg;
    }

    // Anthropic content blocks
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((block) => {
          if (
            block.type === "tool_result" &&
            typeof block.content === "string" &&
            block._cf_type === "json"
          ) {
            const beforeLen = block.content.length;
            const result = sliceJsonOutput(
              block.content,
              payload.messages,
              policy,
            );
            if (result.vaulted) {
              sliceStats.sliced++;
              sliceStats.charsSaved += beforeLen - result.kept.length;
              return {
                ...block,
                content: result.kept,
                _slicedVaultId: result.vaultId,
              };
            }
            return block;
          }
          return block;
        }),
      };
    }

    return msg;
  });

  if (sliceStats.sliced > 0) {
    console.log(
      `[JSON Slicer Summary] Sliced ${sliceStats.sliced} JSON payloads | ` +
        `Nodes: ${sliceStats.nodesKept}/${sliceStats.nodesTotal} kept | ` +
        `Chars saved: ${sliceStats.charsSaved} (~${Math.floor(sliceStats.charsSaved / 4)} tokens)`,
    );
  }

  return payload;
}

