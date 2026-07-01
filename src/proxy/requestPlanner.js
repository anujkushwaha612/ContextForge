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
 *
 *   3. SemanticCache HNSW semantic fallback — uses the existing
 *      plannerCache (seeded at startup) to classify ambiguous
 *      messages like "make it better" or "something seems off".
 *
 *   4. Capability Set output — planner returns a Set of capability
 *      strings. Extensible without touching the decision matrix.
 *
 *   5. CONTINUATION carries forward the last known capability set
 *      instead of always returning FULL. This prevents tool
 *      re-injection on every follow-up turn.
 *
 * Capabilities:
 *   GRAPH  — contextforge_query_graph
 *   PATCH  — contextforge_patch_ast
 *   READ   — contextforge_read_file_chunk
 *
 * Intent → Capability mapping (corrected):
 *   PATCH    → { PATCH }                    targeted edit, scope known
 *   DEBUG    → { GRAPH, PATCH, READ }       exploratory fix, scope unknown
 *   SEARCH   → { GRAPH, READ }              read-only exploration
 *   CREATE   → { PATCH }                    write new file, no exploration needed
 *   CHAT     → { }                          bypass entirely
 */

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

export const CAPABILITIES = Object.freeze({
  GRAPH: "GRAPH",
  PATCH: "PATCH",
  READ: "READ",
  MEMORY: "MEMORY",
  AST: "AST",
  CACHE: "CACHE",
});

// ─────────────────────────────────────────────────────────────────────────────
// Scored regex patterns
// All patterns are evaluated — scores accumulate per intent.
// Each pattern carries a weight: strong signals score 2+, weak score 1.
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
    regex: /\bfix\s+(typo|spelling|indent|format)\b/i,
  },
  {
    intent: "PATCH",
    weight: 2,
    regex: /\bchange\b|\bsplit\b|\bextract\b|\brefactor\b|\bconvert\b|\binline\b/i,
  },
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
    regex: /\bremove\b|\bdelete\b/i,
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
  // NOTE: \badd\b and \binsert\b intentionally removed from CREATE —
  // they are stronger PATCH signals and caused CREATE+PATCH multi-task
  // collisions that previously forced every add/insert into DEBUG.
  {
    intent: "CREATE",
    weight: 2,
    regex: /\bcreate\b|\bgenerate\b|\bscaffold\b/i,
  },
  {
    intent: "CREATE",
    weight: 2,
    regex: /\bbuild\b|\bimplement\b|\bwrite\b/i,
  },
  {
    intent: "CREATE",
    weight: 3,
    regex: /make a .*new|add a .*new|start a .*new/i,
  },
  {
    intent: "CREATE",
    weight: 3,
    regex: /\bnew file\b|\bnew (module|component|service|controller|route|helper|util)\b/i,
  },

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
  {
    intent: "CHAT",
    weight: 1,
    regex: /tell me about|what is the difference/i,
  },
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
 *
 * FIX: Removed the multi-task CREATE+PATCH → DEBUG forced override.
 * That heuristic caused any message with "add" (PATCH) + "create" (CREATE)
 * to force DEBUG with confidence 1, bypassing semantic lookup entirely
 * and always returning FULL_CAPABILITY_SET.
 *
 * The correct behavior: let the winner win. If the scores are ambiguous,
 * the confidence will naturally be low and semantic lookup will run.
 *
 * Returns { intent, score, confidence, allScores, matchedPatterns }
 */
function scoreIntents(message) {
  const scores = {
    PATCH: 0,
    DEBUG: 0,
    SEARCH: 0,
    CREATE: 0,
    CHAT: 0,
  };

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
  const confidence = totalScore === 0 ? 0 : (winnerScore - runnerScore) / totalScore;

  return {
    intent: totalScore === 0 ? "CHAT" : winnerIntent,
    score: winnerScore,
    confidence: totalScore === 0 ? 0 : confidence,
    allScores: scores,
    matchedPatterns,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability matrix
//
// FIX: CREATE now maps to { PATCH } only.
//   Old: CREATE → { GRAPH, READ }  (speculative exploration before scaffolding)
//   New: CREATE → { PATCH }        (write the file, ask for context if needed)
//
// Rationale: The LLM already knows how to create a file. Pre-injecting GRAPH
// and READ speculatively on every CREATE task adds ~24,000 tokens of tool
// schema for no benefit. If the LLM needs to read an existing file for
// context (e.g. to match a pattern), it will call READ explicitly.
//
// FIX: PATCH now maps to { PATCH } only.
//   Old: PATCH → { GRAPH, PATCH, READ }  (targeted edit but with full exploration)
//   New: PATCH → { PATCH }               (targeted edit, scope is already known)
//
// Rationale: A targeted PATCH task ("rename variable X to Y") does not need
// graph traversal. The comment "targeted edit (known scope)" contradicted
// the actual GRAPH+READ injection. Scope is known → no exploration needed.
// ─────────────────────────────────────────────────────────────────────────────

const CAPABILITY_MATRIX = {
  PATCH: new Set([CAPABILITIES.PATCH]),
  DEBUG: new Set([CAPABILITIES.GRAPH, CAPABILITIES.PATCH, CAPABILITIES.READ]),
  SEARCH: new Set([CAPABILITIES.GRAPH, CAPABILITIES.READ]),
  CREATE: new Set([CAPABILITIES.PATCH]),
  CHAT: new Set(),
};

const FULL_CAPABILITY_SET = new Set([CAPABILITIES.GRAPH, CAPABILITIES.PATCH, CAPABILITIES.READ]);

const EMPTY_CAPABILITY_SET = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// Semantic anchor store
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
    "create a new file",
    "make a new helper",
    "scaffold a new service",
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

let _plannerCache = null;
let _embedder = null;
let _plannerReady = false;
const _idToIntent = new Map();

/**
 * Initialize the planner at startup.
 * Seeds the shared SemanticCache with anchor phrases.
 */
export async function initPlanner(onnxEmbedder, semanticCache) {
  _embedder = onnxEmbedder;
  _plannerCache = semanticCache;

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
        // anchor embedding failure is non-fatal — regex fallback still works
      }
    }
  }

  _plannerReady = true;
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
 * Returns null if planner not ready, timeout, or score below threshold.
 */
async function semanticLookup(message) {
  if (!_plannerReady || !_embedder || !_plannerCache) return null;

  try {
    const queryVec = await Promise.race([
      _embedder.embed(message),
      new Promise((_, reject) => setTimeout(() => reject(new Error("embed timeout")), 2000)),
    ]);

    const hits = _plannerCache.searchK(queryVec, 5);
    if (!hits || hits.length === 0) return null;

    const plannerHits = hits.filter((h) => h.namespace === "PLANNER");
    if (plannerHits.length === 0) return null;

    const topScore = plannerHits[0].score;
    if (topScore < SEMANTIC_SCORE_THRESHOLD) return null;

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
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core planner
// ─────────────────────────────────────────────────────────────────────────────

const REGEX_CONFIDENCE_THRESHOLD = 0.5;
const SEMANTIC_SCORE_THRESHOLD = 0.2;

/**
 * Plan which capabilities this request needs.
 *
 * Decision order:
 *   1. originHint=CONTINUATION  → carry forward last known capabilities
 *                                  (not FULL — only what the task needs)
 *   2. hasPriorTools            → full arsenal (mid-session safety net,
 *                                  but only if origin detection also agrees)
 *   3. Empty message            → bypass
 *   4. Scored regex             → classify, check confidence
 *   5. Low confidence           → semantic HNSW lookup
 *   6. Low semantic score       → context signal check
 *   7. Final fallback           → CHAT bypass (safe default)
 *
 * FIX: CONTINUATION no longer returns FULL_CAPABILITY_SET unconditionally.
 * Instead it returns whatever the CAPABILITY_MATRIX says for the classified
 * intent from the actual message content. This prevents the situation where
 * a short acknowledgment in a CONTINUATION turn still injects all three tools.
 *
 * FIX: hasPriorTools no longer short-circuits to FULL_CAPABILITY_SET.
 * It now sets a flag that is used AFTER intent classification to ensure
 * we include PATCH capability (so the agent can keep patching mid-session)
 * without forcing GRAPH injection when it isn't needed.
 */
export async function planPipeline(payload, sessionState, onnxEmbedder) {
  const { hasPriorTools, originHint } = sessionState;

  const lastMsg = extractLastUserMessage(payload);

  // ── 0. Trivial message guard ──────────────────────────────────────────────
  if (!lastMsg.trim()) {
    return {
      capabilities: EMPTY_CAPABILITY_SET,
      intent: "TRIVIAL",
      method: "empty_message",
      bypass: true,
      debug: { evidence: ["empty_user_message"], regexConfidence: null },
    };
  }

  // ── 1. Scored regex classification (always runs first) ───────────────────
  // Run this before any origin/session checks so we always have an
  // intent-based capability set to work with.
  const regexResult = scoreIntents(lastMsg);

  const evidence = [
    `role=user`,
    `message_len=${lastMsg.length}`,
    `regex_winner=${regexResult.intent}`,
    `confidence=${regexResult.confidence.toFixed(2)}`,
    `scores=${JSON.stringify(regexResult.allScores)}`,
  ];

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

  // ── 2. Semantic fallback for low-confidence regex ─────────────────────────
  let finalIntent = regexResult.intent;
  let method = "regex";

  if (regexResult.confidence < REGEX_CONFIDENCE_THRESHOLD) {
    evidence.push(`confidence_below_threshold=${REGEX_CONFIDENCE_THRESHOLD}`);

    const semResult = await semanticLookup(lastMsg);

    if (semResult && semResult.score >= SEMANTIC_SCORE_THRESHOLD) {
      finalIntent = semResult.intent;
      method = "semantic";
      debugInfo.semanticScore = semResult.score;
      debugInfo.semanticVotes = semResult.votes;
      evidence.push(`semantic_score=${semResult.score.toFixed(3)}`);
      evidence.push(`semantic_winner=${semResult.intent}`);
    } else {
      if (semResult) {
        evidence.push(`semantic_score=${semResult.score.toFixed(3)} (below threshold)`);
      } else {
        evidence.push(`semantic_lookup=null (planner not ready or embed failed)`);
      }

      // Context signal: only upgrades CHAT → SEARCH, never overrides others
      const hasFileRef =
        /\.(js|ts|py|go|rs|jsx|tsx|java|rb|cpp)\b|function |class |const |route|endpoint|middleware/i.test(
          lastMsg
        );

      if (hasFileRef && regexResult.intent === "CHAT") {
        finalIntent = "SEARCH";
        method = "context_signal";
        evidence.push(`context_signal=file_or_symbol_reference`);
        evidence.push(`chat_upgraded_to_search=true`);
      } else {
        // Low confidence, semantic failed — safe default is CHAT (bypass)
        // EXCEPT: if the message clearly has CREATE or PATCH signals,
        // keep those — "create a file" with 0.14 confidence is still CREATE.
        // Only fall to CHAT if total score is very low (< 3).
        const totalScore = Object.values(regexResult.allScores).reduce((a, b) => a + b, 0);
        if (totalScore < 3 && regexResult.intent === "CHAT") {
          finalIntent = "CHAT";
          method = "safe_fallback";
          evidence.push(`low_total_score=${totalScore}_fallback_to_chat`);
        } else {
          finalIntent = regexResult.intent;
          method = "regex_fallback";
          evidence.push(`low_confidence_kept_regex_winner=${regexResult.intent}`);
        }
      }
    }
  }

  // ── 3. Resolve capabilities from intent ───────────────────────────────────
  let capabilities = CAPABILITY_MATRIX[finalIntent] ?? EMPTY_CAPABILITY_SET;

  // ── 4. Origin and session adjustments ────────────────────────────────────
  // These adjust the capability set AFTER intent classification.
  // They do NOT override the classification — they can only expand it,
  // and only when there is structural evidence to do so.

  if (originHint === "CONTINUATION" || hasPriorTools) {
    // We are mid-session. The agent may need to keep patching.
    // Ensure PATCH capability is always present in continuations
    // so the agent is not left without its primary action tool.
    // But do NOT force GRAPH — if the intent doesn't need it, don't add it.
    if (capabilities.size > 0) {
      // Only expand if we are already injecting something.
      // A CHAT-classified continuation stays bypassed.
      const expanded = new Set(capabilities);
      expanded.add(CAPABILITIES.PATCH);
      capabilities = expanded;
      evidence.push(`continuation_patch_ensured=true`);
    }

    if (originHint === "CONTINUATION") {
      evidence.push(`origin=CONTINUATION`);
    }
    if (hasPriorTools) {
      evidence.push(`prior_tools=true`);
    }
  }

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
