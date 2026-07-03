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
 *   5. CONTINUATION carries forward the classified capability set
 *      instead of always returning FULL. This prevents tool
 *      re-injection on every follow-up turn.
 *
 * Capabilities:
 *   GRAPH  — contextforge_query_graph
 *   PATCH  — contextforge_patch_ast
 *   READ   — contextforge_read_file_chunk
 *
 * Intent → Capability mapping:
 *   PATCH    → { PATCH }                    targeted edit, scope known
 *   DEBUG    → { GRAPH, PATCH, READ }       exploratory fix, scope unknown
 *   SEARCH   → { GRAPH, READ }              read-only exploration
 *   CREATE   → { PATCH }                    write new file, no exploration needed
 *   CHAT     → { }                          bypass entirely
 *
 * Fixes applied:
 *   BUG-8:  \bimport\b removed from SEARCH patterns — fired on "importing it"
 *           inside CREATE instructions, suppressing confidence below threshold
 *           and forcing unnecessary semantic lookup on unambiguous tasks.
 *           Replaced with structurally-anchored import/export query patterns.
 *
 *   BUG-9:  Confidence formula changed from (winner-runner)/total to
 *           (winner-runner)/winner. Previous formula penalized high-signal
 *           messages: CREATE=7, SEARCH=3 → confidence=0.4 (wrong, triggers
 *           semantic). New formula: (7-3)/7 = 0.57 (correct, stays regex).
 *
 *   BUG-10: Semantic anchor phrases audited. Ambiguous phrases that describe
 *           unknown problems ("there is something off", "make it better",
 *           "this seems inefficient") moved from PATCH to DEBUG anchors.
 *           PATCH anchors now only contain genuinely targeted edits with
 *           known scope.
 *
 *   BUG-11: CONTINUATION + hasPriorTools expansion now handles the case
 *           where CHAT was a likely misclassification of a transition message
 *           in an active tool session. If any non-CHAT signals scored > 0,
 *           the highest non-CHAT intent is promoted rather than staying bypassed.
 *
 * Fixes applied (this pass — each verified by reproduction):
 *   RQ-1: CHAT acknowledgment patterns ("thanks", "done", "ok") fired inside
 *         REAL tasks: "now fix the broken auth, thanks" scored CHAT+1,
 *         diluting confidence on an obvious DEBUG task. Ack patterns now
 *         only score when the message is short (≤ 80 chars) — real
 *         acknowledgments are short; embedded courtesy words in task
 *         sentences are not acknowledgments.
 *   RQ-2: DEBUG /\bnull\b|\bundefined\b/ fired on TARGETED EDITS:
 *         "add a null check before this line" scored DEBUG=1, PATCH=0 →
 *         classified DEBUG with confidence 1.0 (verified). Bare null/
 *         undefined now require error context ("is null", "returns
 *         undefined", "null pointer") — mention of the WORD isn't evidence
 *         of a bug hunt.
 *   RQ-3: SEARCH /\bwhere\b/ fired on relative clauses ("create a new file
 *         where we store config"). Now requires interrogative form
 *         ("where is/are/does/do/can/should").
 *   RQ-4: Ties broke by Object-insertion order (PATCH before DEBUG) —
 *         arbitrary. Ties now break toward the intent with the LARGER
 *         capability set (DEBUG ⊃ SEARCH ⊃ PATCH ⊃ CHAT): when unsure,
 *         over-provision tools rather than under-provision — a wrong
 *         bypass costs a failed turn; a wrong extra tool costs a few
 *         schema tokens.
 *   RQ-5: "add ..." had NO pattern in any intent — "add a retry limit to
 *         the upload route" scored zero everywhere → CHAT → bypassed with
 *         no tools. \badd\b now scores PATCH (weight 2).
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
//
// BUG-8 FIX: \bimport\b and \bexport\b removed from SEARCH patterns.
// These words appear in CREATE instructions ("importing it", "wire this in
// by importing") and caused SEARCH to accumulate score on unambiguously
// CREATE tasks, dragging confidence below the 0.5 threshold and triggering
// unnecessary semantic lookup.
//
// Replacement: structurally-anchored patterns that require query context
// ("where is it imported", "what imports this") rather than bare word match.
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
  { intent: "PATCH", weight: 1, regex: /\bremove\b|\bdelete\b/i },
  { intent: "PATCH", weight: 1, regex: /\bclean up\b|\bimprove\b/i },
  // RQ-5: "add X to Y" is the single most common edit instruction and had
  // NO pattern anywhere — "add a retry limit to the upload route" scored 0
  // in every intent → CHAT → bypassed with zero capabilities (verified).
  { intent: "PATCH", weight: 2, regex: /\badd\b/i },

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
    // RQ-2: bare \bnull\b fired on "add a null check before this line" —
    // a targeted PATCH — classifying it DEBUG at confidence 1.0. The WORD
    // is not evidence of a bug; error CONTEXT is.
    regex:
      /\b(is|was|returns?|being|comes? back)\s+(null|undefined)\b|\bnull pointer\b|\bundefined is not\b|\bintermittent\b/i,
  },
  { intent: "DEBUG", weight: 1, regex: /make it better|make this better/i },

  // ── SEARCH signals ────────────────────────────────────────────────────────
  // RQ-3: \bwhere\b alone fired on relative clauses ("create a file where we
  // store config"). Interrogative form required.
  {
    intent: "SEARCH",
    weight: 2,
    regex: /\bfind\b|\blocate\b|\bwhere\s+(is|are|does|do|can|should|did)\b/i,
  },
  { intent: "SEARCH", weight: 2, regex: /which file|show me|list all/i },
  { intent: "SEARCH", weight: 2, regex: /\bcall\b|\bdepend\b|\binternally\b/i },
  { intent: "SEARCH", weight: 1, regex: /\bsymbol\b|\broute\b|\bendpoint\b/i },
  // BUG-8 FIX: Replaced bare \bimport\b|\bexport\b with structurally-anchored
  // patterns. The old pattern fired on "importing it" inside CREATE instructions.
  // New patterns require query framing ("where is X imported", "what exports Y").
  {
    intent: "SEARCH",
    weight: 2,
    regex: /\bwhere\s+is\s+(it\s+)?imported\b|\bwhat\s+imports\b|\bwho\s+imports\b/i,
  },
  {
    intent: "SEARCH",
    weight: 2,
    regex: /\bwhat\s+(does\s+this\s+)?exports?\b|\bwho\s+exports\b/i,
  },
  {
    intent: "SEARCH",
    weight: 1,
    regex: /\bdefined\b|\bdeclared\b/i,
  },

  // ── CREATE signals ────────────────────────────────────────────────────────
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
    // RQ-1: only score acknowledgments on SHORT messages — "now fix the
    // broken auth, thanks" is a task with a courtesy word, not an ack.
    maxLen: 80,
  },
  {
    intent: "CHAT",
    weight: 1,
    regex: /looks good|that works|exactly right|got it|never mind|try again|not quite/i,
    maxLen: 80, // RQ-1: same reasoning
  },
];

/**
 * Score all intents against the message.
 *
 * BUG-9 FIX: Confidence formula changed from:
 *   (winnerScore - runnerScore) / totalScore
 * to:
 *   (winnerScore - runnerScore) / winnerScore
 *
 * Problem with old formula: totalScore grows with the winner's own score,
 * so messages with MORE evidence for the winning intent paradoxically produce
 * LOWER confidence. Example:
 *   CREATE=7, SEARCH=3 → old: (7-3)/10 = 0.40 (triggers semantic — wrong)
 *                       → new: (7-3)/7  = 0.57 (stays regex — correct)
 *
 * The new formula measures the winner's margin as a fraction of its own
 * score (how dominant is it over the runner-up), which is the correct
 * definition of classification confidence.
 *
 * Edge cases:
 *   - winnerScore === 0 (nothing matched) → confidence = 0 (semantic runs)
 *   - winnerScore === runnerScore (perfect tie) → confidence = 0 (semantic runs)
 *   - Only winner scored (runner = 0) → confidence = 1.0 (no semantic needed)
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

  for (const { intent, weight, regex, maxLen } of INTENT_PATTERNS) {
    // RQ-1: patterns can declare a max message length — acknowledgment
    // phrases only count on short messages.
    if (maxLen && message.length > maxLen) continue;
    if (regex.test(message)) {
      scores[intent] += weight;
      matchedPatterns[intent].push(regex.source.slice(0, 60));
    }
  }

  // RQ-4: deterministic tie-break toward the BROADER capability set.
  // Object-insertion order made PATCH beat DEBUG on equal scores — the
  // narrow toolset won exactly when the classifier was least sure. When
  // unsure, over-provision: a wrong bypass costs a failed turn; an extra
  // tool schema costs a few tokens.
  const TIE_PRIORITY = { DEBUG: 4, SEARCH: 3, CREATE: 2, PATCH: 1, CHAT: 0 };
  const sorted = Object.entries(scores).sort(
    (a, b) => b[1] - a[1] || TIE_PRIORITY[b[0]] - TIE_PRIORITY[a[0]]
  );
  const [winnerIntent, winnerScore] = sorted[0];
  const runnerScore = sorted[1]?.[1] ?? 0;

  // BUG-9 FIX: Use winnerScore as denominator, not totalScore
  const confidence = winnerScore === 0 ? 0 : (winnerScore - runnerScore) / winnerScore;

  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);

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
//
// BUG-10 FIX: Anchor phrases audited and reassigned.
//
// PATCH anchors previously contained phrases that describe unknown problems:
//   "there is something off with this"  → moved to DEBUG
//   "this does not look right"          → moved to DEBUG
//   "make it better"                    → moved to DEBUG (unknown problem)
//   "this seems inefficient"            → moved to DEBUG (requires investigation)
//   "can you improve this function"     → moved to DEBUG (scope unknown)
//
// Rationale: PATCH = targeted edit with KNOWN scope. If the scope is unknown
// ("something is off", "make it better"), the agent needs to investigate
// first — that's DEBUG territory which requires GRAPH + READ tools.
// Misclassifying these as PATCH meant the agent tried to edit without first
// understanding where the problem was.
//
// PATCH anchors now only contain phrases where the edit target is explicit
// and contained in the instruction itself.
// ─────────────────────────────────────────────────────────────────────────────

const SEMANTIC_ANCHORS = {
  PATCH: [
    // Genuinely targeted edits — scope is stated in the instruction
    "rename this variable to something clearer",
    "change the return type to string",
    "extract this block into a helper function",
    "update the error message text",
    "clean this up a bit",
    "this needs to be updated with the new field",
    "replace the hardcoded value with a constant",
    "add a null check before this line",
    "remove the console log from this function",
    "swap the order of these two parameters",
  ],
  DEBUG: [
    // BUG-10 FIX: Moved ambiguous phrases from PATCH to DEBUG
    "there is something off with this",
    "this does not look right",
    "make it better",
    "this seems inefficient",
    "can you improve this function",
    // Existing debug anchors (unchanged)
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

  // RQ-6 FIX: CREATE-with-hidden-search-need. "Create a new X, then hunt down
  // and refactor the duplicated logic elsewhere" scores CREATE as the winner
  // (strong \bcreate\b / \bnew file\b patterns) but CAPABILITY_MATRIX.CREATE
  // is {PATCH} only -- no GRAPH. Verified by reproduction: the real-world DRY
  // task ("create services/session.service.js ... then hunt down where we're
  // duplicating this logic in our auth and user controllers and refactor
  // them") scores CREATE=5, PATCH=2, confidence=0.6 -- ABOVE the 0.5 regex
  // threshold, so the semantic fallback (which might otherwise catch this)
  // never runs. The agent needs GRAPH to locate the duplicated call sites,
  // but CREATE's capability set never grants it.
  //
  // Same "when unsure, over-provision" philosophy already applied at
  // tie-break time (RQ-4) and CONTINUATION-promotion time (BUG-11), applied
  // here at initial capability resolution: if CREATE won but PATCH or
  // SEARCH also scored >= 2 (a real pattern match, not incidental noise),
  // the instruction almost certainly also requires locating existing code.
  if (finalIntent === "CREATE") {
    // Any SEARCH pattern match implies "find X" — always a real signal.
    // For PATCH, exclude the bare \badd\b pattern (RQ-5): "create a new
    // file and add a function to it" is pure creation, not a hint that
    // existing duplicated code needs to be located. Real refactor language
    // ("hunt down", "refactor", "duplicating", "change", "extract",
    // "convert") matches the other PATCH patterns instead.
    const patchPatterns = regexResult.matchedPatterns.PATCH ?? [];
    const hasRealPatchSignal = patchPatterns.some((p) => !p.startsWith("\\badd\\b"));
    const hasSearchSignal = (regexResult.matchedPatterns.SEARCH ?? []).length > 0;

    if (hasRealPatchSignal || hasSearchSignal) {
      const expanded = new Set(capabilities);
      expanded.add(CAPABILITIES.GRAPH);
      expanded.add(CAPABILITIES.READ);
      capabilities = expanded;
      evidence.push(
        `create_with_search_signal_expanded=true (patch_patterns=${patchPatterns.length}, search=${hasSearchSignal})`
      );
    }
  }

  // ── 4. Origin and session adjustments ────────────────────────────────────
  //
  // BUG-11 FIX: The previous implementation only expanded capabilities when
  // capabilities.size > 0. This meant a CHAT-classified CONTINUATION turn
  // stayed bypassed even in an active tool session where CHAT was likely a
  // misclassification of a transition message ("ok thanks, now also fix X").
  //
  // New behavior:
  //   Case A: capabilities.size > 0 (non-CHAT intent) → ensure PATCH is present
  //   Case B: capabilities.size === 0 (CHAT intent) in a session with prior tools
  //           → check if any non-CHAT signals scored. If yes, promote to the
  //             highest non-CHAT intent. If no (pure CHAT like "ok thanks"), stay
  //             bypassed — the agent genuinely has nothing to do.
  if (originHint === "CONTINUATION" || hasPriorTools) {
    if (capabilities.size > 0) {
      // Case A: Non-CHAT intent — ensure PATCH is present for continuations
      // so the agent can keep patching without losing its primary action tool.
      // Do NOT add GRAPH unless the intent already requires it — that would
      // re-inject the full tool schema unnecessarily.
      const expanded = new Set(capabilities);
      expanded.add(CAPABILITIES.PATCH);
      capabilities = expanded;
      evidence.push(`continuation_patch_ensured=true`);
    } else if (hasPriorTools && finalIntent === "CHAT") {
      // Case B: BUG-11 FIX — CHAT in an active tool session
      // Check if any non-CHAT regex signals scored. If they did, CHAT was
      // likely a misclassification caused by transition phrasing
      // ("ok thanks, now also fix the auth bug").
      const nonChatEntries = Object.entries(regexResult.allScores).filter(([k]) => k !== "CHAT");
      const totalNonChat = nonChatEntries.reduce((sum, [, v]) => sum + v, 0);

      if (totalNonChat > 0) {
        // Promote to the highest-scoring non-CHAT intent
        const nonChatWinner = nonChatEntries.sort((a, b) => b[1] - a[1])[0];
        finalIntent = nonChatWinner[0];
        capabilities = CAPABILITY_MATRIX[finalIntent] ?? EMPTY_CAPABILITY_SET;

        // Ensure PATCH is present for the promoted intent too
        const expanded = new Set(capabilities);
        expanded.add(CAPABILITIES.PATCH);
        capabilities = expanded;

        evidence.push(
          `continuation_chat_promoted_to=${finalIntent} (non_chat_score=${totalNonChat})`
        );
      }
      // If totalNonChat === 0 (pure CHAT — "ok thanks", "looks good"),
      // stay bypassed. The agent genuinely has nothing to do this turn.
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
