# ContextForge vs Headroom — Competitive Analysis

**Subject:** [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) @ `4408e88` (main, Aug 24 2026)
**Method:** shallow clone of their repo + code-level review of `crates/headroom-core`,
`crates/headroom-proxy`, the Python package, and — most valuably — their own
`REALIGNMENT/` audit docs (a 9-phase, 40-PR, ~13-week rewrite they are
**currently executing** after finding a class of cache-buster bugs in
themselves).

---

## 1. TL;DR

Headroom is a serious, very active competitor (67k stars, 2,679 commits,
enterprise-grade process) doing the same job — compress what the agent sends
the LLM — with a different center of gravity:

- **Their center of gravity: lossless, cache-protective compression of the
  "live zone"** (only the newest user/tool content is ever rewritten; bytes
  outside are copied verbatim via byte-range surgery, pinned by SHA-256 CI
  tests) + a **trained ML text compressor** (Kompress-v2-base) + **output
  token reduction** + **failure learning** (`headroom learn`).
- **Our center of gravity: repository intelligence** — we don't just
  compress, we *navigate and edit* (built-in AST graph, ghost-intercepted
  tool execution, surgical patch engine with authoritative diffs) and we
  **compress full history**, which they architecturally refuse to do.

They are ~3–6 months ahead of us on *compression breadth and evidence*
(trained text model, benchmarks/accuracy evals, output-side savings,
provider-cache-breakpoint tooling). We are ahead of them on *agentic depth*
(graph + patch + local execution, no external tools) and we have a **window
they gave us**: they are mid-rewrite, two proxy implementations in flight,
with P0 bugs they only just documented.

The single highest-ROI things we can take from them, in order:
1. A **token-validation gate** (per-block "compressed must be smaller in
   *tokens*, else fall back") — cheap, we have the counter.
2. **Stabilize the tools array + provider cache breakpoints** — they
   identified this exact bug in themselves (P0-6/P2-25) and we have it too:
   our planner injects different CF tools per turn and CCR toggles the
   retrieve tool, which busts the Anthropic prefix cache for the whole
   request on every state change.
3. **Adopt (or retrain on) their Apache-2.0 Kompress ONNX model** for
   text/log compression — we already own the ONNX runtime infrastructure.
4. **A benchmark/eval suite** — they publish workload savings *and* accuracy
   deltas; we publish nothing and have no test suite (flagged in the
   pipeline audit as our biggest production gap).
5. **Strip our `x-cf-*` headers upstream** — they got flagged for exactly
   this (P5-49); we leak `x-cf-dry-run`, `x-cf-max-retries`,
   `x-contextforge-*` to every upstream. (Fixed in this pass, see §5.)

---

## 2. What Headroom actually is (verified from code)

| Dimension | Headroom | ContextForge (us) |
|---|---|---|
| Core | Rust crate (`headroom-core`) + Rust axum proxy | Node.js + N-API C++ (tree-sitter, HNSW, ONNX, SQLite) |
| Languages | Rust + Python package (CLI/memory/learn) + TS SDK — **3 codebases kept byte-parity via a dedicated `headroom-parity` crate** | JS + C++ — 2 |
| Pipeline | CacheAligner (warn-only, **never rewrites**) → ContentRouter → per-type compressors (SmartCrusher JSON / CodeCompressor AST / Log / Search / Diff / **Kompress ML**) → CCR store | 19-stage pipeline: dedup → history prune → planner+tool inject → scrub → tag → semantic dedup → jsonCrush → **AST compress** → fatCatch vault → CCR → minimize → memory → cache align |
| **Compression scope** | **Live-zone only**: newest user message + newest tool_result. History is *never* touched ("passthrough is sacred") | **Full history**: older file reads are AST-stubbed/deduped/vaulted; stubs are deterministic so the prefix stabilizes after first compression |
| Byte fidelity | **Byte-range surgery** — rewritten blocks are spliced into the original buffer; everything else is literally copied (SHA-256 CI-pinned); `arbitrary_precision` + `preserve_order` JSON invariants | Full `JSON.parse`/`JSON.stringify` round-trip of the payload (JS f64 numbers — see gap G3) |
| Text compression | **Kompress-v2-base** — ModernBERT fine-tune, per-token salience head, ONNX int8 (MatMulNBits), 350-word chunks, keep `score>0.5` | **None** — generic text/log passes through (junk classes get vaulted wholesale; logs only scrubbed) |
| Retrieval (CCR) | `<<ccr:HASH>>` markers, backends: in-mem / SQLite / **Redis**; put/get contract | `[CF_VAULT:id]` + `[CF_COMPRESSED_FILE vault_id:…]` markers, SQLite vault + HNSW hybrid fallback (richer search: semantic tier 1/2, line-hint slices) |
| Repo intelligence | **None built-in — installs Serena** (external MCP tool, user-scope registration, must `unwrap` to remove) | Built-in: AST graph (symbols/calls/routes/literals/env), symbol HNSW, ghost-intercepted local tool execution, surgical patch engine with authoritative diff |
| Output side | **Output token reduction**: verbosity note appended *after* system prompt (cache-safe), effort routing on routine turns (`reasoning_effort`/`thinking.budget_tokens`), measured-vs-estimated savings with 10% holdout control, `learn --verbosity` mines your interruptions | None (input-side only) |
| Learning | `headroom learn` — LLM-mines failed sessions → writes corrections to `CLAUDE.local.md`/`AGENTS.md`/`GEMINI.md` | None (persistent memory exists but no learning loop) |
| Evidence | Workload savings tables + **accuracy benchmarks** (GSM8K ±0.000, TruthfulQA +0.030, SQuAD 97%, BFCL 97% at 19–32% compression) + adversarial CCR tests + worst-case + cache-bust trace reports + e2e wrap tests | None published; no test suite at all (pipeline-audit finding) |
| Providers | Anthropic, OpenAI chat + **Responses API**, Gemini, **native Bedrock (SigV4) + Vertex (ADC)** in Phase D (replacing a lossy LiteLLM bridge they admitted was "fake") | Anthropic, OpenAI, Gemini, Ollama (+ local models) |
| Distribution | pip/uv CLI + npm SDK (SDK-only on npm — packaging split they document) + Docker | npm CLI + wrap, Docker, MCP bridge |
| State | **Mid-rewrite** (REALIGNMENT phases A–I): Python proxy being retired into a Rust proxy; 10K LOC of old design deleted; SSE parser, Bedrock/Vertex paths, CCR-marker injection all being rebuilt *right now* | Stable; pipeline audit done; one build bug fixed |

---

## 3. Where they lead — adopt list (ranked)

### A1. Token-validation gate with fallback — ✅ **DONE (2026-08-25)**
They gate every compression with a real tokenizer: if `compressed.tokens >= original.tokens`, the block falls back to the original (their Phase B PR-B4). We gated on **chars/lines** (e.g. AST "reduction < 20% → keep original") — a char-cheeky block can still *grow* in tokens (unicode, comment density) and we'd ship that.
**Implemented:** `passesTokenGate(original, replaced)` in `compressionHelper.js` (cl100k, strict `<` — equality is not a win), applied at **every** replacement-producing site: `astCompressor` (native path, regex fallback, vault pre-check stub), `jsonCrusher`, `semanticDedup` (exact + near-dup stubs), `historyPruner`, `fatCatch` (junk + oversized stubs), `minimizeToolSchemas` (per tool), `deduplicateSystemMessages` (skills-list replacement). Each site falls back to the original when the gate rejects.
**Verified:**
- Unit: char verdict "smaller" / token verdict "larger" inversion caught (122-char JSON-ish content = 33 tokens vs 118-char stub = 37 tokens → rejected); equality rejected; genuine wins pass.
- E2E regression: the 69,140-token audit request still compresses to 2,251 (96.7%) — all real replacements pass the gate; warm run 170 ms.
- E2E adversarial: a 122-char (33-token) repeated file read whose dedup stub is 37 tokens is now **kept full** on the wire (old char-blind code would have stubbed it, inflating by 4 tokens). Server log: `[SemanticDedup] ⏭️ Token gate: 122-char copy would be replaced by a 118-char stub that is NOT smaller in cl100k tokens — kept original`.
**Why it matters:** this is the difference between "compression that never makes things worse" and "compression that sometimes makes things worse and blames the model."

### A2. Tools-array stability + provider cache breakpoints — ✅ **DONE (2026-08-25)**
Their P0-6/P2-25: *"memory tool injection toggles tools list"* / *"CCR tool injected only when content was compressed — tools list flips between requests"* — both are **cache killers** because in the provider's prompt cache the tools array is part of the cached prefix. We had all three toggles (planner per-intent GRAPH/PATCH/READ, CCR retrieve flip, memory tools keyed off the LATEST user message).
**Implemented:**
1. **`src/proxy/stableTools.js`** — deterministic stable tool set: repo group (graph/patch/read_chunk) always on in canonical order (byte-identical static schema objects — single-language JS object literals, so no recursive key-sorting needed, unlike their cross-language parity problem); **retrieve** sticky on payload compression markers (stubs persist in history → condition turns on once, stays on, zero state to evict); **memory group** sticky on memory activity in *any* user message / tool result / mem_* ref (replaces the per-turn latest-message intent flip, keeps first-use coverage). MCP-aliased sessions untouched. Planner intent stops gating *availability* (still computed for telemetry). Bonus: fixes a latent nudge-mode bug (chat-classified turn stripped native Edit AND injected no patch tool → model couldn't edit at all).
2. **`prompt_cache_key`** (their Phase-E "prompt_cache_key auto-injection") — `upstreamRequest.js` injects a stable per-session key (`cf-<deriveSessionId>`, the same stable-text hash scoping CCR) for OpenAI-wire providers (openai + anthropic-compat). Skipped for Ollama/Gemini (field not consumed) and for no-user-message payloads (deriveSessionId's random fallback would defeat the cache).
3. **Cache-bust drift telemetry** (their Phase-E drift detector) — `statsEmitter` now tracks `cacheReadTokens` / `requestsWithCacheRead` / `lastCacheHitRatio` per session (exposed via `/v1/stats`); server logs `[Cache Drift]` when a ≥10k-token request forwarded to a cache-reporting provider gets **zero** cache-read tokens.
4. **A2.2 (Anthropic `cache_control` breakpoints) — deliberately NOT implemented:** none of our providers speak the Anthropic wire format upstream (the anthropic provider targets an OpenAI-compat endpoint), so marker placement would be dead code. Revisit when an Anthropic-wire provider is added (respecting customer markers per their Phase-E contract).

**Verified (instrumented mock upstream, native build from source):**
- Tools array **byte-identical across all 4 hops of 2 requests** (sha256 sig stable), `prompt_cache_key` stable (`cf-4ef4f0a47adceee6`).
- First compression turn: stable set adds repo group; CCR (Stage 14, after compression creates the stubs) injects retrieve — `Injecting retrieve tool / [CCR] 💉 … 4 unretrieved vault(s)`.
- Turn-2 style payload (real stub in history): stable set adds retrieve itself (sticky path), CCR dedups.
- E2E caught + fixed a real bug during verification: the injected CF rule *documents* the stub syntax in the system prompt (`([CF_COMPRESSED_FILE] or [CF_VAULT:...])`), so the marker detector initially matched system content and made retrieve unconditionally always-on — detector now skips system messages (unit + E2E regression).
- Drift alarm fired on a 74,952-token zero-cache-read request; `/v1/stats` session now carries the cache counters.
- Savings regression: 69,140 → 3,599 (**94.8%**). Raw count is ~1.3k higher than A1's 2,251 because the always-on stable tool set costs ~1.3k tokens of schemas on *every* request — the documented trade: that prefix is now **cacheable** (byte-stable), so on a real provider the subsequent turns pay cache-read rate on the entire history instead of busting it per intent flip.

### A3. Kompress-class text compression — *adopt their model first, train later (1–2 weeks)*
The biggest feature gap: we have **no compressor for prose/logs/search
results**. A 10k-token stack trace or grep dump passes through untouched
(junk-classes get vaulted *whole* — zero tokens, but the model can't read
the vault without a round-trip; their SmartCrusher keeps the signal inline).
Their `kompress-v2-base` is **Apache-2.0, ONNX, int8, 384… (ModernBERT
~400d) with a per-token keep/discard head** — it slots into our existing
ONNX infrastructure (dedicated inference thread, batch queue, EmbedCache
pattern, `contextforge_models/` download flow) as a new transform for
`_cf_type ∈ {text, log}` after scrub. Their keep-decision is trivial to
reproduce (score>0.5 or top-ratio), CCR the dropped spans, emit
`[CF_VAULT:…]`-style markers so our existing CCR/retrieve loop works
unchanged.
**Then:** distill/train our own small keep-head on agent-workload text
(we have the session data + retrieval feedback to label what the model
actually needed — `recordCCRSuccess`/retrieve events are natural labels).
**Weakness we exploit:** their model must be downloaded from HF (optional
extras, toolchain for [vector]), has an NPU-specific static-shape variant
and a 3-way int8 fallback ladder — offline/air-gapped users get *no* text
compression. We can vendor the int8 artifact in our setup script today.

### A4. Benchmark + accuracy-eval suite — *do this (1 week, ongoing)*
They publish: 4 workload savings tables, 4 accuracy benchmarks with
baseline-vs-headroom deltas, adversarial CCR tests, worst-case compression,
prefix-cache benchmarks, cache-bust trace reports, e2e wrap tests for every
agent. This is their trust moat ("same answers, fraction of the tokens" is
*proven*). We have none — and our own audit flagged the missing test suite
as the top production gap. Plan:
1. Port their 4 workload scenarios to our harness (mock upstream already
   exists from the audit) → publish savings tables.
2. Port 1–2 accuracy evals (SQuAD-style on compressed context, GSM8K on
   compressed tool outputs) → prove no degradation.
3. Turn the audit's smoke harness into `tests/smoke` (commit it).
4. Add an **adversarial CCR test** (their `adversarial_ccr_tests.py`):
   compress → retrieve → verify byte-equality with the original.
**Exploit note:** once we publish "96% savings on history-heavy sessions
with ±0 accuracy" numbers, their 15–20% coding-agent claim (a consequence
of live-zone-only scope, see §4.2) stops looking like the market standard.

### A5. Output token reduction — *second phase (1 week)*
They cut *output* tokens (5× input price on Opus-class) via: verbosity note
appended **after** the system prompt (deliberate cache-safe placement),
effort routing (dial `reasoning_effort`/`thinking.budget_tokens` down on
routine resume-turns, keep full on errors/new questions), and honest
measurement (counterfactual estimate with CI band + optional 10% unshaped
holdout = *measured*). We have the turn-structure signals they need
(`detectMessageOrigin` already classifies TOOL_FOLLOWUP vs HUMAN_TASK —
effort routing maps onto it directly). Low risk, pure upside, no client
visible change.

### A6. `cf learn` (failure learning) — *third phase (1–2 weeks)*
They mine session logs with an LLM and write corrections into
`CLAUDE.local.md`/`AGENTS.md` (gitignored by default), plus
`learn --verbosity`. We have the data (session registry, savings tracker,
ghost-interceptor history, patch outcomes) and a local-LLM story (ollama
default) that makes this *cheap* for us — they need an LLM call per learn
run; our wrapped sessions already run a local model. Differentiator for
local-first positioning.

### A7. Small takes (hours)
- **Auth-mode-aware policy** (their Phase F): classify payg/oauth/
  subscription and gate aggressive behavior for subscription traffic
  (their users got burned by cache-busting + fingerprint headers on
  subscriptions; the same users could pick us up).
- **`cache_control`/customer-marker respect** — never rewrite customer
  `cache_control`-marked blocks (they made this a P0).
- **Redis CCR backend** — only if we ever go multi-worker (we're
  single-process by design; note and skip).
- **Byte-fidelity tests** — SHA-256 prefix/suffix round-trip fixtures in
  CI (cheap insurance while we refactor toward surgical splicing, A4/A2).

---

## 4. Where we lead — and their exploitable weaknesses

### 4.1 Self-contained repository intelligence (our moat)
Headroom does **not** understand your repo. For navigation it **installs
Serena** — an external MCP tool registered at *user scope* (survives across
projects until `unwrap`), another process, another failure mode, and every
navigation is still a model-driven tool round-trip. We ship the graph, the
symbol embeddings, the route/literal/env indices, **and** a patch engine
whose result carries an authoritative diff — so the model stops
re-reading-to-verify. Nothing of that exists in their stack.
**Exploit:** "one install, no external MCP, no Serena, no unwrap" is the
marketing line. Their wrap flow literally cannot promise this.

### 4.2 History compression — their self-imposed ceiling
Their realignment docs say it in their own words: *"passthrough is sacred;
compress only the live zone."* Consequence: in a 40-turn agentic session
where old turns hold 30 file reads, **those 30 file reads sit in the prompt
in full on every subsequent request.** Their coding-agent savings number
(15–20%) is partly the *price of that decision*. We compress old history
into deterministic stubs (measured 96.7% on a history-heavy payload in the
pipeline audit), and because the stubs are byte-stable after the first
compression turn, the provider prefix re-caches and stays cheap.
**Exploit:** publish head-to-head on a long session: "same task, turn 40 —
Headroom sends 61k tokens of history, we send 4k." (Build the same session,
run both proxies, log wire bytes — the harness exists.)

### 4.3 Their migration window (time-boxed, ~13 weeks)
From their own docs, *as of this commit*: CCR markers "computed but never
injected into the outgoing request body in the Rust path"; `ccr_retrieve`
"flips on/off per request"; Rust had **no SSE parser at all** until Phase C;
Bedrock/Vertex support was "a lossy LiteLLM converter… fake"; SSE UTF-8
split corruption; `function_call.arguments` parsed-and-rewrapped in two
places; Python proxy being retired *while* the Rust proxy is being built —
two implementations with a parity harness between them.
**Exploit:** stability is a feature. "Works on day one, one runtime, your
files never leave your machine" vs a project 40 PRs into a rewrite.
Watch their releases — each phase landing is a chance to point at the gap
that just closed (and at the ones still open).

### 4.4 Simpler surface, fewer moving parts
Their install: uv/pip with `[all]` extras, npm package that is SDK-only
(different artifact, no CLI), Serena registration, HF model download,
optional HNSW C++ toolchain, 100+ LiteLLM-provider claim via a bridge.
Ours: `npm i -g @anuj612/contextforge && cf wrap claude`. In a comparison
table, "what can go wrong at install time" is a real column.

### 4.5 Native core without the parity tax
Their `headroom-parity` crate exists *because* they run Python and Rust
implementations that must agree byte-for-byte — an ongoing engineering
tax on every change. We have one implementation per layer (JS orchestrator,
C++ compute). Their own audit deleted ~10K LOC of over-build mid-flight;
we audited at ~1/10th the code surface and found no over-build, only sync
bugs (fixed).

---

## 5. What we do immediately (this pass)

**A1 (token-validation gate) — DONE**, see §3 A1.
**HA-1 (proxy header leakage) — DONE**, see below.

**Fixed (quick win from their P5 findings):** our providers forwarded
every inbound header upstream except a few stripped ones — meaning
`x-cf-dry-run`, `x-cf-max-retries`, `x-cf-mock-port`,
`x-contextforge-user-id`, `x-contextforge-workspace` (our own proxy
fingerprint) reach the provider. Headroom got flagged for the identical
issue (P5-49/50/51: "X-Headroom-* headers leak upstream", fingerprint /
subscription-revocation risk class). All four provider adapters now strip
the `x-cf-*` / `x-contextforge-*` families before forwarding.

**Backlog (ordered):** A1 → A2 → A4 (smoke tests first) → A3 → A5 → A6 → A7.

---

## 6. Honest caveats

- Their live-zone discipline is *right* for subscription Claude Code users
  (zero cache risk, ever); our history rewriting takes one prefix re-write
  per compression event. We should not pretend this is free — A2 is what
  makes it defensible, and we should keep a "conservative mode" (live-zone
  only) as a policy tier for exactly those users.
- Their numbers come from their harness on their workloads; until we run
  the same scenarios (A4) the "we save more" claim is ours-to-prove, not
  theirs-to-refute.
- Kompress is their trained asset; adopting it is legitimate (Apache-2.0)
  but building our own keep-head is the durable answer — our retrieve
  events are the training labels they don't have per-user.
- Star count ≠ correctness; their P0 list is a demonstration that a busy
  project can ship cache-busting bugs to every customer. Our job is to not
  be the mirror image of their Phase-A.
