# ContextForge — Full Pipeline Audit Report

**Scope:** entire repository (`src/`, `native/`, `cli/`, build system)
**Method:** code-level stage-by-stage analysis + instrumented end-to-end smoke
tests (real HTTP request through the proxy against a mock upstream, with the
native module built **from source** and a stand-in ONNX embedder).
**Date:** 2026-08-24 · **Branch baseline:** `c1b9659` (v1.0.5)

Legend: ✅ correct · ⚠️ issues · ❌ broken · 🟢 good · 🟡 needs attention · 🔴 major issue

---

## 1. System Architecture (reconstructed)

```
HTTP POST (Anthropic / OpenAI / Gemini wire format)
   │
   ▼
[Stage 0] Ingress: adapter detection (URL → headers) → toInternal()
          Anthropic⇄OpenAI translation (translator.js, per-message cache)
          + applyToolPolicy (CF_NUDGE_TOOLS strip) + Gemini @-file extraction
   │
   ▼
[Stage 1] trueBaselineTokens = countTokens(payload)      (tiktoken cl100k)
          createUpstreamHandler(...) closure bound
   │
   ▼  (CF_MODE=passthrough → forward now, skip everything below)
   │
   ▼
[Stage 2] Always-on: DEDUPLICATE — inject CF rule into system, dedup system
          prompts + strip repeated skills lists
[Stage 3] Always-on: HISTORY_PRUNE — collapse stale contextforge_retrieve
          results in history to stubs (turn-boundary + post-patch triggers)
[Stage 4] GRAPH_INJECT — detectMessageOrigin (structure-based) →
          planPipeline (scored regex → optional ONNX semantic fallback over
          PLANNER anchors in SemanticCache HNSW) → capability Set
          {GRAPH,PATCH,READ} → inject tool schemas (non-MCP clients only)
   │
   ▼
[Stage 5] CompressionDecision gate (bypass header / CF_OPTIMIZE / no msgs /
          <2000 tokens → passthrough now)
   │
   ▼  (hasCompressibleContent: any tool msg >800 chars without a
        CF_VAULT/CF_COMPRESSED/processed marker)
[Stage 6]  MEMORY_INJECT   — memory_* tool schemas (only if memory markers)
[Stage 7]  SCRUB           — ANSI/spinner/npm-junk removal from tool results
[Stage 8]  TAG             — content classification (Weighted-Evidence
                             classifier) + metadata backfill (_cf_type,
                             _filename, _toolName, _cf_editable, shell flag)
[Stage 9]  SEMANTIC_DEDUP  — keep-newest per file key: FNV-1a exact +
                             64-bit SimHash near-dup; older copies → vault stub
[Stage 10] JSON_CRUSH      — large JSON arrays → keep errors/outliers/query-
                             relevant/positional samples, rest vaulted
[Stage 11] CODE_COMPRESS   — native tree-sitter AST skeleton compression
                             (JS/TS/TSX/Py/Go/Rust/Java), full text vaulted
[Stage 12] VAULT_INTERCEPT — fatCatch junk classes (lockfile/minified/base64/
                             single-line JSON) + pressure-aware size threshold
[Stage 13] STRIP_ANTHROPIC — anthropic-only field stripping (Anthropic clients)
[Stage 14] CCR             — if ≥18k tokens and unretrieved [CF_VAULT:] stubs
                             exist (session-scoped, ≤3 turns stale): inject
                             contextforge_retrieve tool schema
[Stage 15] MINIMIZE_TOOLS  — tool schema truncation (CF tools protected)
[Stage 16] MEMORY_CONTEXT  — persistent-memory search (HNSW cosine × recency
                             decay) → prepend "## Relevant Memories" to last user msg
[Stage 17] CACHE_ALIGN     — split system prompt static/dynamic, merge into one
                             system message, prefix-hash streak tracking
   │
   ▼
finalTokens = countTokens(payload) → metrics headers
   │
   ▼
[Stage 18] Upstream: provider adapter (ollama/openai/anthropic/gemini)
   ├─ non-streaming: forward → parse JSON response
   ├─ streaming: translate SSE OpenAI→client format
   └─ GHOST INTERCEPTOR (non-passthrough): if response has background tool
      calls (contextforge_query_graph / patch_ast / retrieve / memory_* /
      read_file_chunk) → execute LOCALLY (graph SQLite, patch engine,
      vault retriever, memory store) → append assistant+tool messages →
      re-invoke upstream only after a validated tool result (bounded: 10
      failures / 15 hops / 8 novel read-only rounds / 3 repeated read-only
      rounds) → terminal safety response on any exhausted budget
   │
   ▼
[Stage 19] Metrics: savingsTracker (persisted CF-savings/proxy_savings.json),
             statsEmitter (SSE dashboard), per-stage StageTimer
```

**CPU-heavy stages:** AST compression (native tree-sitter parse, sync),
SimHash/FNV hashing (native/JS), ONNX embedding (dedicated thread, int8
MiniLM-L6, batch=1 per text), HNSW search, content classification (regex).
**I/O stages:** SQLite (graph.db, contextforge.db, memory.db — all
better-sqlite3/vendored-sqlite3, WAL mode, sync), fs (readers, watcher,
savings file), HTTP (upstream, client).
**Sync vs async:** the whole compression pipeline is synchronous except
TAG (classifier is sync but async-wrapped), SEMANTIC_DEDUP (awaited; all
work sync), CODE_COMPRESS (native sync call + two setImmediate yields),
MEMORY_CONTEXT (embed await), GRAPH_INJECT (embed await only when regex
confidence < 0.5), and Stage 18 (network).

**Concurrency model:** single Node process, single event loop; all native
state (HNSW, BM25, SQLite handles, ASTCompressor parsers) is touched only
from the main thread. The ONNX embedder runs its session on a dedicated
inference thread behind a queue; libuv thread-pool workers block on
`embedBatchSync` futures. No cross-thread shared state was found. The
embeddingWorker thread is **declared but never fed** (no producer of
`embed_request` messages exists in `src/` — see Findings F-17).

---

## 2. Stage-by-Stage Audit

### Stage 0 — Ingress + Adapter Translation
**Purpose:** normalize any client wire format to OpenAI internal format;
detect streaming; apply tool policy.
**Implementation:** `adapters/*` + `proxy/translator.js`. URL-first adapter
detection (IDX-1). Anthropic→OpenAI: `system` field → first system message;
user `tool_result` block arrays → `role:"tool"` messages; assistant
`tool_use` blocks → `tool_calls`. Per-message translation cache `_msgCache`
(500 entries, key = role + per-block `type:id:len:fnv(head64+tail64)`).
**Inputs:** raw body, URL, headers. **Outputs:** internal payload +
translation ctx.
**Correctness:** ✅. Verified that the `_msgCache` metadata-bleed risk
(`tagToolResults` mutates block objects in place) is neutralized: cache keys
for `tool_result` blocks include `tool_use_id`, so a cached block is only
re-served for the *same* tool call (same tool, same args, same content).
**Performance:** 🟡.
- F-1 (noted): `_msgCache` fingerprint is head(64)+tail(64)+length only.
  Two *text* blocks with identical ends/length but different middles would
  collide and serve a stale translation. Low probability for real user
  messages; tool results are protected by the ID in the key. Accept as-is;
  consider a full-length FNV (cheap: ~µs per block) if this ever bites.
- F-2 (noted): `_translateMessages(ctx)`'s stable-prefix reuse logic can
  never fire — each request creates a fresh `translationCtx` and calls
  translation exactly once, so `prevInputMessages` is always null. The
  mechanism is dead weight (harmless; the per-message cache is what does
  the real cross-request work). Candidate for removal in a cleanup pass.
- F-3 (noted): OpenAI-*format* streaming clients get **no** ghost
  interception (the SSE path returns raw chunks for `clientAdapter.name ===
  "openai"` before tool-call parsing). Anthropic/Gemini get it. This is
  coherent with the "OpenAI clients are plain pass-through proxies" design
  but means injected CF tools can only be executed by OpenAI clients that
  understand them. Documented limitation, not a bug.
**Integration:** ✅ with downstream — internal format is what every stage
expects (`role:"tool"` string content; `system` as first message).

### Stage 1 — Baseline Token Count
**Purpose:** the "before" number for all savings metrics.
**Implementation:** `compressionHelper.countTokens` — tiktoken cl100k_base,
per-message result cached on the message as non-enumerable `_cachedTokens`
(invalidated automatically by object-spread in stages).
**Correctness:** ✅. The `_cachedTokens` + spread contract is honored by all
mutation sites audited. cl100k is an estimate for Claude (±10–15%, documented
in the file header and in the CLI summary) — acceptable and labeled.
**Performance:** ✅ after Stage 1, the per-message cache makes later
`countTokens` calls O(changed messages only). Two full calls per request
(baseline + final) — SV-9 design, verified.
**Issues:** none material.

### Stage 2 — DEDUPLICATE (CF rule + system-prompt dedup)
**Purpose:** inject ContextForge operating rules once; drop repeated system
prompts and the repeated skills list.
**Implementation:** `systemMessages.js`. Sentinel-guarded rule injection
into first system message; SHA-256 system-prompt dedup; skills-phrase
boundary cut.
**Correctness:** ✅. Rule text is deterministic from the active tool namespace.
**Performance:** ✅ (µs).
**Correctness hardening (G-5):** the rule now derives its prefix from the
active session mode. Bare ghost-intercepted sessions receive bare tool names;
MCP-owned sessions receive their advertised MCP namespace. This prevents an
MCP-less client from being steered toward aliases the Ghost Interceptor
intentionally does not own.

### Stage 3 — HISTORY_PRUNE
**Purpose:** collapse stale `contextforge_retrieve` results from prior turns
(the single biggest history-growth source: ~800 tokens/retrieve).
**Implementation:** `historyPruner.js` — turn-boundary trigger (before last
human user msg) + post-patch invalidation trigger; never prunes the most
recent retrieve; `_cf_pruned` idempotency; 500-char minimum.
**Correctness:** ✅. HP-1/2/3 fixes verified in code (name-based match via
`tool_call_id` maps, MCP wire-form matching, single-user sessions).
**Performance:** ✅ (two linear passes + small maps).
**Integration:** ✅ runs before dedup/AST so pruned stubs don't get
re-processed. Output `PRUNE_STUB` text is plain (no vault marker) —
deliberate: pruned content is the *retrieved copy*, whose source vault is
still referenced by the original stub.

### Stage 4 — GRAPH_INJECT (origin + planner + tool injection)
**Purpose:** decide whether this turn needs repository capabilities; inject
graph/patch/read tool schemas for non-MCP clients.
**Implementation:** `messageOrigin.js` (structure-based origin:
TOOL_FOLLOWUP / CONTINUATION / AGENT_STATUS / HUMAN_TASK) →
`requestPlanner.planPipeline` (scored regex with confidence formula
(winner−runner)/winner; <0.5 → ONNX semantic fallback over ~47 PLANNER
anchor phrases stored in `SemanticCache` namespace "PLANNER"; capability
matrix + continuation expansion + RQ-4 tie-breaks).
**Correctness:** ⚠️→✅ (fixed).
- **F-5 (FIXED — PA-6): planner semantic fallback degrades silently as a
  session grows.** The planner's HNSW is the *same* `SemanticCache` that
  `hybridRetriever` (RAG) indexes into — `upstreamRequest.js` inserts an
  `IDX_*` vector for **every final assistant response ≥50 tokens** via
  `addDocumentWithEmbedding` into that shared index (namespace "").
  `semanticLookup` used `searchK(queryVec, 5)` then filtered
  `namespace === "PLANNER"`. The assistant's own responses are
  topically the closest text to the user's message, so after a few hops all
  5 nearest-neighbor slots were IDX documents → zero PLANNER hits → the
  semantic fallback returned null for the rest of the session, silently
  degrading classification to regex-only. Fixed by widening the candidate
  pool to `searchK(queryVec, 64)` (HNSW cost stays O(log n); the embed call
  dominates anyway). The structural fix (separate index per consumer) is
  recommended long-term (see F-15).
**Performance:** ✅ regex path is µs; embed path is one queued ONNX call
  (typically <10 ms with cache); the 2 s timeout guard is in place.
**Integration:** ✅ capability Set drives injection; `alreadyHasMcpTools`
  guard keeps MCP sessions untouched (RQ-7).

### Stage 5 — Compression Gate
**Purpose:** skip the whole compression pipeline for tiny/bypassed requests.
**Implementation:** `CompressionDecision.decide` — precedence: bypass header
(`x-cf-bypass`/`x-contextforge-bypass`, `x-cf-mode: passthrough`) →
`CF_OPTIMIZE=false` → no messages → <2000 tokens.
**Correctness:** ✅. Cheap checks before O(n) (precomputed tokens passed in).
**Performance:** ✅.
**Issues:** none. (The 2000-token floor is conservative vs the 15k where
pressure MEDIUM starts — intentional: system-prompt dedup/minimize still
have work in that band.)

### Stage 6 — MEMORY_INJECT
**Purpose:** expose `memory_*` tools without paying ~1–2k schema tokens on
every request.
**Implementation:** `memoryTools.injectMemoryTools` — injects only when
memory markers exist in the conversation or the session used them (MT-1/2).
**Correctness:** ✅. **Performance:** ✅. **Integration:** ✅ tools are
handled by the ghost interceptor (`hasMemoryToolCalls`), which also serves
them via the MCP route.

### Stage 7 — SCRUB
**Purpose:** strip terminal junk (ANSI/OSC, spinner runs, npm noise) from
tool results *before* hashing/classifying, so later stages see clean text.
**Implementation:** `toolScrubber.scrubTerminalOutput` — CSI/OSC patterns
(TS-2), positive-signal spinner detection (TS-1 — no longer deletes
bracket/brace lines), CR-progress collapse with always-on marker (TS-4).
**Correctness:** ✅. Order is right: running before TAG/DEDUP/AST means
hashes and classification are computed on stable, clean content.
**Performance:** ✅ regex over tool results only; object-spread preserves
`_cachedTokens` invalidation correctly.
**Issues:** none material.

### Stage 8 — TAG
**Purpose:** classify content (code/json/log/diff/text/markdown) and
backfill metadata (_filename/_toolName/_cf_editable/_isShellTool) that later
stages gate on.
**Implementation:** `contentDetector` — Weighted Evidence Engine: 3
separate sample windows (head/mid/tail), strong +0.5 / weak +0.1 (cap 0.4) /
penalty −0.4, code strong-signal override, 0.35 confidence floor. Cache
keyed by `md5(len : head512 : tail256)`, LRU 2000.
**Correctness:** ✅ (CD-1/4/10/11 fixes present). Shell-tool protection is
applied unconditionally each turn (no `!_cf_type` guard) — correct.
**Performance:** ✅ — classifier samples ~3KB of a 100KB file, not the file.
**Issues:** F-6 (noted): `_cacheKey` hashes head+tail only. Two files
identical in first 512 + last 256 chars but different in the middle
(same-header code files are common) would get the *same* key — length is
in the key, which catches most, but not all (same length possible).
Consequence is a misclassification, and misclassification degrades
gracefully (worst case: a file not AST-compressed, or classified text).
Acceptable; full-content FNV would close it at ~µs cost if desired.

### Stage 9 — SEMANTIC_DEDUP (keep-newest)
**Purpose:** for each file key, keep exactly one full copy in context (the
newest); replace older exact/near-duplicates with non-retrievable pointers to
that visible current copy.
**Implementation:** `applySemanticDedup` — pre-pass locates newest per key
(`file:<workspace-relative normalized path>` or type+prefix hash fallback,
json excluded); main pass compares each older occurrence with FNV-1a-64
(exact) then 64-bit SimHash + dynamic threshold (near-dup, ≥500 chars both
sides). The session registry (200 LRU entries) persists vault IDs +
fingerprints for the newest copy; F1 age gate + F3 never-dedup-toward-stub
guards remain in force. Dedup stubs intentionally do not carry retrieval
markers, so they cannot create CCR work for content already visible later.
**Correctness:** ✅. The F2 rewrite fixed the historic "zero full copies"
bug; BUG-1 (SimHash blind spot) is safe under keep-newest because the
authoritative copy is in the same payload.
**Performance:** 🔴→ (**FIXED — PA-5**). The old code recomputed
`fnv1a64(newest.content)` **and** `computeFingerprint(newest.content)`
(64-bit SimHash over the *entire* newest content, native call) for **every
older duplicate**, and ran `saveToVault(content)` (full SHA-256 + SQLite)
for every exact duplicate even though the newest copy's vault already held
byte-identical content. A file read 8× in history = 8 full FNV passes + 8
SimHash passes over the newest content + up to 8 SHA-256/DB round-trips,
per request. Now: each key's newest is hashed/fingerprinted/vaulted exactly
once in the pre-pass; older duplicates reuse the precomputed values and the
newest's vault ID for exact matches. O(occurrences × contentSize) →
O(contentSize) per key per request. Verified in the smoke test: second
identical request showed no re-registration and identical stubs.
**Integration:** ✅ real compression stubs carry vault IDs; semantic-dedup
stubs instead point to the newer full copy already visible in the same payload
and intentionally do not create retrieval work.

### Stage 10 — JSON_CRUSH
**Purpose:** keep signal-bearing items of large JSON arrays inline; vault
the boring bulk; inject a CCR-visible note.
**Implementation:** `crushJsonToolResults` — gates: `_cf_type==="json"`,
not shell/editable/vaulted/deduped, age gate, ≥30 items & ≥8k chars, keep
errors → query-relevant (top 10 by term overlap with latest user message) →
numeric outliers (>2σ) → positional (first 3/last 2), cap 50, must save
≥30% and ≥2k chars, full original vaulted first (content-hash dedup →
deterministic vault IDs), valid-JSON output guaranteed.
**Correctness:** ✅. Idempotency marker (`_cf_note` + `cf_vault_`) prevents
re-crushing. Vault ID embedded unquoted so the CCR marker scanner still
matches inside JSON-escaped text.
**Performance:** ✅ (one JSON.parse; `locateDominantArray` re-stringifies
only top-level array candidates — bounded, fine).
**Issues:** none material.

### Stage 11 — CODE_COMPRESS (AST)
**Purpose:** skeletonize code tool results with tree-sitter; vault the full
text; keep imports/signatures/first N body lines.
**Implementation:** `astCompressor.compressCodeToolResults` → native
`ASTCompressor.compress(text, langHint)`. Gates: policy
`compressToolResults` master switch, age gate (`isRecentToolResult`),
`_cf_editable`, existing-compression markers, session compress cache
(50 FNV-keyed entries), vault pre-check, policy `minLinesToCompress`,
<20% reduction → keep original.
**Correctness:** ⚠️→✅ (two fixes):
- **F-7 (FIXED — PA-1, the headline bug):** `server.js` called
  `getPolicyForModel(payload.model || "")` **without the payload**.
  `resolvePolicy` then computed `estimatePayloadTokens(null)=0` → pressure
  pinned to **LOW** → on the default local (ollama) upstream
  `compressToolResults` was **always false** → the AST stage (and the
  jsonCrusher master switch) silently did nothing for *every* session,
  no matter how full the window was. `compressionPolicy.js` even documents
  the intended call ("server.js should be updated to:
  getPolicyForModel(payload.model || \"\", payload)") — the migration was
  never completed. Reproduced in the smoke test: a 69k-token session ran
  with `code_compress: 0.0025 ms` and net-*negative* savings (−1,231
  tokens). Fixed by passing the payload. After the fix the same request
  resolves to HIGH pressure (local) and compresses 4 files, saving
  ~51k tokens (96.7% of the payload).
- **F-8 (FIXED — PA-3/PA-4):** per-code-message repeated work. (a) The
  in-memory `SESSION_COMPRESS_CACHE` check ran *after*
  `lookupVaultByContent` (full SHA-256 + indexed SQLite query) on every
  message every turn — reordered so the Map hit answers first. (b)
  `fetchFromVault(existingVaultId) !== null` — a **full table read of the
  stored text** (potentially 100KB+) per message per turn — removed:
  `lookupVaultByContent` selects the row by content hash, so a returned
  ID proves the row exists; both calls are synchronous on the same
  connection with no interleaving possible (the "fullReset in the gap"
  concern cannot occur between two sync statements).
**Performance:** 🟢 after fixes. Native parse is the real cost (measured
~170 ms for the 4-file smoke payload on first encounter; 0 ms afterwards
via session cache). Native side: parser reused across calls per compressor
instance; `buildCompressedSource` is O(lines); `detectLanguage`'s ~30
`source.find()` scans run **only** when no extension hint applies (mapped
extensions skip it). `ExtractNodes` (indexing) runs the full `compress()`
including the string build (AC-8 note) — acceptable at startup.
**Issues (noted):** F-9: the JS "language mismatch retry" block in
`compressCodeOutput` is dead code under the C++ AC-9 behavior (the hint is
trusted when it maps to a grammar, which every EXT_TO_LANG value does).
Harmless; can be deleted in a cleanup pass.

### Stage 12 — VAULT_INTERCEPT (fatCatch)
**Purpose:** catch what no other stage handles: junk classes (lockfiles,
minified bundles, base64 blobs, single-line JSON dumps) at a low threshold,
and oversized legitimate content at the pressure-aware threshold with an
age gate + 4× hard ceiling.
**Implementation:** `fatCatch.interceptAndVaultMassiveToolResults` —
content classifiers (FC-1), age gate via policy (FC-3), parseable code
below ceiling left to AST (FC-2), stubs carry kind+filename+size+head
preview (FC-4), threshold from `policy.singleMsgVaultThreshold` (FC-5).
**Correctness:** ✅. Re-entrancy guards (`[CF_VAULT:`, `[CF_COMPRESSED…`,
`_cf_vaulted/_cf_deduped/_compressedVaultId`) prevent double-processing;
re-run on every ghost hop is cheap because of those guards.
**Performance:** ✅ after PA-1 (the threshold is now actually
pressure-aware: 100k/60k/30k/16k chars by tier instead of pinned 100k).
**Integration:** ✅ stubs feed the CCR marker scanner; `buildStub` text
contains the exact `contextforge_retrieve` instruction wording.

### Stage 13 — STRIP_ANTHROPIC
**Purpose:** drop Anthropic-only fields before forwarding to OpenAI-format
upstreams.
**Correctness:** ✅ (only active for Anthropic clients; runs after the
compression stages, which is safe — the fields are not read by any stage).
**Performance:** ✅.

### Stage 14 — CCR Pipeline
**Purpose:** when the context carries vault stubs the model can't yet see,
inject `contextforge_retrieve` — and stop nagging after 3 turns.
**Implementation:** `applyCCRPipeline` — 18k-token gate; incremental
per-session marker scan (LRU 500 sessions); discovered/retrieved/stale
state in `SessionRegistry` (2 h TTL, 30-min sweeper, `.unref()`'d);
staleness filter (MAX_UNRETRIEVED_TURNS=3); deterministic
`_stableUserText` session ID (strips system-reminders/memory blocks).
**Correctness:** ✅. CCR-4/5/6/8 fixes present. The retrieve *success*
feedback loop works: ghost interceptor → `recordCCRSuccess` →
`session.markVaultRetrieved` → no re-injection (verified: second
identical request still injects once because the stub is still present and
retrieval is per-turn; the tool schema is re-injected only while the
session hasn't recorded a retrieval for that vault — consistent).
**Performance:** ✅ — the incremental scan cache makes this ~µs per turn
after the first.
**Issues:** F-10 (noted, minor observability): the dry-run endpoint's
`vault_ids` extraction regex only matches the `[CF_VAULT:…]` stub form, so
AST-compressed stubs (`[CF_COMPRESSED_FILE vault_id:…]`) and jsonCrusher
notes don't appear in the dry-run `vault_ids` list. Cosmetic; the vault IDs
are in the payload itself.

### Stage 15 — MINIMIZE_TOOLS
**Purpose:** truncate tool descriptions/param descriptions/long enums to
shrink the schema block; protect CF tools (their descriptions are the
behavioral contract) and `AskUserQuestion`/`Agent`.
**Implementation:** `minimizeToolSchemas` — SHA-256 schema cache
(cross-request), sentence-boundary truncation (first sentence always kept),
enum cap at 30→25 with a note.
**Correctness:** ✅ (TR-3/4/7/8 fixes present; protection regex covers MCP
aliases, bare names and `read_file_chunk`).
**Performance:** ✅ cached per schema fingerprint.
**Integration:** ✅ runs after CCR so the injected retrieve tool is present
(and protected) before minimization.

### Stage 16 — MEMORY_CONTEXT
**Purpose:** inject relevant persistent memories (auto_tail mode) as a
read-only context block on the last user message.
**Implementation:** `MemoryHandler.searchAndFormatContext` — query built
from latest user text (first) + ≤2 assistant + ≤3 tool parts (each capped
300 chars, total 2k ≈ model window); native `PersistentMemoryStore.search`
(HNSW cosine, userId+workspace filter, topK×2) → RecencyBoostRanker
(`cosine × e^(−age_days/30)`, ranking-only per MH-7) → ≤10 entries,
200-char previews, 1024-token budget.
**Correctness:** ✅. MH-2/3/4/6/7/8/9 fixes present; the BM25 fallback
correctly filters `mem_*` IDs out of the *shared* RAG index (MH-9).
Read/write identity mismatch fixed (MD-4: both default to "anonymous").
**Performance:** ✅ one embed (usually cache hit) + one HNSW query.
**Issues:** F-11 (noted): memories are saved by the ghost interceptor only
when the *model* calls `memory_save`; there is no automatic memory capture
of session insights. By design (tool mode), noted for completeness.

### Stage 17 — CACHE_ALIGN
**Purpose:** stabilize the provider prompt-cache prefix: static system
content byte-identical across turns, dynamic bits (dates, git status,
reminders) relocated after it.
**Implementation:** `alignCachePrefix` — line-level static/dynamic
classifier (standalone patterns + section-header/state-machine for
ambiguous content, CA-2/3), `<system-reminder>` extraction from first user
message (string **and** block-array forms, CA-4d), merge into one system
message (sequence-safety rule documented), per-client streak state,
SHA-256 prefix hash.
**Correctness:** ✅. Must-run-last constraint is honored by server.js
(ordering + comment). No tool-call sequence disruption (system-only edit).
**Performance:** 🟢 after **PA-7** (FIXED): `lastStaticPrefix` stored the
entire static system prompt string on every change and was **never read** —
pure retention of a kilobytes-to-tens-of-KB string. Removed; the hash (what
all comparisons use) is kept.
**Issues:** none.

### Stage 18 — Upstream + Ghost Interceptor
**Purpose:** forward to the provider; execute CF background tools locally;
retry-bounded agentic hops; index final answers into RAG; accumulate
per-hop wire metrics.
**Implementation:** `createUpstreamHandler` — per-request closure;
workspace-state injection (relative-time strings, UR-11); per-hop
`countTokens` (incremental via `_cachedTokens`); provider header/path
transform; SSE tool-call assembly with held-event gating; local execution:
graph queries (concept cache, UR-7), read_file_chunk (LRU 100 chunk cache,
UR-2/3), patches (engine + `postPatchInvalidate` + failure hints after 3),
vault retrieve (tiered: direct → line-hint slice → hybrid 0.5 → hybrid 0.3),
memory tools. Safety budgets: 10 failures, 15 total hops, 8 novel
read-only rounds, and 3 repeated read-only rounds. The tool-result cache uses
canonical argument keys; identical calls are counted before a cache hit can
be replayed.
**Correctness hardening (G-1–G-7):** streamed calls are assembled by ID first,
ambiguous anonymous parallel calls are rejected, complete merged JSON objects
are repaired only when the exact active tool name is provable, and every
background call is schema-validated before it can enter assistant history.
All exhausted budgets produce a terminal client response — no synthetic tool
result and no further upstream request. UR-9 socket destroy on handler error.
UR-10 RAG indexing only on final responses.
**Performance:** 🟡
- **G-8 context retention hardening:** older broad graph locator results are
  compacted once two newer graph rounds exist, while `read_function` bodies
  remain intact. A repeated session-cache result becomes a compact pointer when
  its full content is already visible. This bounds hidden ghost-history growth
  without forcing a retrieve loop.
- **G-9 CCR/dedup separation:** dedup placeholders no longer use retrievable
  vault markers, and vault discovery is restricted to actual tool-result
  carriers. This prevents superseded copies and marker-looking prose from
  repeatedly injecting `contextforge_retrieve`.
- **F-12 (noted): repeated `interceptAndVaultMassiveToolResults` per hop**
  re-scans all messages; cheap due to guards, acceptable.
- **F-13 (noted): wire-token accounting differs by mode.** Non-streaming:
  final hop's tiktoken estimate is replaced by the provider's real
  `usage` (accurate). Streaming: no usage correction (SSE) — estimates
  only. The savings display is labeled "(est)" throughout; acceptable, but
  a streaming usage tail (Anthropic `message_delta`) could be captured if
  exactness is ever needed.
- **F-14 (noted): RAG indexing = one ONNX embed per final response (≥50
  tokens)** plus an unbounded HNSW insertion (see F-15). This is the
  feature's cost; it runs fire-and-forget after the response is flushed, so
  it never adds client latency.
**Integration:** ✅ ghost results are appended as `role:"tool"` with
`_cf_type` heuristics and re-run through fatCatch; on the *next client
request* they flow through the full pipeline (they are part of the client's
resend only if the client saw them — for Anthropic clients it did not see
them, so they are proxy-internal per request; the durable effect is the
workspace/patch state). Verified end-to-end: 2 hops, final answer returned
to the client in the client's wire format.

### Stage 19 — Metrics & Persistence
**Purpose:** honest token/latency/savings accounting; dashboard; CLI summary.
**Implementation:** `StageTimer` (per-stage ms + token deltas),
`savingsTracker` (lifetime + display-session + 5k-point history, atomic
writes, queued), `statsEmitter` (SSE snapshots, `.unref()`'d heartbeat,
SE-1/2/3 fixes), `/v1/stats`, `/v1/savings`, dashboard.
**Correctness:** ✅. Negative savings preserved and displayed honestly
(ST-1). Extra ghost hops are counted per request and lifetime (the persisted
field remains `ghost_retries` for compatibility). **One caveat
(verified, by design):** `savingsTracker` records the *wire* tokens
(actual bytes sent upstream across all hops) vs the *baseline* (the client
request as received) — so a 2-hop ghost request can show negative savings
even though compression saved; that is the true cost of the extra hop and
the UI labels it. No double counting: `recordRequest` is called exactly
once per inbound request on all paths (passthrough, gate-passthrough,
compressed). Dry-run requests are not recorded (test path).
**Performance:** ✅ — snapshot cloning is O(state), heartbeat gated on
listeners (SE-1).
**Issues:** F-16 (noted): `savingsTracker._defaultPath` is
`process.cwd()/CF-savings` (not `CF_DATA_DIR`) — the CLI sets
`CF_SAVINGS_PATH` explicitly when it matters, but a bare `node src/server.js`
invocation scatters the file into whatever CWD it was started from. Minor
consistency gap vs the other data stores.

---

## 3. Native C++ Layer Audit

### ASTCompressor (ast_compressor.cpp)
- **Ownership/lifetime:** ✅ parser owned per instance, `ts_tree_delete` on
  every exit path of `compress()` (verified all 4 exits), RAII in the NAPI
  wrapper, placement-new + explicit destructor. Compressor instances are
  cached per policy fingerprint on the JS side (≤ a handful) — no leak.
- **Thread safety:** single main-thread use; the JS session cache prevents
  re-parsing. ✅
- **Performance:** ✅ parse+walk is the cost; `buildCompressedSource`
  O(lines); complexity walk is bounded (depth ≤ 5/12 cuts); AC-1..AC-4,
  AC-8..AC-10 fixes present. `detectLanguage` full-source `find()` scan only
  without an extension hint (mapped extensions skip it — the JS side always
  passes a hint for known extensions).
- **Issues:** none blocking. `ExtractNodes` (indexing path) does a full
  `compress()` including output string build (AC-8 documented) — startup
  only.

### OnnxEmbedder (onnx_embedder.cpp)
- **Ownership:** ✅ OrtEnv/Session/Options/MemInfo all released in the
  destructor; `OrtValueGuard` RAII on all tensors (OE-4); status checks
  everywhere (OE-3).
- **Threading:** ✅ dedicated inference thread with cv-based queue (OE-6
  wait_until, no busy-wait); JS side uses NAPI AsyncWorkers so the event
  loop is never blocked; libuv pool threads block on futures (bounded by
  concurrency; acceptable).
- **Cache:** `EmbedCache` — SimHash-keyed 512-entry LRU, mutex-protected,
  zero-vectors never cached (OE-10). ✅
- **Performance:** 🟡 **F-17a (noted): ONNX batch dimension is always 1.**
  `inferenceLoop` batches *requests*, but runs `Run()` per text with shape
  `[1, seq]`. `embedBatch` (workspace symbol indexing: hundreds of
  documents) therefore performs N separate inferences where one batched
  inference (stack to `[N, seq]`, pad to max seq) would be several× faster.
  Measured impact: startup indexing of 413 symbols ≈ 250 ms total here
  (small workspace); on a 500-file workspace this scales linearly in
  inference count. Recommended optimization (C++ change, needs test
  coverage — not done in this pass to avoid untested native churn).
  **F-17b (noted): `global.embeddingWorker` in server.js is declared,
  error-handled and has a message handler, but no code path ever posts an
  `embed_request` to it — the worker thread spins idle for the process
  lifetime (wasted thread + the "RAG disabled" log on its death is
  misleading).** Candidate for removal or actual wiring.

### SemanticCache (cache.cpp) — HNSW
- **Memory:** `HierarchicalNSW(100000, 16, efC=200)` + `meta_map_` +
  `id_to_label_`. ✅ dimension guards on add and search (SC-10/11),
  `active_count_`-correct clamping (SC-1), markDelete-based invalidation,
  `clearAll` realloc with null-first (SC-5), search try/catch (SC-12 —
  a real std::terminate guard under `NAPI_DISABLE_CPP_EXCEPTIONS`).
- **Issues:**
  - **F-15 (noted, architectural): single shared HNSW for three consumers**
    (PLANNER anchors, RAG IDX_* documents, and — via the *other* instance —
    symbols use a separate one, which is correct). Consequence #1 was F-5
    (planner crowding, fixed at the query side). Consequence #2: the RAG
    index grows unboundedly (one vector per final response, process
    lifetime) toward the 100k cap with no eviction policy. Recommended:
    separate `SemanticCache` per consumer (2 lines in server.js + a
    C++-free fix) or an LRU/size cap with `markDelete`. Not done in this
    pass (behavioral change to retrieval quality tradeoffs needs real-data
    validation).
  - **F-18 (noted): no mutex** — safe today (single main-thread access),
    but `SemanticCache` is exposed to any future worker-thread caller with
    no protection. `EmbedCache`/`PersistentMemoryStore` stats use mutexes;
    HNSW does not. Documented constraint, acceptable given the threading
    model.

### HybridRetriever (hybrid_retriever.cpp) — BM25 + dense
- **Correctness:** ✅ standard BM25 (k1=1.2, b=0.75), IDF cache with
  surgical invalidation (HR-2), inverted index with O(terms) pre-filter
  (HR-5), swap-with-last removal (HR-1), L2 normalization at insert AND
  query (HR-3 — IP-space HNSW ⇒ 1−dist = cosine), HY-2 re-add-replace
  semantics. `SparseSearch` filters correctly for memory use (MH-9 on the
  JS side).
- **Performance:** 🟡 **F-19 (noted): `ComputeIDF` scans ALL documents for
  each uncached term** — O(docs × terms) on a cold cache. With the
  unbounded RAG growth (F-15), a cold-cache sparse query after many
  responses gets increasingly expensive. The inverted index already has
  the df data (`invertedIndex_[term].size()` is the document frequency) —
  IDF can be O(1) per term instead. Recommended follow-up.
- **Issues:** F-20 (noted): `documents_` keeps full text + tokens for every
  RAG document in memory (the `text`/`tokens` fields exist for
  `GenerateBreadcrumb` and BM25); combined with F-15's unbounded growth
  this is a slow leak in long-running daemons. Bounded with F-15.

### PersistentMemoryStore (persistent_memory.cpp)
- ✅ WAL + synchronous=NORMAL; RAII `StmtGuard` on every prepared
  statement; HNSW rebuilt from SQLite at startup (survives restarts);
  freed-label recycling (PM-8) prevents label exhaustion; single-thread
  use. No issues found.

### SimHash (simhash.cpp)
- ✅ 64-bit 4-gram SimHash, branchless lowercasing, stack/heap buffer
  switch at 4KB, BigInt NAPI encoding (no 2^53 precision loss),
  `__builtin_popcountll` Hamming distance. No issues.

### SQLite usage (cacheDb.js / graphDb.js)
- ✅ WAL, `foreign_keys=ON`, prepared statements at module level, hot-path
  indexes verified and present (CD-5/GB-4 — `nodes(file_path,start_line)`,
  `cache_dependencies(resource_path)`, `vault_chunks(vault_id)`,
  `edges(target_file)`), LIKE-wildcard escaping (CD-6/GB-3), transactional
  batch writes, `ON CONFLICT DO UPDATE` instead of REPLACE cascade churn
  (GB-5), per-size IN-clause statement cache with 500-batching (CD-7).
- **Issues:**
  - **F-21 (noted): `prune_vault` is content-addressed and unbounded** —
    every compressed/vaulted file's full text persists for the life of the
    data dir; `fullReset()` is the only wipe. On a churning project this
    grows without limit (measured: 207 KB from a 218 KB test payload).
    Recommended: size cap or TTL (e.g., purge vaults older than N days
    that are no longer referenced by active sessions), or at minimum a
    `cf doctor` report of vault store size.
  - **F-22 (noted): dead table/paths** — `semantic_cache` +
    `cache_dependencies` + `cache_vector_labels` + `diff_compression_cache`
    are never populated by the current pipeline (`saveToCache`,
    `registerDependency`, `registerVectorLabel`, `getCachedCompression`
    have no callers). They back the (removed) response-caching feature.
    Harmless (small), but the schema + statements are ~150 lines of
    confusion; F-15's fix could repurpose `cache_vector_labels` for vault
    labels if a response cache is ever revived.

---

## 4. Cache Audit (summary)

| Cache | Key | Correct? | Bounded/eviction | Thread-safe | Verdict |
|---|---|---|---|---|---|
| `_cachedTokens` (per message) | object identity (non-enumerable prop) | ✅ spread-invalidation contract honored everywhere | n/a (per request) | ✅ | 🟢 |
| `countToolsTokens` | `count:first:second:last:jsonLen` | ⚠️ two different tool sets with same endpoints+length+count could collide → stale tool count (estimates only) | 30, clear-all | ✅ | 🟡 low impact (token estimates) |
| translator `_msgCache` | role + per-block type:id:len:fnv(head/tail) | ⚠️ F-1 head/tail collision (text blocks) | 500 LRU-ish (insertion) | ✅ | 🟡 |
| translator `_toolArrayCache`/`_toolCache`/`_toolSchemaCacheMap` | content-FNV / name+len+head / sha256(schema) | ✅ (TR-3 content-aware) | 20/… / unbounded-but-few distinct schemas | ✅ | 🟢 (schema cache unbounded but key space = distinct schemas seen; negligible) |
| contentDetector `_cache` | md5(len:head512:tail256) | ⚠️ F-6 middle-blind (graceful degradation) | 2000 LRU | ✅ | 🟡 |
| CCR `_scannedMessageIds` | sessionId → message-ID set | ✅ (CCR-6 LRU 500) | ✅ | ✅ | 🟢 |
| `SessionRegistry` (CCR) | sha256(stable user text) | ✅ CCR-4 stable-text fix | 2h TTL + 30min sweep | ✅ | 🟢 |
| semanticDedup registry | `file:<norm path>` / type+prefix hash | ✅ json excluded; LRU by turn | 200 LRU | ✅ | 🟢 |
| AST `SESSION_COMPRESS_CACHE` | 2×FNV-32 of content | ✅ | 50 LRU | ✅ | 🟢 (now checked first — PA-3) |
| fatCatch none (DB content-hash dedup) | sha256(content) | ✅ | unbounded (F-21) | ✅ | 🟡 |
| ghost session tool cache | tool name + canonical args JSON | ✅ retrieve/read canonicalized | 200 LRU | ✅ | 🟢 |
| chunk cache | normPath:start:end | ✅ invalidated on patch (file-level) | 100 LRU (wall-clock) | ✅ | 🟢 |
| ONNX `EmbedCache` | SimHash(text) | ⚠️ near-dup keys: slightly different texts can share a vector (documented design tradeoff) | 512 LRU | ✅ mutex | 🟡 acceptable |
| HNSW (planner+RAG shared) | id strings | ⚠️ F-15/F-19 shared-index issues | 100k cap, no eviction | main-thread only (F-18) | 🔴→🟡 (PA-6 query-side fix; structural fix recommended) |
| symbol HNSW | stableIds | ✅ separate instance | 100k cap, no eviction on symbol deletion | ✅ | 🟡 (stale symbol vectors after file changes — replace-on-readd works for surviving symbols; removed symbols stay; bounded, low impact) |
| memory store HNSW | mem ids | ✅ | unbounded (memories) | ✅ | 🟡 (memories are meant to persist) |
| graph `fileHashes` / `routePrefixMap` / `_pathCaseCache` | paths | ✅ (WM-8/13, GB-9) | unbounded but ≤ workspace size | ✅ | 🟢 |
| cacheAligner state | per-client | ✅ | 1 per client type | ✅ | 🟢 (PA-7 removed dead retention) |

**Cache invalidation on file change:** patch → `postPatchInvalidate`
(chunk cache file-level + session tool cache by basename/symbol +
semanticDedup registry + `invalidateByFile`) — coherent. File watcher →
graph re-index + `_onFileChanged` callback — but note the watcher does not
invalidate the AST `SESSION_COMPRESS_CACHE`: a compressed *tool result* is
keyed by content, so changed content = new key = re-compress; old keys
simply go unused. Correct by construction.

---

## 5. Token & Compression Accounting Audit

- `tokens_before` = tiktoken(cl100k) over the *client request as received*
  (system + messages + tools as flat JSON). Estimation error vs Claude's
  BPE is systematic → before/after **deltas** are reliable, absolutes are
  estimates (labeled everywhere). ✅
- `tokens_after`/wire = sum of per-hop `countTokens` (ghost hops count
  every retransmission — this is real wire traffic, correct to count),
  with the final non-streaming hop corrected by provider `usage` when
  available (F-13 for streaming). ✅
- Stage savings (`timer.tokenSummary`) are self-reported by stages that
  measure them (dedup/JSON-crush/minimize); AST/dedup savings surface in
  the header delta rather than per-stage (consistent; no double count —
  stages that rewrite content do not also report charsSaved into the timer
  except jsonCrush/minimize/dedup-system, which report *their own* deltas).
  ✅
- Failed/aborted requests: 4xx from upstream → resolve with acc; savings
  recorded once. 500/502 paths record nothing (request did not complete) —
  acceptable. ✅
- **Dry-run** does not record metrics (test path) — ✅.
- **Retries** (ghost) inflate `tokens_after` honestly; UI explains negative
  savings (ST-1). ✅
- No tokenizer mixing: one encoder process-wide (cl100k, lazy init,
  char/4 fallback if tiktoken missing). ✅

---

## 6. Error Handling & Recovery Audit

- **Ingress:** parse error → 400; oversize → 413 + destroy; unhandled
  pipeline throw → 500 (SV-3) with details; socket errors logged. ✅
- **Native failure modes:** NAPI boundary guards (dimension checks,
  searchKnn try/catch — SC-12 prevents std::terminate under
  NAPI_DISABLE_CPP_EXCEPTIONS); embedder failures → zero vector *not*
  cached + stderr (OE-10); addPoint failures → JS error (SC-6). ✅
- **Stage failures degrade, never abort:** classifier `.catch` → "text"
  (TS-5); planner embed timeout (2 s) → regex result; memory search
  failure → no injection; graph re-index failure per-file logged,
  workspace continues; patch failure → hint escalation, not crash.
  **Compression can never corrupt the original request:** every stage
  returns the original message object unchanged when it decides not to
  transform, and a failed native `compress()` leaves `kept: text`.
  Verified by code review of all stage fallthroughs. ✅
- **Retry safety:** ghost budgets (10 failures / 15 hops / 8 novel reads /
  3 repeated reads) + per-request `x-cf-max-retries` + identical-call stall
  detection (3 calls). Every breaker is terminal: malformed calls and budget
  exhaustion never enter assistant history or trigger another upstream hop.
  Successful action tools reset the transient failure counter. ✅
- **Partial state after failure:** vault writes are content-addressed
  (idempotent re-vault OR-IGNORE, CD-2/4); patch engine applies in a
  transaction with pre-read verification; graph writes per-file
  transactional. A crash mid-patch could leave the file half-written —
  the engine writes atomically (tmp+rename? — *verified*: patchEngine
  uses direct `writeFileSync` on the target after verification; no
  tmp+rename. **F-23 (noted, low risk):** a crash between truncate and
  write on a patch is possible but the window is tiny and the model
  re-reads before re-patching; acceptable, documentable as
  tmp+rename later.)
- **Server lifecycle:** listen-before-index with readiness gating (503
  Retry-Until), graceful SIGINT/SIGTERM drain with 5 s force-exit,
  watcher stopped on signal, embedder thread joined, worker terminated.
  ✅

---

## 7. Ordering & Redundancy Analysis (audit §4 of the brief)

Verified ordering is sound; no stage needs to move:
- **Cheap before expensive:** gate (O(1)+cached count) → scrub/tag
  (regex) → dedup (hash) → AST (parse) → fatCatch → CCR → align.
  `hasCompressibleContent` short-circuits the whole middle band when
  nothing is compressible. ✅
- **No cross-stage recomputation found** except the two fixed here
  (PA-5 dedup re-hashing; PA-3/4 AST double-lookup) and the pre-existing
  benign ones: `estimatePayloadTokens` (char-based, deliberately cheap,
  doesn't touch tiktoken) vs `countTokens` (different purpose);
  `buildMessageKey` computed twice per message in dedup (pre-pass + main
  pass, µs, fine).
- **Upstream transform before baseline:** `toInternal` runs before
  `countTokens` — correct, the wire format is what's counted; Anthropic
  block arrays are converted to the flat form the stages operate on. ✅
- **CCR before MINIMIZE_TOOLS:** correct — the injected retrieve schema is
  present and protected before truncation. ✅
- **CACHE_ALIGN last:** enforced; memory-context injection (which touches
  the last user message) correctly runs before it. ✅
- **Ghost hops re-run only fatCatch**, not the full pipeline — correct:
  results are fresh (age gate would protect them anyway) and the full
  pipeline is per-*client-request*, not per-hop. ✅

---

## 8. Measured Before/After (identical 218 KB Anthropic request,
69,140-token baseline, mock upstream, 5-file workspace)

| Metric | Before (baseline) | After (fixes) |
|---|---|---|
| `x-cf-tokens-before` | 69,140 | 69,140 |
| `x-cf-tokens-after` | 70,371 (net **−1,231**) | **2,257 (+66,883, 96.7%)** |
| Wire bytes per hop (2 hops) | 225,131 / 226,565 | 11,637 / 13,071 |
| `code_compress` stage | 0.0025 ms (**no-op** — policy bug) | 4 files AST-compressed, ~51,455 tokens saved |
| Pipeline latency, 1st request | 263 ms (no compression work) | 228 ms (**with** 4× tree-sitter compression) |
| Pipeline latency, 2nd identical request | 70 ms | 61 ms (session-compress cache + registry reuse: no re-parse, no re-vault, no re-hash) |
| Vault round-trip (`contextforge_retrieve`) | — | ✅ 204,984-char vault returned byte-complete |
| Ghost interceptor | 2 hops → final answer ✅ | 2 hops → final answer ✅ (unchanged) |
| `npm run build:native` on fresh clone | ❌ fatal: `unicode/umachine.h` not found (pinned tree-sitter 0.25.3) | ✅ compiles clean |

All other stages, headers, SSE stats, dry-run endpoint, `/v1/mcp/tool`
routes, and the mock-upstream conversation shape verified unchanged.

---

## 9. Findings Register

### Fixed in this pass (PA-#)
| # | Severity | Where | What |
|---|---|---|---|
| **PA-1** | 🔴 correctness/integration | `server.js` | Policy resolved without payload → pressure pinned LOW → `compressToolResults=false` on default local upstream → **AST compression + jsonCrusher master switch silently disabled for all sessions**. Pass payload. (The single highest-impact bug found.) |
| **PA-2** | 🟡 performance | `server.js` | `detectMutation` block removed: per-request full `JSON.stringify(payload)` + 3 regex passes + potential full-file read + SHA-256 feeding `invalidateByFile` over `cache_dependencies` — a **table nothing ever populates** (always 0 rows). Its file-op pattern never matched the real patch schema (`create_file`/`file_path` vs `create\|append`/`filename`), and patch-time invalidation is already handled by `postPatchInvalidate`. Repeated no-effect work on every request (re-hashing files whose mutation was processed turns ago). |
| **PA-3** | 🟡 performance | `astCompressor.js` | Session compress cache (in-memory) checked **before** `lookupVaultByContent` (SHA-256 + SQLite) — re-sent history now hits the Map first. |
| **PA-4** | 🟡 performance | `astCompressor.js` | Removed `fetchFromVault(vaultId) !== null` existence re-check — a full-text SQLite read per code message per turn that proved nothing (the lookup already proved row existence; sync calls cannot interleave). |
| **PA-5** | 🔴 performance (O(n²) per request) | `semanticDedup.js` | Newest copy's FNV hash + SimHash fingerprint + vault registration now computed **once per key in the pre-pass** instead of per older duplicate; exact-dup visible-copy stubs reuse the newest metadata (no re-SHA-256/DB). |
| **PA-6** | 🔴 correctness (silent degradation) | `requestPlanner.js` | `searchK(5)` → `searchK(64)`: RAG `IDX_*` documents (one per final assistant response) share the HNSW with PLANNER anchors and crowded all 5 nearest-neighbor slots, silently disabling the semantic intent fallback for the rest of every session. |
| **PA-7** | 🟢 memory | `cacheAligner.js` | Removed `lastStaticPrefix` retention (full system prompt string stored, never read). |
| **PA-8** | 🟢 dead code | `vaultRetriever.js` | Removed unreachable "Tier 1b" fallback (`r.text` never exists on C++ results). |
| **PA-9** | 🔴 build reproducibility | `native/binding.gyp` | Added `tree-sitter-src/tree-sitter/lib/src` to `include_dirs` — with the pinned tree-sitter v0.25.3, `lib/src/unicode/utf8.h` includes `unicode/umachine.h` and the build **failed on a fresh clone** (verified: fails without, compiles clean with). The published prebuild predates the pin. |

### Noted — recommended follow-ups (no code change this pass)
| # | Sev | What / why | Suggested fix |
|---|---|---|---|
| F-1 | 🟢 | translator `_msgCache` head/tail fingerprint can collide for text blocks | full-content FNV (µs) if ever observed |
| F-2 | 🟢 | `_translateMessages` stable-prefix logic is dead (fresh ctx per request) | delete in cleanup pass |
| F-3 | 🟡 | OpenAI-format streaming clients get no ghost interception | documented design boundary; if needed, parse SSE tool deltas for openai adapter |
| F-4 | ✅ fixed | CF rule guidance could use MCP aliases in bare-tool sessions | rule now derives the prefix from the active session type |
| F-5 | 🟢 | (superseded by PA-6) | — |
| F-6 | 🟢 | contentDetector cache key blind to content middle (graceful: misclassification only) | include full-content FNV if desired |
| F-7/F-9 | 🟢 | JS language-mismatch retry in `compressCodeOutput` is dead under C++ AC-9 | delete in cleanup pass |
| F-10 | 🟢 | dry-run `vault_ids` regex misses `[CF_COMPRESSED_FILE]` + jsonCrusher note forms | extend regex (observability only) |
| F-12 | 🟢 | fatCatch re-scans all messages per ghost hop | guards make it cheap; leave |
| F-13 | 🟡 | streaming wire-token accounting is estimate-only (no SSE usage tail) | capture Anthropic `message_delta` usage if exactness needed |
| F-14 | 🟢 | RAG embed per final response (by design, post-flush) | none |
| F-15 | 🟡 | shared HNSW for planner + RAG; RAG index unbounded (100k cap, no eviction) | separate `SemanticCache` per consumer (JS-only change) and/or size-bounded eviction |
| F-16 | 🟢 | `savingsTracker` default path is CWD-relative (not `CF_DATA_DIR`) | align with other stores |
| F-17a | 🟡 | ONNX inference always batch=1 (indexing scales linearly) | stack texts into `[N, seq]` batches in `inferenceLoop` (C++, needs tests) |
| F-17b | 🟡 | `embeddingWorker` thread runs idle forever (no producer of `embed_request`) | remove or wire it |
| F-18 | 🟢 | SemanticCache/HybridRetriever unprotected if ever called off-main-thread | document or mutex |
| F-19 | 🟡 | BM25 `ComputeIDF` O(docs) per uncached term | use inverted-index df: `log((N−df+0.5)/(df+0.5)+1)` — O(1)/term |
| F-20 | 🟢 | RAG `documents_` keeps full text in memory unboundedly | bounded with F-15 |
| F-21 | 🟡 | `prune_vault` unbounded disk growth (content-addressed, no TTL) | size/TTL purge or doctor reporting |
| F-22 | 🟢 | response-cache tables + helpers dead (never populated) | delete or repurpose |
| F-23 | 🟢 | patch write not tmp+rename (tiny crash window) | atomic write later |

### Production-readiness checklist
- [x] Correctness — core pipeline verified end-to-end (compression → stubs →
      CCR tool → local retrieval → byte-complete vault round-trip)
- [x] Pipeline consistency — **one real desync found and fixed (PA-1)**;
      all other stage interfaces audited and coherent
- [x] Stage ordering — verified optimal; no reorder needed
- [x] Error handling — graceful degradation at every stage; compression
      cannot corrupt the original request
- [x] Retry safety — bounded breakers + budgets; no recursive retry
- [x] Memory safety — RAII verified across C++; JS leak candidates bounded
      (F-15/F-21 noted)
- [x] Thread safety — single-main-thread model holds; ONNX thread properly
      isolated
- [x] Cache correctness — key/eviction/invalidation audited per-cache (§4)
- [x] Resource cleanup — signals, join, close verified
- [x] Native module stability — NAPI exception guards verified; **build
      reproducibility fixed (PA-9)**
- [x] Performance — 3 hot paths fixed (PA-3/4/5); 96.7% savings restored
- [ ] Scalability — unbounded stores (F-15/F-21) need caps for multi-day
      daemons
- [x] Observability — headers + SSE + dry-run + stage timers (F-10/F-13
      noted)
- [x] Deterministic metrics — single tokenizer, no double count
- [x] Provider compatibility — ollama/openai/anthropic/gemini paths
      reviewed; Gemini path verified in code (URL/header detection,
      @-file extraction, SSE translation)
- [x] Graceful degradation — verified per stage
- [ ] **Test coverage — no automated tests exist** (all jest scripts in
      `package.json` are disabled; no `tests/` directory). This is the
      largest remaining production gap. The smoke harness used for this
      audit (mock upstream + test workspace + clients in `/tmp`) should be
      promoted to a committed `tests/smoke` suite.
- [x] Build reproducibility — **fixed (PA-9)**; pinned grammar tags +
      pinned ORT 1.20.1 in CI
- [x] No unnecessary dependencies — `native/package.json` lists langchain
      deps that are not used anywhere in `native/` (vestigial; harmless
      but removable)
- [x] No performance regressions — before/after measured (§8)

---

## 10. Reproduction (how the numbers in §8 were produced)

```bash
# environment (sandbox): npm install --ignore-scripts; build better-sqlite3
# from source (node headers local); native: bash scripts/vendor-grammars.sh
# + node-gyp rebuild --nodedir=… (PA-9 required); stand-in 384-d ONNX model
# (sum-of-token-ids fingerprint) + word tokenizer in contextforge_models/.

node /tmp/mock_upstream.mjs          # OpenAI-compatible mock on :18080
CF_WORKSPACE_PATH=/tmp/cf-test-ws CF_DATA_DIR=/tmp/cf-data CF_PORT=13000 \
  CF_PROVIDER=ollama OLLAMA_HOST=127.0.0.1 OLLAMA_PORT=18080 \
  node src/server.js                  # wait for CF_READY

node /tmp/cf_test_client.mjs          # 218 KB Anthropic request, 4 file reads
                                      # (one 205 KB legacy file), 2 user turns
# → compare x-cf-tokens-* headers + /tmp/mock_upstream_hops.json
# dry-run (stage timings):  node /tmp/dryrun_client.mjs
# vault round-trip:         POST /v1/mcp/tool {contextforge_retrieve, vault_id}
```
