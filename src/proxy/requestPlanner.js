/**
 * requestPlanner.js
 *
 * Capability-based pipeline planner for ContextForge.
 *
 * Architecture:
 *   1. Scored regex classification — all patterns evaluated,
 *      highest cumulative score wins. Avoids "find auth AND fix"
 *      being misclassified by a first-match hierarchy.
 *
 *   2. Confidence gate — if regex score is high (≥ 0.5), skip
 *      embedding entirely. Only embed ambiguous messages.
 *      RAISED from 0.3 to 0.5 to reduce false-confident classifications.
 *
 *   3. SemanticCache HNSW semantic fallback — uses the existing
 *      plannerCache (seeded at startup) to classify ambiguous
 *      messages like "make it better" or "something seems off".
 *      searchK(vec, k) returns top-k hits with namespace filtering.
 *
 *   4. Capability Set output — planner returns a Set of capability
 *      strings, not booleans. Extensible: add "MEMORY", "AST",
 *      "CACHE" in future without touching the decision matrix.
 *
 *   5. Session override — hasPriorTools always returns full set.
 *      Never yank tools from a mid-session agent.
 *
 * Capabilities (current):
 *   GRAPH     — contextforge_query_graph
 *   PATCH     — contextforge_patch_ast
 *   READ      — contextforge_read_file_chunk
 *
 * Intent → Capability mapping:
 *   PATCH    → { PATCH }                    targeted edit (known scope)
 *   DEBUG    → { GRAPH, PATCH, READ }       exploratory fix (unknown scope)
 *   SEARCH   → { GRAPH, READ }              explorer only
 *   CREATE   → { GRAPH, READ }              explore patterns before scaffolding
 *   CHAT     → { }                          bypass
 *
 * Why PATCH vs DEBUG split (restored):
 *   Raising confidence threshold to 0.5 prevents the Confidence: 0.33
 *   misclassifications that forced the EDIT merge. Now we can distinguish:
 *   - "Fix typo" → PATCH (targeted, no graph needed)
 *   - "Fix auth flow" → DEBUG (exploratory, needs graph traversal)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

export const CAPABILITIES = Object.freeze({
  GRAPH: "GRAPH",
  PATCH: "PATCH",
  READ: "READ",
  MEMORY: "MEMORY", // reserved for future use
  AST: "AST", // reserved for future use
  CACHE: "CACHE", // reserved for future use
});

// ─────────────────────────────────────────────────────────────────────────────
// Scored regex patterns
// All patterns are evaluated — scores accumulate per intent.
// This prevents "Find auth.js and fix login" → SEARCH misclassification.
// Each pattern carries a weight: strong signals score 2, weak score 1.
//
// PATCH vs DEBUG distinction:
//   PATCH = targeted edit with known scope ("fix typo", "rename variable")
//   DEBUG = exploratory fix with unknown scope ("fix auth", "debug crash")
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_PATTERNS = [
  // ── PATCH signals (targeted edits — scope is known) ──────────────────────
  {
    intent: "PATCH",
    weight: 4,
    regex: /\brename\b|\binstead of\b|\bmake\b.*\baccept\b/i,
  },
  {
    intent: "PATCH",
    weight: 2,
    regex: /\bfix\s+(typo|spelling|indent|format)/i,
  },
  { intent: "PATCH", weight: 2, regex: /\bchange\b|\bsplit\b|\bextract\b|\brefactor\b|\bconvert\b|\binline\b/i },
  {
    intent: "PATCH",
    weight: 2,
    regex: /\bupdate\s+(this\s+)?(line|function|method|variable)\b/i,
  },
  { intent: "PATCH", weight: 2, regex: /\bmodify\b|\badjust\b|\btweak\b/i },
  { intent: "PATCH", weight: 2, regex: /\bwrap\b|\bsurround\b|\benclose\b/i },
  {
    intent: "PATCH",
    weight: 1,
    regex: /\bremove\b|\bdelete\b|\badd\b|\binsert\b/i,
  },
  { intent: "PATCH", weight: 1, regex: /\bclean up\b|\bimprove\b/i },

  // ── DEBUG signals (exploratory fixes — scope unknown) ────────────────────
  {
    intent: "DEBUG",
    weight: 2,
    regex: /\bfix\s+(bug|issue|problem|error|crash)\b/i,
  },
  {
    intent: "DEBUG",
    weight: 2,
    regex: /\bfix\s+the\s+(auth|login|database|api)\b/i,
  },
  { intent: "DEBUG", weight: 2, regex: /\bwhy\s+(is|does|isn't|doesn't)\b/i },
  {
    intent: "DEBUG",
    weight: 2,
    regex: /\bnot working\b|\bdoesn't work\b|\bbroken\b/i,
  },
  {
    intent: "DEBUG",
    weight: 2,
    regex: /\bfailing\b|\bthrows\b|\bcrash\b|\bexception\b/i,
  },
  { intent: "DEBUG", weight: 1, regex: /\bdebug\b|\btrace\b|\bdiagnose\b/i },
  {
    intent: "DEBUG",
    weight: 4,
    regex: /not being called|not running|dropping|memory leak|cors error|stale data|slower/i,
  },
  {
    intent: "DEBUG",
    weight: 2,
    regex: /\bwhat's wrong\b|\bsomething\s+(is\s+)?(weird|off|wrong)\b/i,
  },
  {
    intent: "DEBUG",
    weight: 1,
    regex: /\bundefined\b|\bnull\b|\bintermittent\b/i,
  },
  { intent: "DEBUG", weight: 1, regex: /make it better|make this better/i },

  // ── SEARCH signals ────────────────────────────────────────────────────────
  { intent: "SEARCH", weight: 2, regex: /\bfind\b|\blocate\b|\bwhere\b/i },
  { intent: "SEARCH", weight: 2, regex: /which file|show me|list all/i },
  { intent: "SEARCH", weight: 2, regex: /\bcall\b|\bdepend\b|\binternally\b/i },
  { intent: "SEARCH", weight: 1, regex: /\bsymbol\b|\broute\b|\bendpoint\b/i },
  {
    intent: "SEARCH",
    weight: 1,
    regex: /\bdefined\b|\bdeclared\b|\bimported\b|\bimport\b|\bexport\b/i,
  },

  // ── CREATE signals ────────────────────────────────────────────────────────
  {
    intent: "CREATE",
    weight: 2,
    regex: /\bcreate\b|\bgenerate\b|\bscaffold\b/i,
  },
  { intent: "CREATE", weight: 2, regex: /\bbuild\b|\bimplement\b|\bwrite\b/i },
  { intent: "CREATE", weight: 3, regex: /make a .*new|add a .*new|start a .*new/i },

  // ── CHAT signals (low weight — only wins when nothing else matches) ────────
  {
    intent: "CHAT",
    weight: 1,
    regex: /\bexplain\b|\bdescribe\b|\bsummarise\b|\bsummarize\b/i,
  },
  {
    intent: "CHAT",
    weight: 1,
    regex: /\btranslate\b|\bwhat does\b|\bhow does\b/i,
  },
  { intent: "CHAT", weight: 1, regex: /tell me about|what is the difference/i },
  {
    intent: "CHAT",
    weight: 1,
    regex: /\bok\b|\bthanks\b|\bthank you\b|\bgood job\b|\bdone\b|\bperfect\b/i,
  },
  {
    intent: "CHAT",
    weight: 1,
    regex: /looks good|that works|exactly right|got it|never mind|try again|not quite/i,
  },
];

/**
 * Score all intents against the message.
 * Returns { intent, score, confidence } where confidence is
 * normalized to [0,1] based on the winning margin.
 */
function scoreIntents(message) {
  const scores = {
    PATCH: 0,
    DEBUG: 0,
    SEARCH: 0,
    CREATE: 0,
    CHAT: 0,
  };

  // NEW: track which patterns fired per intent
  const matchedPatterns = {
    PATCH: [],
    DEBUG: [],
    SEARCH: [],
    CREATE: [],
    CHAT: [],
  };

  for (const { intent, weight, regex } of INTENT_PATTERNS) {
    if (regex.test(message)) {
      scores[intent] += weight;
      matchedPatterns[intent].push(regex.source.slice(0, 60));
    }
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [winnerIntent, winnerScore] = sorted[0];
  const runnerScore = sorted[1]?.[1] ?? 0;

  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence =
    totalScore === 0 ? 0 : (winnerScore - runnerScore) / totalScore;

  if (confidence < 0.5) {
    const hasCreate = scores.CREATE > 0;
    const hasPatch = scores.PATCH > 0;
    if (hasCreate && hasPatch) {
      // Multi-task prompt — use DEBUG for full capability set
      // Return high confidence (1) so the semantic fallback doesn't override this decision
      return { intent: "DEBUG", score: winnerScore, confidence: 1, allScores: scores, matchedPatterns };
    }
  }

  return {
    intent: totalScore === 0 ? "CHAT" : winnerIntent,
    score: winnerScore,
    confidence: totalScore === 0 ? 0 : confidence,
    allScores: scores,
    matchedPatterns, // NEW
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability matrix
// Maps intent → Set of required capabilities.
// Add new intents here without touching the planner logic.
// ─────────────────────────────────────────────────────────────────────────────

const CAPABILITY_MATRIX = {
  PATCH: new Set([CAPABILITIES.GRAPH, CAPABILITIES.PATCH, CAPABILITIES.READ]), // edit with context
  DEBUG: new Set([CAPABILITIES.GRAPH, CAPABILITIES.PATCH, CAPABILITIES.READ]), // exploratory fix
  SEARCH: new Set([CAPABILITIES.GRAPH, CAPABILITIES.READ]), // explorer
  CREATE: new Set([CAPABILITIES.GRAPH, CAPABILITIES.READ]), // explore before scaffold
  CHAT: new Set(), // bypass
};

const FULL_CAPABILITY_SET = new Set([
  CAPABILITIES.GRAPH,
  CAPABILITIES.PATCH,
  CAPABILITIES.READ,
]);

const EMPTY_CAPABILITY_SET = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// Semantic anchor store
// Anchors embedded at startup into the shared SemanticCache HNSW index.
// Namespaced with "PLANNER__" prefix so clearPrefix() only removes planner
// entries without touching CACHE/MEMORY vectors.
// ─────────────────────────────────────────────────────────────────────────────

const SEMANTIC_ANCHORS = {
  PATCH: [
    "make it better",
    "clean this up a bit",
    "this needs to be updated",
    "can you improve this function",
    "this seems inefficient",
    "there is something off with this",
    "this does not look right",
  ],
  DEBUG: [
    "why is this failing",
    "something weird is happening",
    "this throws an error sometimes",
    "it works but not always",
    "the output is wrong",
    "this is behaving unexpectedly",
    "it crashes in production",
    "intermittent failure",
    "this logic seems wrong",
    "the behavior is incorrect",
    "there is a weird state condition",
  ],
  SEARCH: [
    "where does this get called",
    "which file handles this",
    "show me the implementation",
    "where is this defined",
    "looking at the auth middleware",
    "what does this function do",
    "trace the call chain",
  ],
  CREATE: [
    "add a completely new feature",
    "start from scratch",
    "create a new endpoint",
    "build a new component",
    "write a new module",
    "implement this from scratch",
  ],
  CHAT: [
    "explain how this works",
    "tell me about this",
    "what is the difference between",
    "translate this text",
    "summarize this document",
    "describe the architecture",
    "ok thanks",
    "looks good to me",
    "that is perfect",
    "never mind",
    "can you try again",
    "no that is not right",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Planner state
// ─────────────────────────────────────────────────────────────────────────────

let _plannerCache = null; // SemanticCache instance seeded with anchors
let _embedder = null;
let _plannerReady = false;

// Maps the namespaced anchor ID → intent string.
// Used as fallback if searchK hit.payload is empty.
// Format: "PLANNER__PATCH__0" → "PATCH"
const _idToIntent = new Map();

/**
 * Initialize the planner at startup.
 * Seeds the shared SemanticCache with all anchor phrases using addWithMeta().
 * Namespace "PLANNER" isolates these entries from CACHE/MEMORY vectors.
 * Uses the existing onnxEmbedder — no new infrastructure needed.
 *
 * @param {object} onnxEmbedder  - Native OnnxEmbedder instance
 * @param {object} semanticCache - Native SemanticCache instance (shared)
 */
export async function initPlanner(onnxEmbedder, semanticCache) {
  _embedder = onnxEmbedder;
  _plannerCache = semanticCache;

//   console.log("[Planner] Starting anchor embedding...");

  let totalAnchors = 0;
  for (const [intent, phrases] of Object.entries(SEMANTIC_ANCHORS)) {
    for (let i = 0; i < phrases.length; i++) {
      const phrase = phrases[i];
      const anchorId = `PLANNER__${intent}__${i}`;
      try {
        const vec = await onnxEmbedder.embed(phrase);
        semanticCache.addWithMeta(vec, anchorId, "PLANNER", "anchor", intent);
        _idToIntent.set(anchorId, intent);
        totalAnchors++;
      } catch (err) {
//         console.warn(
//           `[Planner] ⚠️ Failed to embed anchor "${phrase}": ${err.message}`,
//         );
      }
    }
  }

  _plannerReady = true;

  const cacheStats = semanticCache.stats();
//   console.log(
//     `[Planner] ✅ Ready — ${Object.keys(SEMANTIC_ANCHORS).length} intents, ` +
//       `${totalAnchors} anchors in HNSW`,
//   );
//   console.log(
//     `[Planner] 📊 Cache stats: total=${cacheStats.size}, ` +
//       `namespaces=${JSON.stringify(cacheStats.namespaces)}`,
//   );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractLastUserMessage(payload) {
  const messages = payload.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ");
    }
  }
  return "";
}

/**
 * Semantic intent lookup via native SemanticCache HNSW.
 *
 * Uses searchK(vec, 5) to get top-5 nearest anchors, filtered to the
 * PLANNER namespace, then majority-votes the intent from hit.payload.
 *
 * Returns null if:
 *   - Planner not ready
 *   - Top score below SEMANTIC_SCORE_THRESHOLD
 *   - searchK returns no PLANNER hits
 */
async function semanticLookup(message) {
  if (!_plannerReady || !_embedder || !_plannerCache) {
//     console.log(
//       `[Planner] ⚠️ semanticLookup skipped: ready=${_plannerReady}, embedder=${!!_embedder}, cache=${!!_plannerCache}`,
//     );
    return null;
  }

  try {
    const queryVec = await Promise.race([
      _embedder.embed(message),
      new Promise((_, reject) => setTimeout(() => reject(new Error("embed timeout")), 2000))
    ]);

    const hits = _plannerCache.searchK(queryVec, 5);
    if (!hits || hits.length === 0) {
//       console.log(`[Planner] ⚠️ searchK returned no hits`);
      return null;
    }

    const plannerHits = hits.filter((h) => h.namespace === "PLANNER");
    if (plannerHits.length === 0) {
//       console.log(
//         `[Planner] ⚠️ searchK returned ${hits.length} hits but none in PLANNER namespace`,
//       );
//       console.log(
//         `[Planner] ⚠️ Hit namespaces: ${hits.map((h) => h.namespace).join(", ")}`,
//       );
      return null;
    }

    const topScore = plannerHits[0].score;
    if (topScore < SEMANTIC_SCORE_THRESHOLD) {
//       console.log(
//         `[Planner] ⚠️ Top score ${topScore.toFixed(3)} below threshold ${SEMANTIC_SCORE_THRESHOLD}`,
//       );
      return null;
    }

    const intentVotes = {};
    for (const hit of plannerHits) {
      const intent = hit.payload || _idToIntent.get(hit.id);
      if (intent) {
        intentVotes[intent] = (intentVotes[intent] ?? 0) + 1;
      }
    }

    const winner = Object.entries(intentVotes).sort((a, b) => b[1] - a[1])[0];

    return {
      intent: winner[0],
      score: topScore,
      votes: intentVotes,
    };
  } catch (err) {
    console.warn(`[Planner] ⚠️ Semantic lookup failed: ${err.message}`);
//     console.error(`[Planner] ❌ semanticLookup failed: ${err.message}`);
    console.error(err.stack);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core planner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confidence threshold for trusting regex without semantic fallback.
 * RAISED to 0.5 from 0.3 to reduce false-confident classifications.
 * 0.5 = regex winner must be 50% more dominant than runner-up.
 * Below this → embed and use HNSW.
 */
const REGEX_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Minimum semantic similarity score to trust HNSW result.
 * Below this → fall back to context signals or CHAT (safe bypass).
 */
const SEMANTIC_SCORE_THRESHOLD = 0.20;

/**
 * Plan which capabilities this request needs.
 *
 * Decision order:
 *   1. originHint          → structural fast-path (CONTINUATION, etc.)
 *   2. hasPriorTools       → always full arsenal (mid-session safety)
 *   3. Empty message       → bypass (nothing to classify)
 *   4. Scored regex        → classify, check confidence
 *   5. Low confidence      → semantic HNSW lookup
 *   6. Low semantic score  → context signal check (file/symbol ref)
 *   7. Fallback            → CHAT bypass
 *
 * @param {object} payload        - Normalized OpenAI-format payload
 * @param {object} sessionState   - { hasPriorTools, trueBaselineTokens, originHint }
 * @param {object} onnxEmbedder   - Embedder instance (for semantic fallback)
 * @returns {Promise<PipelineDecision>}
 *
 * @typedef {object} PipelineDecision
 * @property {Set<string>} capabilities - Which capabilities to inject
 * @property {string}      intent       - Classified intent name
 * @property {string}      method       - Classification method used
 * @property {boolean}     bypass       - true = inject nothing
 * @property {object}      [debug]      - Scores, votes, evidence for logging
 */
export async function planPipeline(payload, sessionState, onnxEmbedder) {
  const { hasPriorTools, originHint } = sessionState;

  // ── 0. Origin hint fast-path ──────────────────────────────────────────────
  if (originHint === "CONTINUATION") {
    return {
      capabilities: FULL_CAPABILITY_SET,
      intent: "CONTINUATION",
      method: "origin_hint",
      bypass: false,
      debug: {
        evidence: ["origin=CONTINUATION", "recent_tool_activity_detected"],
        regexConfidence: null,
      },
    };
  }

  // ── 1. Session override ───────────────────────────────────────────────────
  if (hasPriorTools) {
    return {
      capabilities: FULL_CAPABILITY_SET,
      intent: "MID_SESSION",
      method: "prior_tools",
      bypass: false,
      debug: {
        evidence: ["prior_tool_calls_detected"],
        regexConfidence: null,
      },
    };
  }

  const lastMsg = extractLastUserMessage(payload);

  // ── 2. Trivial message guard ──────────────────────────────────────────────
  if (!lastMsg.trim()) {
    return {
      capabilities: EMPTY_CAPABILITY_SET,
      intent: "TRIVIAL",
      method: "empty_message",
      bypass: true,
      debug: {
        evidence: ["empty_user_message"],
        regexConfidence: null,
      },
    };
  }

  // ── 3. Scored regex classification ───────────────────────────────────────
  const regexResult = scoreIntents(lastMsg);

  let finalIntent = regexResult.intent;
  let method = "regex";

  // Build evidence array as we go — appended at each decision point
  const evidence = [
    `role=user`,
    `message_len=${lastMsg.length}`,
    `regex_winner=${regexResult.intent}`,
    `confidence=${regexResult.confidence.toFixed(2)}`,
    `scores=${JSON.stringify(regexResult.allScores)}`,
  ];

  // Add which patterns actually fired for the winning intent
  const winnerPatterns = regexResult.matchedPatterns[regexResult.intent];
  if (winnerPatterns?.length > 0) {
    evidence.push(`matched_patterns=[${winnerPatterns.join(" | ")}]`);
  }

  let debugInfo = {
    regexScores: regexResult.allScores,
    regexConfidence: regexResult.confidence,
    matchedPatterns: regexResult.matchedPatterns,
    evidence,
  };

  // ── 4. Confidence gate ────────────────────────────────────────────────────
  if (regexResult.confidence < REGEX_CONFIDENCE_THRESHOLD) {
    evidence.push(`confidence_below_threshold=${REGEX_CONFIDENCE_THRESHOLD}`);

    const semResult = await semanticLookup(lastMsg);

    if (semResult && semResult.score >= SEMANTIC_SCORE_THRESHOLD) {
      finalIntent = semResult.intent;
      method = "semantic";
      debugInfo.semanticScore = semResult.score;
      debugInfo.semanticVotes = semResult.votes;
      evidence.push(`semantic_score=${semResult.score.toFixed(3)}`);
      evidence.push(`semantic_votes=${JSON.stringify(semResult.votes)}`);
      evidence.push(`semantic_winner=${semResult.intent}`);

//       console.log(
//         `[Planner] 🧠 Semantic: "${lastMsg.slice(0, 50)}" → ${finalIntent} ` +
//           `(score: ${semResult.score.toFixed(3)}, votes: ${JSON.stringify(semResult.votes)})`,
//       );
    } else {
      if (semResult) {
        evidence.push(
          `semantic_score=${semResult.score.toFixed(3)} (below threshold)`,
        );
      } else {
        evidence.push(
          `semantic_lookup=null (planner not ready or embed failed)`,
        );
      }

      // Context signal: only upgrades CHAT → SEARCH, never overrides PATCH/DEBUG
      const hasFileRef =
        /\.(js|ts|py|go|rs|jsx|tsx|java|rb|cpp)\b|function |class |const |route|endpoint|middleware/i.test(
          lastMsg,
        );

      if (hasFileRef && regexResult.intent === "CHAT") {
        finalIntent = "SEARCH";
        method = "context_signal";
        evidence.push(`context_signal=file_or_symbol_reference`);
        evidence.push(`chat_upgraded_to_search=true`);
//         console.log(
//           `[Planner] 📁 Context signal: file/symbol reference → SEARCH`,
//         );
      } else {
        // Keep regex winner — never override PATCH/DEBUG with context signals
        finalIntent = regexResult.intent;
        method = "regex_fallback";
        evidence.push(`low_confidence_kept_regex_winner=${regexResult.intent}`);
      }
    }
  }

  const capabilities = CAPABILITY_MATRIX[finalIntent] ?? EMPTY_CAPABILITY_SET;
  const bypass = capabilities.size === 0;

  evidence.push(`final_intent=${finalIntent}`);
  evidence.push(`method=${method}`);
  evidence.push(`capabilities=${Array.from(capabilities).join("+") || "none"}`);
  evidence.push(`bypass=${bypass}`);

  return {
    capabilities,
    intent: finalIntent,
    method,
    bypass,
    debug: { ...debugInfo, evidence },
  };
}
