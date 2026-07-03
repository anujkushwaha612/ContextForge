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
 *
 * Fixes applied (this pass — each verified by reproduction):
 *   SR-6: QUERY NOT NORMALIZED PER INDEX (major). "GET /api/users" was
 *         classified ROUTE but the FULL string went to queryFindRoutes —
 *         route_path stores "/api/users", so LIKE '%GET /api/users%'
 *         matched NOTHING. Same for "process.env.AWS_BUCKET_NAME" → the
 *         config index stores bare keys ("AWS_BUCKET_NAME"); full-string
 *         lookups returned zero rows. The classifier understood the prefix
 *         but never stripped it. Each index now receives its canonical
 *         query form.
 *   SR-7: SIGNATURE FEATURE SILENTLY DEAD (major). runSymbolIndex reads
 *         r.body_text — but GD-5 removed body_text from the findSymbol
 *         SELECT. r.body_text is always undefined → signature was null in
 *         every symbol result since GD-5 landed. Signature now derives
 *         from name/kind/async metadata that IS selected.
 *   SR-8: Fuzzy-only results were scored like exact candidates (name
 *         includes query → 0.5 base) with no penalty, so a fuzzy match
 *         could beat a same-file literal exact match. Fuzzy candidates
 *         now carry a 0.15 score penalty.
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
// SR-6: classification now also produces the CANONICAL query for each index.
// The classifier understood prefixes ("GET ", "process.env.") but passed the
// raw string to indexes that store canonical forms — guaranteed misses.
function softClassify(q) {
  // Route: METHOD /path → canonical query is the path alone
  const methodRoute = q.match(/^(GET|POST|PUT|PATCH|DELETE|ANY)\s+(\/\S*)/i);
  if (methodRoute) {
    return {
      primary: QueryKind.ROUTE,
      secondaries: [],
      canonical: { [QueryKind.ROUTE]: methodRoute[2] },
    };
  }

  // Route: leading slash /path
  if (q.startsWith("/") && q.length > 1) {
    return { primary: QueryKind.ROUTE, secondaries: [], canonical: {} };
  }

  // SR-2: Route: path-segment pattern without leading slash
  // e.g. "api/v1/users", "v1/chat/completions"
  if (
    q.includes("/") &&
    !q.includes(".") &&
    !q.includes(" ") &&
    /^[a-zA-Z0-9_\-/]+$/.test(q)
  ) {
    return {
      primary: QueryKind.ROUTE,
      secondaries: [],
      // stored routes lead with "/" — normalize so LIKE '%/api/users%' hits
      canonical: { [QueryKind.ROUTE]: "/" + q.replace(/^\/+/, "") },
    };
  }

  // Env var: process.env.X → canonical query is the bare key
  const envAccess = q.match(/^process\.env\.([A-Z_][A-Z0-9_]*)$/);
  if (envAccess) {
    return {
      primary: QueryKind.ENV_VAR,
      secondaries: [QueryKind.SYMBOL, QueryKind.LITERAL],
      canonical: {
        [QueryKind.ENV_VAR]: envAccess[1],
        [QueryKind.SYMBOL]: envAccess[1],
        // literal index stores the full expression text in source
        [QueryKind.LITERAL]: envAccess[1],
      },
    };
  }

  // SCREAMING_SNAKE (3+ chars, all caps+underscore)
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(q)) {
    return {
      primary:     QueryKind.ENV_VAR,
      secondaries: [QueryKind.SYMBOL],
      canonical: {},
    };
  }

  // Pure identifier: camelCase, PascalCase, snake_case, $prefixed
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(q)) {
    return {
      primary:     QueryKind.SYMBOL,
      secondaries: [QueryKind.LITERAL],
      canonical:   {},
    };
  }

  // Contains hyphens, spaces, dots — string literal / header / path fragment
  if (q.includes("-") || q.includes(" ") || q.includes(".")) {
    return {
      primary:     QueryKind.LITERAL,
      secondaries: [QueryKind.SYMBOL],
      canonical:   {},
    };
  }

  // Default
  return {
    primary:     QueryKind.SYMBOL,
    secondaries: [QueryKind.LITERAL],
    canonical:   {},
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

  // SR-8: fuzzy matches are guesses, not answers — without this penalty a
  // fuzzy symbol hit ("doXwork" for "do_work") outranked exact literal
  // matches from a secondary index.
  if (candidate.fuzzy) score -= 0.15;

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
    // SR-7 FIX: r.body_text is NEVER selected by findSymbol since GD-5 —
    // the old code's `if (r.body_text)` was permanently false, so signature
    // was silently null in every result. Build a synthetic signature from
    // metadata that IS selected (name/kind/async/line-span) instead.
    const span = r.end_line != null && r.start_line != null
      ? r.end_line - r.start_line + 1
      : null;
    const signature =
      `${r.is_async === 1 ? "async " : ""}${r.kind ?? "symbol"} ${r.name}` +
      (span != null ? ` (${span} lines)` : "");
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

  const { primary, secondaries, canonical = {} } = softClassify(cleanQuery);

  // SR-6: each index gets its canonical query form (e.g. route path without
  // the HTTP method, env key without the process.env. prefix). Falls back to
  // the raw cleaned query when no canonicalization applies.
  const queryFor = (kind) => canonical[kind] ?? cleanQuery;

  const allCandidates = [];

  // Always run primary
  switch (primary) {
    case QueryKind.SYMBOL:  allCandidates.push(...runSymbolIndex(queryFor(QueryKind.SYMBOL)));  break;
    case QueryKind.LITERAL: allCandidates.push(...runLiteralIndex(queryFor(QueryKind.LITERAL))); break;
    case QueryKind.ENV_VAR: allCandidates.push(...runConfigIndex(queryFor(QueryKind.ENV_VAR)));  break;
    case QueryKind.ROUTE:   allCandidates.push(...runRouteIndex(queryFor(QueryKind.ROUTE)));   break;
  }

  const primaryFoundSomething = allCandidates.length > 0;

  // SR-6: exact-match check compares against the canonical form the index
  // actually searched — comparing "AWS_BUCKET_NAME" hits against the raw
  // "process.env.AWS_BUCKET_NAME" string never matched, so secondaries
  // always ran even after a perfect primary hit.
  const matchTargets = new Set(
    [cleanQuery, ...Object.values(canonical)].map((s) => s.toLowerCase())
  );

  // Run secondaries only if primary found no exact matches
  for (const secondary of secondaries) {
    if (primaryFoundSomething) {
      const hasExact = allCandidates.some((c) => {
        const name = (c.name || c.value || c.key || "").toLowerCase();
        return matchTargets.has(name);
      });
      if (hasExact) continue;
    }

    switch (secondary) {
      case QueryKind.SYMBOL:  allCandidates.push(...runSymbolIndex(queryFor(QueryKind.SYMBOL)));  break;
      case QueryKind.LITERAL: allCandidates.push(...runLiteralIndex(queryFor(QueryKind.LITERAL))); break;
      case QueryKind.ENV_VAR: allCandidates.push(...runConfigIndex(queryFor(QueryKind.ENV_VAR)));  break;
    }
  }

  // Score — against the canonical form for the primary kind (SR-6): a
  // route hit "/api/users" must score as an EXACT match for the query
  // "GET /api/users", not as a weak substring miss.
  const scoringQuery = queryFor(primary);
  const scored = allCandidates.map((c) => ({
    ...c,
    _score: scoreCandidate(c, scoringQuery, primary),
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