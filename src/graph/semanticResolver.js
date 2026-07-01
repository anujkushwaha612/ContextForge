/**
 * semanticResolver.js — Candidate-and-Rank Pipeline
 *
 * resolve(query) flow:
 *   1. Normalize query
 *   2. Soft-classify → determines which indexes are PRIMARY vs SECONDARY
 *   3. Run primary index (always) + secondary indexes (conditionally)
 *   4. Score each candidate based on match quality + index relevance
 *   5. Deduplicate by (name, file, startLine, kind)
 *   6. Sort by score descending
 *   7. Return unified results with computed confidence
 *
 * Fixes applied:
 *   SR-2: Route detection now catches paths without leading slash
 *         (e.g. "api/v1/users") via path-segment heuristic.
 *
 *   SR-4: resolveWithEmbeddings guards against missing hybridSearch method
 *         with a clear error log instead of silently returning empty.
 *
 *   SR-5: normalizeConceptKey sort enabled — word order variations now
 *         normalize to the same key. "quota storage" == "storage quota".
 *         This is correct for concept deduplication in the ghost interceptor
 *         where the goal is to detect semantically identical queries.
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
// Soft classifier
// ─────────────────────────────────────────────

export const QueryKind = {
  ROUTE:   "route",
  ENV_VAR: "env_var",
  SYMBOL:  "symbol",
  LITERAL: "literal",
};

/**
 * Returns { primary, secondaries } where:
 *   primary     = the most likely index
 *   secondaries = other indexes worth checking
 */
function softClassify(q) {
  // Route: METHOD /path
  if (/^(GET|POST|PUT|PATCH|DELETE|ANY)\s+\//i.test(q)) {
    return { primary: QueryKind.ROUTE, secondaries: [] };
  }

  // Route: leading slash /path
  if (q.startsWith("/") && q.length > 1) {
    return { primary: QueryKind.ROUTE, secondaries: [] };
  }

  // SR-2: Route: path-segment pattern without leading slash
  // e.g. "api/v1/users", "v1/chat/completions"
  // Must have at least one slash and look like a path (no dots that would
  // indicate a file extension, no spaces that would indicate a description).
  if (
    q.includes("/") &&
    !q.includes(".") &&
    !q.includes(" ") &&
    /^[a-zA-Z0-9_\-/]+$/.test(q)
  ) {
    return { primary: QueryKind.ROUTE, secondaries: [] };
  }

  // Env var: process.env.X or SCREAMING_SNAKE (3+ chars, all caps+underscore)
  if (/^process\.env\.[A-Z_]+$/.test(q) || /^[A-Z][A-Z0-9_]{2,}$/.test(q)) {
    return {
      primary:     QueryKind.ENV_VAR,
      secondaries: [QueryKind.SYMBOL],
    };
  }

  // Pure identifier: camelCase, PascalCase, snake_case, $prefixed
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(q)) {
    return {
      primary:     QueryKind.SYMBOL,
      secondaries: [QueryKind.LITERAL],
    };
  }

  // Contains hyphens, spaces, dots — string literal / header / path fragment
  if (q.includes("-") || q.includes(" ") || q.includes(".")) {
    return {
      primary:     QueryKind.LITERAL,
      secondaries: [QueryKind.SYMBOL],
    };
  }

  // Default
  return {
    primary:     QueryKind.SYMBOL,
    secondaries: [QueryKind.LITERAL],
  };
}

// ─────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────

function scoreCandidate(candidate, originalQuery, queryKind) {
  const q = originalQuery.toLowerCase();
  let score = 0;

  const name  = (candidate.name  || candidate.value || candidate.key || "").toLowerCase();
  const route = (candidate.route || "").toLowerCase();

  // ── Match quality ──
  if (name === q || route === q) {
    score += 1.0;
  } else if (name.startsWith(q) || route.startsWith(q)) {
    score += 0.7;
  } else if (name.includes(q) || route.includes(q)) {
    score += 0.5;
  } else {
    score += 0.2;
  }

  // ── Index relevance bonus ──
  const indexMatch = {
    [QueryKind.SYMBOL]:  ["symbol"],
    [QueryKind.ENV_VAR]: ["env_var", "symbol"],
    [QueryKind.LITERAL]: ["literal"],
    [QueryKind.ROUTE]:   ["route"],
  };

  const preferredTypes = indexMatch[queryKind] || [];
  if (preferredTypes.includes(candidate.type)) {
    score += 0.15;
  }

  // ── Exported bonus ──
  if (candidate.isExported) score += 0.05;

  // ── Complexity signal (log scale) ──
  if (candidate.complexity > 0) {
    score += Math.min(0.1, Math.log(candidate.complexity + 1) * 0.03);
  }

  return Math.min(score, 2.0);
}

// ─────────────────────────────────────────────
// Deduplication key
// ─────────────────────────────────────────────

function dedupKey(candidate) {
  const name = candidate.name  || candidate.value || candidate.key || candidate.route || "";
  const file = candidate.file  || candidate.source_file || "";
  const line = candidate.startLine ?? candidate.line ?? 0;
  const kind = candidate.kind  || candidate.type || "";
  return `${name}|${file}|${line}|${kind}`;
}

// ─────────────────────────────────────────────
// Index runners
// ─────────────────────────────────────────────

function runSymbolIndex(query) {
  let rows    = queryFindSymbol(query);
  let isFuzzy = false;

  if (rows.length === 0) {
    rows    = queryFindSymbolFuzzy(query);
    isFuzzy = rows.length > 0;
  }

  return rows.map((r) => {
    let signature = null;
    if (r.body_text) {
      signature = r.body_text.split("\n")[0].trim();
      if (signature.length > 120) signature = signature.slice(0, 120) + "...";
    }
    return {
      type:        "symbol",
      name:        r.name,
      kind:        r.kind,
      file:        r.file_path,
      startLine:   r.start_line,
      endLine:     r.end_line,
      complexity:  r.complexity || 0,
      isExported:  r.is_exported === 1,
      signature,
      calls:       r.call_summary   ? tryParseJson(r.call_summary)  : [],
      literalRefs: r.literal_refs   ? tryParseJson(r.literal_refs)  : [],
      envRefs:     r.env_refs       ? tryParseJson(r.env_refs)      : [],
      fuzzy:       isFuzzy,
      // body intentionally omitted — use read_function()
    };
  });
}

function runLiteralIndex(query) {
  const rows = queryFindLiteral(query);
  return rows.map((r) => {
    const res = {
      type:        "literal",
      value:       r.value,
      literalKind: r.kind,
      file:        r.file_path,
      line:        r.start_line,
      usedIn:      r.containing_fn,
    };

    if (r.containing_fn && r.fn_start_line != null) {
      let signature = null;
      if (r.fn_body) {
        signature = r.fn_body.split("\n")[0].trim();
        if (signature.length > 120) signature = signature.slice(0, 120) + "...";
      }
      res.containing_function = {
        name:       r.containing_fn,
        file:       r.file_path,
        startLine:  r.fn_start_line,
        endLine:    r.fn_end_line,
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
      type:   "env_var",
      key:    r.key,
      raw:    r.raw_text,
      file:   r.file_path,
      line:   r.start_line,
      usedIn: r.containing_fn,
    };

    if (r.containing_fn && r.fn_start_line != null) {
      let signature = null;
      if (r.fn_body) {
        signature = r.fn_body.split("\n")[0].trim();
        if (signature.length > 120) signature = signature.slice(0, 120) + "...";
      }
      res.containing_function = {
        name:       r.containing_fn,
        file:       r.file_path,
        startLine:  r.fn_start_line,
        endLine:    r.fn_end_line,
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
    type:    "route",
    route:   r.route_path,
    file:    r.source_file,
    line:    r.source_line,
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

export function resolve(query) {
  const cleanQuery = query.replace(/^["'`]|["'`]$/g, "").trim();
  if (!cleanQuery) {
    return { kind: "empty", strategy: "none", results: [], found: false, confidence: 0 };
  }

  const { primary, secondaries } = softClassify(cleanQuery);

  const allCandidates = [];

  // Always run primary
  switch (primary) {
    case QueryKind.SYMBOL:  allCandidates.push(...runSymbolIndex(cleanQuery));  break;
    case QueryKind.LITERAL: allCandidates.push(...runLiteralIndex(cleanQuery)); break;
    case QueryKind.ENV_VAR: allCandidates.push(...runConfigIndex(cleanQuery));  break;
    case QueryKind.ROUTE:   allCandidates.push(...runRouteIndex(cleanQuery));   break;
  }

  const primaryFoundSomething = allCandidates.length > 0;

  // Run secondaries only if primary found no exact matches
  for (const secondary of secondaries) {
    if (primaryFoundSomething) {
      const hasExact = allCandidates.some((c) => {
        const name = (c.name || c.value || c.key || "").toLowerCase();
        return name === cleanQuery.toLowerCase();
      });
      if (hasExact) continue;
    }

    switch (secondary) {
      case QueryKind.SYMBOL:  allCandidates.push(...runSymbolIndex(cleanQuery));  break;
      case QueryKind.LITERAL: allCandidates.push(...runLiteralIndex(cleanQuery)); break;
      case QueryKind.ENV_VAR: allCandidates.push(...runConfigIndex(cleanQuery));  break;
    }
  }

  // Score
  const scored = allCandidates.map((c) => ({
    ...c,
    _score: scoreCandidate(c, cleanQuery, primary),
  }));

  // Deduplicate
  const seen   = new Set();
  const deduped = scored.filter((c) => {
    const key = dedupKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort
  deduped.sort((a, b) => b._score - a._score);

  // Remove internal score field
  const results = deduped.map(({ _score, ...rest }) => rest);

  const strategyLabel =
    secondaries.length > 0 && results.length > 0
      ? `${primary}+${secondaries.join("+")} (candidate-rank)`
      : primary;

  // Confidence from top score
  // Score of 1.15+ (exact match + index bonus + exported) = high confidence
  // Below 0.4 = weak match, semantic fallback should run
  const topScore   = deduped[0]?._score ?? 0;
  const confidence = results.length === 0 ? 0 : Math.min(topScore / 1.15, 1.0);

  return {
    kind:                 primary,
    strategy:             strategyLabel,
    results,
    found:                results.length > 0,
    confidence,
    needsSemanticFallback: confidence < 0.4,
  };
}

// ─────────────────────────────────────────────
// Embedding singleton
// ─────────────────────────────────────────────

let _embedder  = null;
let _retriever = null;

export function setGraphEmbedder(embedder, retriever) {
  _embedder  = embedder;
  _retriever = retriever;
}

export function getGraphEmbedder() {
  return { embedder: _embedder, retriever: _retriever };
}

// ─────────────────────────────────────────────
// Async semantic fallback
// ─────────────────────────────────────────────

export async function resolveWithEmbeddings(query) {
  if (!_embedder || !_retriever) {
    return { results: [], strategy: "embeddings:unavailable" };
  }

  // SR-4: Guard against missing hybridSearch method on the native retriever.
  // If the native API uses a different method name, fail clearly rather than
  // silently returning empty results every time.
  if (typeof _retriever.hybridSearch !== "function") {
    console.error(
      `[SemanticResolver] ❌ hybridSearch is not a function on the retriever. ` +
      `Available methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(_retriever)).join(", ")}`
    );
    return { results: [], strategy: "embeddings:api_mismatch" };
  }

  try {
    const queryEmbedding = await _embedder.embed(query);
    if (!queryEmbedding) {
      return { results: [], strategy: "embeddings:no_vector" };
    }

    const float32Query =
      queryEmbedding instanceof Float32Array
        ? queryEmbedding
        : new Float32Array(queryEmbedding);

    const hits = _retriever.hybridSearch(
      float32Query,
      8,      // topK
      0.35,   // threshold — lower than vault (0.5) because symbol names are short
      query   // BM25 query text
    );

    if (!hits || hits.length === 0) {
      return { results: [], strategy: "embeddings:miss" };
    }

    const results = [];
    const seen    = new Set();

    for (const hit of hits) {
      if (hit.combinedScore < 0.35) continue;

      const node = queryNodeByStableId(hit.id);
      if (!node) continue;

      const key = `${node.name}|${node.file_path}|${node.start_line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let signature = null;
      if (node.body_text) {
        signature = node.body_text.split("\n")[0].trim();
        if (signature.length > 120) signature = signature.slice(0, 120) + "...";
      }

      results.push({
        type:           "symbol",
        name:           node.name,
        kind:           node.kind,
        file:           node.file_path,
        startLine:      node.start_line,
        endLine:        node.end_line,
        complexity:     node.complexity || 0,
        isExported:     node.is_exported === 1,
        signature,
        calls:          tryParseJson(node.call_summary),
        literalRefs:    tryParseJson(node.literal_refs),
        envRefs:        tryParseJson(node.env_refs),
        _semanticScore: hit.combinedScore,
        // body intentionally omitted — use read_function()
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

// ─────────────────────────────────────────────
// normalizeConceptKey
//
// SR-5: Sort enabled. Word order variations now normalize to the same key.
// "quota storage" and "storage quota" both become "quotastorage".
// This is correct for the ghost interceptor's concept deduplication —
// the goal is to detect semantically identical queries regardless of
// how the LLM phrases them.
//
// The original comment "order usually matters" was wrong for this use case.
// Concept keys are not used for display — they are cache keys where
// two queries meaning the same thing should hit the same entry.
// ─────────────────────────────────────────────

export function normalizeConceptKey(query) {
  const tokens = String(query)
    .replace(/([a-z])([A-Z])/g, "$1 $2")       // camelCase split
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTTPSRequest → HTTPS Request
    .toLowerCase()
    .split(/[-_\s.]+/)
    .filter((t) => t.length > 0);

  // SR-5: Sort so word order does not affect the key
  tokens.sort();

  const key = tokens.join("");

  // Minimum token length guard — single short tokens are too ambiguous
  if (tokens.length === 1 && tokens[0].length < 5) {
    return query.toLowerCase();
  }

  return key;
}