/**
 * semanticResolver.js — Candidate-and-Rank Pipeline
 *
 * resolve(query) flow:
 *   1. Normalize query
 *   2. Soft-classify → determines which indexes are PRIMARY vs SECONDARY
 *   3. Run primary index (always) + secondary indexes (conditionally)
 *   4. Score each candidate based on match quality + index relevance
 *   5. Deduplicate by (name, file, startLine)
 *   6. Sort by score descending
 *   7. Return unified results
 */

import {
  queryFindSymbol,
  queryFindSymbolFuzzy,
  queryFindRoutes,
  queryFindLiteral,
  queryFindConfig,
  queryNodeByStableId,
} from "./graphDb.js";

// ─────────────────────────────────────────────
// Soft classifier — returns weights, not gates
// ─────────────────────────────────────────────

export const QueryKind = {
  ROUTE: "route",
  ENV_VAR: "env_var",
  SYMBOL: "symbol",
  LITERAL: "literal",
};

/**
 * Returns { primary, secondaries } where:
 *   primary    = the most likely index
 *   secondaries = other indexes worth checking
 */
function softClassify(q) {
  // Route: METHOD /path or bare /path
  if (/^(GET|POST|PUT|PATCH|DELETE|ANY)\s+\//i.test(q) || (q.startsWith("/") && q.length > 1)) {
    return {
      primary: QueryKind.ROUTE,
      secondaries: [], // routes don't overlap with other indexes
    };
  }

  // Env var: process.env.X or SCREAMING_SNAKE (3+ chars, all caps+underscore)
  if (/^process\.env\.[A-Z_]+$/.test(q) || /^[A-Z][A-Z0-9_]{2,}$/.test(q)) {
    return {
      primary: QueryKind.ENV_VAR,
      secondaries: [QueryKind.SYMBOL], // might be a module-level const too
    };
  }

  // Pure identifier: camelCase, PascalCase, snake_case
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(q)) {
    return {
      primary: QueryKind.SYMBOL,
      secondaries: [QueryKind.LITERAL], // might appear as a string literal too
    };
  }

  // Contains hyphens, spaces, dots — string literal / header / path
  if (q.includes("-") || q.includes(" ") || q.includes(".")) {
    return {
      primary: QueryKind.LITERAL,
      secondaries: [QueryKind.SYMBOL], // unlikely but cheap to check
    };
  }

  // Default: treat as symbol with literal as secondary
  return {
    primary: QueryKind.SYMBOL,
    secondaries: [QueryKind.LITERAL],
  };
}

// ─────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────

/**
 * Score a candidate result.
 *
 * Factors:
 *   - Exact vs partial match (most important)
 *   - Index relevance (did it come from the right index for this query?)
 *   - Is exported (slight boost — exported symbols are more likely what user wants)
 *   - Complexity (slight boost — complex functions are more interesting)
 */
function scoreCandidate(candidate, originalQuery, queryKind) {
  const q = originalQuery.toLowerCase();
  let score = 0;

  const name = (candidate.name || candidate.value || candidate.key || "").toLowerCase();
  const route = (candidate.route || "").toLowerCase();

  // ── Match quality ──
  if (name === q || route === q) {
    score += 1.0; // exact match
  } else if (name.startsWith(q) || route.startsWith(q)) {
    score += 0.7; // prefix match
  } else if (name.includes(q) || route.includes(q)) {
    score += 0.5; // substring match
  } else {
    score += 0.2; // fuzzy / indirect
  }

  // ── Index relevance bonus ──
  // Reward candidates that came from the index most appropriate for this query
  const indexMatch = {
    [QueryKind.SYMBOL]: ["symbol"],
    [QueryKind.ENV_VAR]: ["env_var", "symbol"],
    [QueryKind.LITERAL]: ["literal"],
    [QueryKind.ROUTE]: ["route"],
  };

  const preferredTypes = indexMatch[queryKind] || [];
  if (preferredTypes.includes(candidate.type)) {
    score += 0.15;
  }

  // ── Exported bonus ──
  if (candidate.isExported) score += 0.05;

  // ── Complexity signal (log scale to avoid domination) ──
  if (candidate.complexity > 0) {
    score += Math.min(0.1, Math.log(candidate.complexity + 1) * 0.03);
  }

  return Math.min(score, 2.0); // cap at 2.0
}

// ─────────────────────────────────────────────
// Deduplication key
// ─────────────────────────────────────────────

function dedupKey(candidate) {
  const name = candidate.name || candidate.value || candidate.key || candidate.route || "";
  const file = candidate.file || candidate.source_file || "";
  const line = candidate.startLine ?? candidate.line ?? 0;
  const kind = candidate.kind || candidate.type || ""; // ← fixes same-name-same-line edge case
  return `${name}|${file}|${line}|${kind}`;
}

// ─────────────────────────────────────────────
// Index runners — each returns normalized candidates
// ─────────────────────────────────────────────

function runSymbolIndex(query) {
  // Exact first, fuzzy fallback
  let rows = queryFindSymbol(query);
  let isFuzzy = false;

  if (rows.length === 0) {
    rows = queryFindSymbolFuzzy(query);
    isFuzzy = rows.length > 0;
  }

  return rows.map((r) => {
    let signature = null;
    if (r.body_text) {
      signature = r.body_text.split("\n")[0].trim();
      if (signature.length > 120) signature = signature.slice(0, 120) + "...";
    }
    return {
      type: "symbol",
      name: r.name,
      kind: r.kind,
      file: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      complexity: r.complexity || 0,
      isExported: r.is_exported === 1,
      signature,
      calls: r.call_summary ? tryParseJson(r.call_summary) : [],
      literalRefs: r.literal_refs ? tryParseJson(r.literal_refs) : [],
      envRefs: r.env_refs ? tryParseJson(r.env_refs) : [],
      fuzzy: isFuzzy,
      // body intentionally omitted — use read_function()
    };
  });
}

function runLiteralIndex(query) {
  const rows = queryFindLiteral(query);
  return rows.map((r) => {
    const res = {
      type: "literal",
      value: r.value,
      literalKind: r.kind,
      file: r.file_path,
      line: r.start_line,
      usedIn: r.containing_fn,
    };

    // 1-hop: include containing function metadata if available
    if (r.containing_fn && r.fn_start_line != null) {
      let signature = null;
      if (r.fn_body) {
        signature = r.fn_body.split("\n")[0].trim();
        if (signature.length > 120) signature = signature.slice(0, 120) + "...";
      }
      res.containing_function = {
        name: r.containing_fn,
        file: r.file_path,
        startLine: r.fn_start_line,
        endLine: r.fn_end_line,
        complexity: r.fn_complexity || 0,
        signature,
        // body intentionally omitted — use read_function()
      };
    }
    return res;
  });
}

function runConfigIndex(query) {
  const rows = queryFindConfig(query);
  return rows.map((r) => {
    const res = {
      type: "env_var",
      key: r.key,
      raw: r.raw_text,
      file: r.file_path,
      line: r.start_line,
      usedIn: r.containing_fn,
    };

    // 1-hop: include containing function metadata if available
    if (r.containing_fn && r.fn_start_line != null) {
      let signature = null;
      if (r.fn_body) {
        signature = r.fn_body.split("\n")[0].trim();
        if (signature.length > 120) signature = signature.slice(0, 120) + "...";
      }
      res.containing_function = {
        name: r.containing_fn,
        file: r.file_path,
        startLine: r.fn_start_line,
        endLine: r.fn_end_line,
        complexity: r.fn_complexity || 0,
        signature,
        // body intentionally omitted — use read_function()
      };
    }
    return res;
  });
}

function runRouteIndex(query) {
  const rows = queryFindRoutes(query);
  return rows.map((r) => ({
    type: "route",
    route: r.route_path,
    file: r.source_file,
    line: r.source_line,
    handler: r.handler,
  }));
}

// ─────────────────────────────────────────────
// Safe JSON parse
// ─────────────────────────────────────────────

function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────
// Main resolver
// ─────────────────────────────────────────────

/**
 * Resolve a query against the appropriate indexes.
 * Uses candidate-and-rank: multiple indexes, scored, deduped, sorted.
 *
 * @param {string} query
 * @returns {{ kind, strategy, results, found }}
 */
export function resolve(query) {
  const cleanQuery = query.replace(/^["'`]|["'`]$/g, "").trim();
  if (!cleanQuery) {
    return { kind: "empty", strategy: "none", results: [], found: false };
  }

  const { primary, secondaries } = softClassify(cleanQuery);

  // ── Run indexes ──
  const allCandidates = [];

  // Always run primary
  switch (primary) {
    case QueryKind.SYMBOL:
      allCandidates.push(...runSymbolIndex(cleanQuery));
      break;
    case QueryKind.LITERAL:
      allCandidates.push(...runLiteralIndex(cleanQuery));
      break;
    case QueryKind.ENV_VAR:
      allCandidates.push(...runConfigIndex(cleanQuery));
      break;
    case QueryKind.ROUTE:
      allCandidates.push(...runRouteIndex(cleanQuery));
      break;
  }

  // Run secondaries only if primary found nothing OR secondaries are cheap
  const primaryFoundSomething = allCandidates.length > 0;

  for (const secondary of secondaries) {
    // Skip secondary if primary found exact matches — saves DB round trips
    if (primaryFoundSomething) {
      const hasExact = allCandidates.some((c) => {
        const name = (c.name || c.value || c.key || "").toLowerCase();
        return name === cleanQuery.toLowerCase();
      });
      if (hasExact) continue; // exact match in primary — secondary won't beat it
    }

    switch (secondary) {
      case QueryKind.SYMBOL:
        allCandidates.push(...runSymbolIndex(cleanQuery));
        break;
      case QueryKind.LITERAL:
        allCandidates.push(...runLiteralIndex(cleanQuery));
        break;
      case QueryKind.ENV_VAR:
        allCandidates.push(...runConfigIndex(cleanQuery));
        break;
    }
  }

  // ── Score ──
  const scored = allCandidates.map((c) => ({
    ...c,
    _score: scoreCandidate(c, cleanQuery, primary),
  }));

  // ── Deduplicate ──
  const seen = new Set();
  const deduped = scored.filter((c) => {
    const key = dedupKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Sort ──
  deduped.sort((a, b) => b._score - a._score);

  // ── Clean up internal fields ──
  const results = deduped.map(({ _score, ...rest }) => rest);

  // ── Strategy label for debugging ──
  const strategyLabel =
    secondaries.length > 0 && results.length > 0
      ? `${primary}+${secondaries.join("+")} (candidate-rank)`
      : primary;

  // TO:
  // ── Compute confidence from top score ──
  // Used by graphTools to decide whether to invoke semantic fallback.
  // Top score of 1.15+ (exact match + index bonus + exported) = high confidence.
  // Below 0.4 = weak match, semantic fallback should run.
  const topScore = deduped[0]?._score ?? 0;
  const confidence = results.length === 0 ? 0 : Math.min(topScore / 1.15, 1.0);

  return {
    kind: primary,
    strategy: strategyLabel,
    results,
    found: results.length > 0,
    confidence, // ← new
    needsSemanticFallback: confidence < 0.4, // ← new: hint for graphTools
  };
}

// ─────────────────────────────────────────────
// Embedding singleton
//
// Injected from workspaceMapper.js via setGraphEmbedder().
// Kept here (not in workspaceMapper) so graphTools.js can import
// resolveWithEmbeddings without creating a circular dependency:
//   graphTools → semanticResolver → graphDb  ✅
//   graphTools → workspaceMapper → graphTools ❌ (circular)
// ─────────────────────────────────────────────

let _embedder = null;
let _retriever = null;

/**
 * Wire embedder + retriever into the resolver.
 * Called from workspaceMapper.setSymbolEmbedder() which is called from server.js.
 */
export function setGraphEmbedder(embedder, retriever) {
  _embedder = embedder;
  _retriever = retriever;
}

export function getGraphEmbedder() {
  return { embedder: _embedder, retriever: _retriever };
}

// ─────────────────────────────────────────────
// Async semantic fallback
//
// Called by graphTools when resolve() returns confidence < 0.4.
// Mirrors vaultRetriever.js Tier 1 hybridSearch pattern exactly.
//
// Flow:
//   1. Embed the query text via OnnxEmbedder
//   2. hybridSearch → HNSW dense + BM25 sparse combined
//   3. hits contain stableIds ("file:line:name")
//   4. Parse stableId → queryNodeByStableId → full node record
//   5. Return formatted symbol results
// ─────────────────────────────────────────────

/**
 * Semantic fallback using HNSW + BM25 hybrid search.
 * Only called when SQLite indexes return low-confidence results.
 *
 * @param {string} query
 * @returns {Promise<{ results: Array, strategy: string }>}
 */
export async function resolveWithEmbeddings(query) {
  if (!_embedder || !_retriever) {
    return { results: [], strategy: "embeddings:unavailable" };
  }

  try {
    // 1. Embed the query
    const queryEmbedding = await _embedder.embed(query);
    if (!queryEmbedding) {
      return { results: [], strategy: "embeddings:no_vector" };
    }

    // Float32Array coercion — embed() may return a regular array
    const float32Query =
      queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding);

    // 2. Hybrid search — same API as vaultRetriever.js Tier 1
    // threshold: 0.35 (lower than vault's 0.5 — symbol names are short,
    //            similarity scores are naturally lower)
    const hits = _retriever.hybridSearch(
      float32Query,
      8, // topK — fetch more than needed, filter by threshold below
      0.35, // threshold
      query // BM25 query text
    );

    if (!hits || hits.length === 0) {
      return { results: [], strategy: "embeddings:miss" };
    }

    // 3. Resolve stableIds → node records
    const results = [];
    const seen = new Set();

    for (const hit of hits) {
      if (hit.combinedScore < 0.35) continue;

      // stableId format: "filePath:startLine:name"
      // queryNodeByStableId handles the parsing
      const node = queryNodeByStableId(hit.id);
      if (!node) continue;

      // Dedup — same node might appear via both dense and sparse paths
      const key = `${node.name}|${node.file_path}|${node.start_line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let signature = null;
      if (node.body_text) {
        signature = node.body_text.split("\n")[0].trim();
        if (signature.length > 120) signature = signature.slice(0, 120) + "...";
      }

      results.push({
        type: "symbol",
        name: node.name,
        kind: node.kind,
        file: node.file_path,
        startLine: node.start_line,
        endLine: node.end_line,
        complexity: node.complexity || 0,
        isExported: node.is_exported === 1,
        signature,
        calls: tryParseJson(node.call_summary),
        literalRefs: tryParseJson(node.literal_refs),
        envRefs: tryParseJson(node.env_refs),
        _semanticScore: hit.combinedScore, // kept for unified ranking in graphTools
      });
    }

    const strategy =
      results.length > 0
        ? `embeddings:hybrid(${results.length} hits, top=${hits[0]?.combinedScore?.toFixed(2)})`
        : "embeddings:below_threshold";

    return { results, strategy };
  } catch (err) {
    if (process.env.CF_DEBUG_GRAPH === "1") {
      console.warn(`[SemanticResolver] Embedding fallback failed: ${err.message}`);
    }
    return { results: [], strategy: "embeddings:error" };
  }
}

export function normalizeConceptKey(query) {
  // Step 1: Split on word boundaries — handles camelCase, hyphen, underscore, space
  // "contentLength"  → ["content", "length"]
  // "content-length" → ["content", "length"]
  // "content length" → ["content", "length"]
  // "STORAGE_QUOTA"  → ["storage", "quota"]
  // "storageQuota"   → ["storage", "quota"]
  // "user_id"        → ["user", "id"]
  // "userId"         → ["user", "id"]  ← still same, but short so guarded below

  const tokens = String(query)
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase split: contentLength → content Length
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTTPSRequest → HTTPS Request
    .toLowerCase()
    .split(/[-_\s.]+/) // split on separators
    .filter((t) => t.length > 0);

  // Step 2: Sort tokens so order doesn't matter
  // "quota storage" == "storage quota" after sort
  // (optional — disable if order matters for your queries)
  // tokens.sort();  ← keep commented out for now, order usually matters

  const key = tokens.join("");

  // Step 3: Minimum token length guard
  // Single short tokens ("id", "url", "get") are too ambiguous to merge
  if (tokens.length === 1 && tokens[0].length < 5) {
    return query.toLowerCase(); // don't normalize — return as-is
  }

  return key;
}
