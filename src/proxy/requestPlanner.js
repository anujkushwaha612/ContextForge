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
 *   2. Confidence gate — if regex score is high (≥ 0.6), skip
 *      embedding entirely. Only embed ambiguous messages.
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
 *   EDIT     → { GRAPH, PATCH, READ }   full arsenal (was PATCH + DEBUG)
 *   SEARCH   → { GRAPH, READ }          explorer only
 *   CREATE   → { }                      bypass, native tools handle creation
 *   CHAT     → { }                      bypass
 *
 * Why EDIT instead of PATCH + DEBUG:
 *   "Fix a bug" and "edit this function" need identical tools.
 *   Keeping them separate caused Confidence: 0.33 misclassifications
 *   when a message contained both fix and debug signals.
 *   Merging eliminates the ambiguity entirely.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

export const CAPABILITIES = Object.freeze({
  GRAPH:  "GRAPH",
  PATCH:  "PATCH",
  READ:   "READ",
  MEMORY: "MEMORY",  // reserved for future use
  AST:    "AST",     // reserved for future use
  CACHE:  "CACHE",   // reserved for future use
});

// ─────────────────────────────────────────────────────────────────────────────
// Scored regex patterns
// All patterns are evaluated — scores accumulate per intent.
// This prevents "Find auth.js and fix login" → SEARCH misclassification.
// Each pattern carries a weight: strong signals score 2, weak score 1.
//
// EDIT absorbs all former PATCH and DEBUG patterns.
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_PATTERNS = [
  // ── EDIT signals (merged PATCH + DEBUG) ──────────────────────────────────
  // Anything involving changing, fixing, or debugging code gets full arsenal.
  // No distinction between "fix a bug" and "edit this function" — both need
  // Graph + Patch + Read. Merging eliminates Confidence: 0.33 split votes.
  { intent: "EDIT", weight: 2, regex: /\bfix\b|\bpatch\b|\bcorrect\b/i },
  { intent: "EDIT", weight: 2, regex: /\bmodify\b|\bchange\b|\bupdate\b|\bedit\b/i },
  { intent: "EDIT", weight: 2, regex: /\brename\b|\brefactor\b|\brewrite\b/i },
  { intent: "EDIT", weight: 2, regex: /\berror\b|\bcrash\b|\bexception\b/i },
  { intent: "EDIT", weight: 2, regex: /\bbug\b|\bfailing\b|\bbroken\b/i },
  { intent: "EDIT", weight: 1, regex: /\bimprove\b|\bclean up\b|\badjust\b|\btweak\b/i },
  { intent: "EDIT", weight: 1, regex: /\bremove\b|\bdelete\b|\binsert\b|\badd\b/i },
  { intent: "EDIT", weight: 1, regex: /make it better|make this better/i },
  { intent: "EDIT", weight: 1, regex: /not working|doesn't work|does not work/i },
  { intent: "EDIT", weight: 1, regex: /why is|what's wrong|what is wrong/i },
  { intent: "EDIT", weight: 1, regex: /\bthrows\b|\bundefined\b|\bnull\b/i },
  { intent: "EDIT", weight: 1, regex: /\bdebug\b|\btrace\b|\bdiagnose\b/i },

  // ── SEARCH signals ────────────────────────────────────────────────────────
  { intent: "SEARCH", weight: 2, regex: /\bfind\b|\blocate\b|\bwhere\b/i },
  { intent: "SEARCH", weight: 2, regex: /which file|show me|list all/i },
  { intent: "SEARCH", weight: 1, regex: /\bsymbol\b|\broute\b|\bendpoint\b/i },
  { intent: "SEARCH", weight: 1, regex: /\bdefined\b|\bdeclared\b|\bimported\b/i },

  // ── CREATE signals ────────────────────────────────────────────────────────
  { intent: "CREATE", weight: 2, regex: /\bcreate\b|\bgenerate\b|\bscaffold\b/i },
  { intent: "CREATE", weight: 2, regex: /\bbuild\b|\bimplement\b|\bwrite\b/i },
  { intent: "CREATE", weight: 1, regex: /make a new|add a new|start a new/i },

  // ── CHAT signals (low weight — only wins when nothing else matches) ────────
  { intent: "CHAT", weight: 1, regex: /\bexplain\b|\bdescribe\b|\bsummarise\b|\bsummarize\b/i },
  { intent: "CHAT", weight: 1, regex: /\btranslate\b|\bwhat does\b|\bhow does\b/i },
  { intent: "CHAT", weight: 1, regex: /tell me about|what is the difference/i },
];

/**
 * Score all intents against the message.
 * Returns { intent, score, confidence } where confidence is
 * normalized to [0,1] based on the winning margin.
 */
function scoreIntents(message) {
  const scores = {
    EDIT: 0, SEARCH: 0, CREATE: 0, CHAT: 0,
  };

  for (const { intent, weight, regex } of INTENT_PATTERNS) {
    if (regex.test(message)) {
      scores[intent] += weight;
    }
  }

  // Find winner and runner-up
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [winnerIntent, winnerScore] = sorted[0];
  const runnerScore = sorted[1]?.[1] ?? 0;

  // Confidence: how dominant is the winner?
  // 1.0 = only one intent scored. 0.0 = all tied.
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence =
    totalScore === 0 ? 0 : (winnerScore - runnerScore) / totalScore;

  return {
    intent:     totalScore === 0 ? "CHAT" : winnerIntent,
    score:      winnerScore,
    confidence: totalScore === 0 ? 0 : confidence,
    allScores:  scores,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability matrix
// Maps intent → Set of required capabilities.
// Add new intents here without touching the planner logic.
// ─────────────────────────────────────────────────────────────────────────────

const CAPABILITY_MATRIX = {
  EDIT:   new Set([CAPABILITIES.GRAPH, CAPABILITIES.PATCH, CAPABILITIES.READ]),
  SEARCH: new Set([CAPABILITIES.GRAPH, CAPABILITIES.READ]),
  CREATE: new Set(),   // empty = bypass, let native tools handle creation
  CHAT:   new Set(),   // empty = bypass
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
//
// EDIT absorbs all former PATCH and DEBUG anchor phrases.
// ─────────────────────────────────────────────────────────────────────────────

const SEMANTIC_ANCHORS = {
  EDIT: [
    // Former PATCH anchors
    "make it better",
    "there is something off with this",
    "this does not look right",
    "can you improve this function",
    "this logic seems wrong",
    "the behavior is incorrect",
    "this needs to be updated",
    "clean this up a bit",
    "this seems inefficient",
    "there is a weird state condition",
    // Former DEBUG anchors
    "why is this failing",
    "something weird is happening",
    "this throws an error sometimes",
    "it works but not always",
    "the output is wrong",
    "this is behaving unexpectedly",
    "it crashes in production",
    "intermittent failure",
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
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Planner state
// ─────────────────────────────────────────────────────────────────────────────

let _plannerCache  = null;   // SemanticCache instance seeded with anchors
let _embedder      = null;
let _plannerReady  = false;

// Maps the namespaced anchor ID → intent string.
// Used as fallback if searchK hit.payload is empty.
// Format: "PLANNER__EDIT__0" → "EDIT"
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
  _embedder     = onnxEmbedder;
  _plannerCache = semanticCache;

  console.log("[Planner] Embedding intent anchors into HNSW...");

  let totalAnchors = 0;
  for (const [intent, phrases] of Object.entries(SEMANTIC_ANCHORS)) {
    for (let i = 0; i < phrases.length; i++) {
      const phrase   = phrases[i];
      const anchorId = `PLANNER__${intent}__${i}`;
      try {
        const vec = await onnxEmbedder.embed(phrase);
        // addWithMeta(vec, id, namespace, type, payload)
        // payload = intent string so searchK hits carry intent without JS map lookup
        semanticCache.addWithMeta(vec, anchorId, "PLANNER", "anchor", intent);
        _idToIntent.set(anchorId, intent);
        totalAnchors++;
      } catch (err) {
        console.warn(
          `[Planner] ⚠️ Failed to embed anchor "${phrase}": ${err.message}`,
        );
      }
    }
  }

  _plannerReady = true;
  const cacheStats = semanticCache.stats();
  console.log(
    `[Planner] ✅ Ready — ${Object.keys(SEMANTIC_ANCHORS).length} intents, ` +
      `${totalAnchors} anchors in HNSW`,
  );
  console.log(
    `[Planner] 📊 Cache stats: total=${cacheStats.size}, ` +
      `namespaces=${JSON.stringify(cacheStats.namespaces)}`,
  );
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
  if (!_plannerReady || !_embedder || !_plannerCache) return null;

  try {
    const queryVec = await _embedder.embed(message);

    // searchK returns [{id, label, score, namespace, type, payload}]
    // sorted descending by score — best match first.
    // k=5 gives majority vote headroom even with mixed-intent messages.
    const hits = _plannerCache.searchK(queryVec, 5);
    if (!hits || hits.length === 0) return null;

    // Filter to planner namespace only — ignore CACHE/MEMORY vectors
    const plannerHits = hits.filter((h) => h.namespace === "PLANNER");
    if (plannerHits.length === 0) return null;

    // Best score check before committing to a vote
    const topScore = plannerHits[0].score;
    if (topScore < SEMANTIC_SCORE_THRESHOLD) return null;

    // Majority vote — payload field stores the intent string (set in addWithMeta)
    // Fall back to _idToIntent map if payload is empty for any reason
    const intentVotes = {};
    for (const hit of plannerHits) {
      const intent = hit.payload || _idToIntent.get(hit.id);
      if (intent) {
        intentVotes[intent] = (intentVotes[intent] ?? 0) + 1;
      }
    }

    const winner = Object.entries(intentVotes)
      .sort((a, b) => b[1] - a[1])[0];

    return {
      intent: winner[0],
      score:  topScore,
      votes:  intentVotes,
    };
  } catch (err) {
    console.warn(`[Planner] ⚠️ Semantic lookup failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core planner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confidence threshold for trusting regex without semantic fallback.
 * 0.3 = regex winner must be 30% more dominant than runner-up.
 * Below this → embed and use HNSW.
 */
const REGEX_CONFIDENCE_THRESHOLD = 0.3;

/**
 * Minimum semantic similarity score to trust HNSW result.
 * Below this → fall back to CHAT (safe bypass).
 */
const SEMANTIC_SCORE_THRESHOLD = 0.45;

/**
 * Plan which capabilities this request needs.
 *
 * Decision order:
 *   1. hasPriorTools       → always full arsenal (mid-session safety)
 *   2. Empty message       → bypass (nothing to classify)
 *   3. Scored regex        → classify, check confidence
 *   4. Low confidence      → semantic HNSW lookup
 *   5. Low semantic score  → context signal check (file/symbol ref)
 *   6. Fallback            → CHAT bypass
 *
 * @param {object} payload        - Normalized OpenAI-format payload
 * @param {object} sessionState   - { hasPriorTools, trueBaselineTokens }
 * @param {object} onnxEmbedder   - Embedder instance (for semantic fallback)
 * @returns {Promise<PipelineDecision>}
 *
 * @typedef {object} PipelineDecision
 * @property {Set<string>} capabilities - Which capabilities to inject
 * @property {string}      intent       - Classified intent name
 * @property {string}      method       - Classification method used
 * @property {boolean}     bypass       - true = inject nothing
 * @property {object}      [debug]      - Scores, votes for logging
 */
export async function planPipeline(payload, sessionState, onnxEmbedder) {
  const { hasPriorTools } = sessionState;

  // ── 1. Session override ───────────────────────────────────────────────────
  // Never yank tools from an agent mid-conversation.
  if (hasPriorTools) {
    return {
      capabilities: FULL_CAPABILITY_SET,
      intent:  "MID_SESSION",
      method:  "prior_tools",
      bypass:  false,
    };
  }

  const lastMsg = extractLastUserMessage(payload);

  // ── 2. Trivial message guard ──────────────────────────────────────────────
  if (!lastMsg.trim()) {
    return {
      capabilities: EMPTY_CAPABILITY_SET,
      intent:  "TRIVIAL",
      method:  "empty_message",
      bypass:  true,
    };
  }

  // ── 3. Scored regex classification ───────────────────────────────────────
  const regexResult = scoreIntents(lastMsg);

  // ── 4. Confidence gate ────────────────────────────────────────────────────
  // High confidence → trust regex, skip embedding (saves 2-4ms per request).
  // Low confidence  → use semantic HNSW lookup.
  let finalIntent = regexResult.intent;
  let method      = "regex";
  let debugInfo   = {
    regexScores:     regexResult.allScores,
    regexConfidence: regexResult.confidence,
  };

  if (regexResult.confidence < REGEX_CONFIDENCE_THRESHOLD) {
    const semResult = await semanticLookup(lastMsg);

    if (semResult && semResult.score >= SEMANTIC_SCORE_THRESHOLD) {
      finalIntent              = semResult.intent;
      method                   = "semantic";
      debugInfo.semanticScore  = semResult.score;
      debugInfo.semanticVotes  = semResult.votes;
      console.log(
        `[Planner] 🧠 Semantic: "${lastMsg.slice(0, 50)}" → ${finalIntent} ` +
          `(score: ${semResult.score.toFixed(3)}, votes: ${JSON.stringify(semResult.votes)})`,
      );
    } else {
      // Low regex + low semantic = genuinely ambiguous.
      // Last signal: file/symbol reference in the message → at least SEARCH.
      const hasFileRef =
        /\.(js|ts|py|go|rs|jsx|tsx|java|rb|cpp)\b|function |class |const |route|endpoint|middleware/i
          .test(lastMsg);

      if (hasFileRef) {
        finalIntent = "SEARCH";
        method      = "context_signal";
        console.log(`[Planner] 📁 Context signal: file/symbol reference → SEARCH`);
      } else {
        finalIntent = "CHAT";
        method      = "fallback";
      }
    }
  }

  const capabilities = CAPABILITY_MATRIX[finalIntent] ?? EMPTY_CAPABILITY_SET;
  const bypass       = capabilities.size === 0;

  return {
    capabilities,
    intent: finalIntent,
    method,
    bypass,
    debug: debugInfo,
  };
}