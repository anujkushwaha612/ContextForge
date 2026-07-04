<div align="center"><pre>
  ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗████████╗
 ██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝╚══██╔══╝
 ██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝    ██║
 ██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗    ██║
 ╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗   ██║
  ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝
 ███████╗ ██████╗ ██████╗  ██████╗ ███████╗
 ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
 █████╗  ██║   ██║██████╔╝██║  ███╗█████╗
 ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝
 ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
 ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
Repository-aware execution runtime for Claude Code

</pre></div>

<p align="center"><strong>Repository graph • Transparent tool execution • Context optimization • Provider agnostic</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen" alt="Node.js Version"></a>
  <a href="#documentation"><img src="https://img.shields.io/badge/docs-in--repo-blue.svg" alt="Docs"></a>
</p>

<p align="center">
  <a href="#the-problem">Problem</a> ·
  <a href="#what-it-does">What It Does</a> ·
  <a href="#how-it-works-30-seconds">How It Works</a> ·
  <a href="#quick-start">Install</a> ·
  <a href="#real-results">Results</a> ·
  <a href="#use-with-your-ai-agent">Agents</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#configuration">Config</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#community">Community</a>
</p>

---

ContextForge is a **local proxy + CLI** that sits between Claude Code and your LLM provider — executing repository tool calls locally, compressing context before it reaches the model, and maintaining an AST-level knowledge graph of your codebase. Run local models through Ollama or any major cloud provider. Same answers. Fraction of the tokens.

```
npm i -g contextforge
cd your-project
cf wrap claude
```

That's the whole setup. No compilers, no config files, no `.env` editing — a first-run wizard asks two questions and everything else is automatic.

---

## The Problem

AI coding agents waste **thousands of tokens** on every request:

- 🔄 Re-reading entire files to find a single function
- 🗺️ Re-discovering repository structure on every edit
- 📦 Re-sending ~100KB of tool schemas and unchanged tool outputs with every turn
- 🔁 Burning LLM round-trips on file navigation a local index could answer instantly

**Result:** Slow responses. High API costs. Context window limits hit constantly. And if you run local models, most agent tooling assumes a cloud API and leaves you out entirely.

---

## What It Does

- **One-command wrapper** — `cf wrap claude` starts the proxy, indexes your repo, launches Claude Code through it, and prints a savings summary when you exit
- **Repository Graph** — `find_symbol`, `analyze_impact`, `find_route` — AST-level queries over JS/TS/TSX/Python/Go/Rust/Java that answer without reading files
- **Transparent Tool Interception** — graph/read/patch tool calls execute locally in the proxy; background hops never burn a full agent round-trip
- **Context Optimizer** — tool-schema minimization, system-prompt dedup, keep-newest file dedup, AST skeleton compression, junk interception (lockfiles, minified bundles, base64 blobs)
- **Surgical patching** — `contextforge_patch_ast` applies edits with AST awareness and returns a unified diff in the result, so the model doesn't re-read files to verify
- **Session memory** — persistent per-workspace memory store with HNSW vector search, injected as context when relevant
- **Live Dashboard** — `http://localhost:3000/dashboard` — token savings, compression ratio, request log in real time
- **Doctor** — `cf doctor` diagnoses the whole install in one command; `--fix` repairs it

---

## How It Works (High Level Overview)

```
  Claude Code            ← launched by `cf wrap claude`
       │   Anthropic-format requests · tools · conversation history
       ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │                  ContextForge  (runs locally)                    │
  │  ──────────────────────────────────────────────────────────────  │
  │                                                                  │
  │   🧠 Repository Graph          ⚡ Transparent Interception        │
  │   AST · symbols · call graph   graph/read/patch run here         │
  │                      │                                           │
  │                      ▼                                           │
  │               📦 Context Optimizer                                │
  │     Schema minimization · System dedup · Keep-newest dedup       │
  │       AST skeletons · Junk vaulting · History pruning            │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
       │   compressed payload — ~50% smaller in real sessions
       ▼
  LLM Provider  (Ollama · Anthropic · OpenAI · Groq · Gemini)
```

1. **`cf wrap claude`** ensures the environment (models, native engine), starts the proxy, indexes your repo (a 30-file Express app indexes in ~0.5s), and launches Claude Code with the proxy as its base URL plus ContextForge's MCP tools registered.
2. **Requests are translated** between Anthropic format (what Claude Code speaks) and your upstream provider's format — this is how Claude Code drives local Ollama models.
3. **Repository tools answer locally.** `find_symbol('deleteFile')` returns file + line range from the pre-built graph — no file reads, no wasted round-trip.
4. **The optimizer compresses what's left** — schemas, duplicate history, oversized junk — with age-gating so content the model _just requested_ is never compressed out from under it.
5. **On exit**, you get the receipt: `✔ Session: 14 requests · 424,129 tokens in → 208,163 sent · 50.9% saved (est)`.

---

## Quick Start

### Option A: npm (recommended)

Requires Node ≥ 20. No compilers — prebuilt native binaries ship for Windows, macOS (Intel/ARM), and Linux (x64/ARM).

```bash
npm i -g contextforge
cd your-project
cf wrap claude
```

First run: a wizard asks for your upstream provider (Ollama/Anthropic/OpenAI/Groq/Gemini) and model, then auto-downloads the embedding model (~23MB, SHA-256 verified). Subsequent runs go straight to work.

```bash
cf doctor        # 8-point install diagnosis — run this if anything misbehaves
```

### Option B: From source (contributors / unsupported platforms)

```bash
git clone https://github.com/anujkushwaha612/ContextForge.git
cd ContextForge
npm install
bash scripts/vendor-grammars.sh    # pinned tree-sitter grammars
bash scripts/setup-onnx.sh         # embedding model (or let `cf setup` do it)
npm run build:native               # requires Python 3 + C++ toolchain
npm link                           # makes `cf` available globally
cf doctor
```

---

## Use With Your AI Agent

### Claude Code (v1 — fully supported)

```bash
cd your-project
cf wrap claude                     # everything automatic
cf wrap claude -- --continue       # pass args through to claude after --
```

`cf wrap` injects `ANTHROPIC_BASE_URL`, registers ContextForge's MCP tools for the session, and tears everything down when Claude exits. Nothing in your Claude Code config is permanently modified.

**Prefer managing the proxy yourself?**

```bash
cf start                           # proxy in the background
cf mcp install                     # persistent MCP registration (Claude/Codex/Gemini CLI)
claude                             # launch however you like
cf stop
```

Useful commands: `cf status` · `cf logs -f` · `cf restart` · `cf mcp status`

### Other agents

Any agent that honors `ANTHROPIC_BASE_URL` (or an OpenAI-compatible base URL) can point at the running proxy. Codex and Gemini CLI get persistent MCP tool registration via `cf mcp install`. Official wrap support for more agents is on the roadmap.

---

## Real Results

The same **Soft-Delete** feature was implemented twice in the same Express.js cloud storage backend using the **same model (local Ollama)**, **same repository state**, and **same instructions**.

### Head-to-head Comparison

| Metric | Passthrough Mode | ContextForge Mode | Difference |
|--------|-----------------:|------------------:|-----------:|
| **LLM round-trips** | 41 | 14 | **66% fewer** |
| **Input tokens** | 1,632,266 | 444,092 | **72.8% fewer** |
| **Output tokens** | 1,632,266 | 384,033 | **76.5% fewer** |
| **Session-reported token savings** | — | 60,059 (13.5%) | — |
| **Repository exploration** | Full-file reads and repeated searches | Graph-guided symbol lookup with targeted reads | More targeted |
| **Task management** | 6 TaskCreate/TaskUpdate operations | None | Lower overhead |
| **Final implementation** | ✅ Correct | ✅ Correct | Equivalent output |

---

## Implementation Comparison

To compare the two approaches, I implemented the same **Soft-Delete** feature in the cloud storage backend repository using both **ContextForge Mode** and **Passthrough Mode**, with each run starting from the **exact same initial repository state**.

- **Repository:** https://github.com/anujkushwaha612/ADrive_backend

### ContextForge Mode

- **Commit:** https://github.com/anujkushwaha612/ADrive_backend/commit/e78700d5cb15b130df85f728772785bd88d5b413
- **Run Statistics:** 14 requests · ~444k input tokens

### Passthrough Mode

- **Commit:** https://github.com/anujkushwaha612/ADrive_backend/commit/0f912bfb00b805882b1154a136520d6edecc3a9d
- **Run Statistics:** 41 requests · ~1.63M input tokens

---

## Understanding the Metrics

At first glance, two numbers appear contradictory:

- **72.8% fewer input tokens** compared to Passthrough Mode.
- **13.5% session-reported token savings** reported by ContextForge.

These measure **different things**.

### Behavioral Savings

The **72.8% reduction** comes from comparing the two complete executions.

ContextForge changes how the model interacts with the repository:

- Uses graph-based symbol lookup instead of repeated repository exploration.
- Performs targeted line-range reads instead of repeatedly reading entire files.
- Reduces unnecessary tool calls and repeated verification.
- Reaches the same implementation in **14 requests instead of 41**.

These are **behavioral savings**: tokens that were never generated because the model solved the task more efficiently.

Since those requests never happened, they cannot be counted by an in-session compression tracker.

### Session Compression

The **13.5%** figure is the amount of prompt text removed **within the ContextForge session itself**.

This metric measures how much prompt content ContextForge compressed or eliminated before forwarding requests to the model. It does **not** compare against an external Passthrough run.

In other words:

- **72.8%** answers: *"How much smaller was this entire implementation compared to Passthrough?"*
- **13.5%** answers: *"How much prompt content did ContextForge remove from the requests that were actually sent?"*

These metrics are complementary rather than contradictory.

---

## Notes

- Session-level compression depends on conversation length. Short sessions naturally provide less opportunity for compression than long-running coding sessions.
- Token counts are estimated using `cl100k` tokenization, so absolute values are approximate.
- The implementation produced by both runs was functionally equivalent; the primary differences were repository navigation strategy, request count, and token consumption.

## When to Use · When to Skip

**Great fit if you…**

- Run Claude Code daily against a real codebase — especially through **local Ollama models**, which ContextForge makes a first-class Claude Code backend
- Hit context window limits on multi-file tasks — rename, refactor, audit, search
- Want token savings without changing your agent, your prompts, or your code
- Want AST-aware graph queries and surgical patching instead of read-the-whole-file loops

**Skip it if you…**

- Only send short, single-turn prompts — the pipeline pays off from turn 2 onward
- Work in a sandboxed environment where local processes and file watchers cannot run
- Need a hosted or cloud-managed solution — ContextForge is local-first by design

---

## Architecture

```
┌─────────────────┐
│  AI Agent       │  Claude Code (v1) · MCP: Codex, Gemini CLI
│  (Client)       │
└────────┬────────┘
         │ Anthropic-format request        ┌──────────────────────────┐
         ↓                                 │  cf CLI                  │
┌───────────────────────────────────────┐  │  wrap · doctor · config  │
│           ContextForge Proxy          │◄─┤  start/stop · mcp · init │
│                                       │  └──────────────────────────┘
│  ┌─────────────────────────────────┐  │
│  │ 🧠 Repository Graph              │  │  SQLite graph: symbols, calls,
│  │    (Tree-sitter AST + HNSW)     │  │  imports, routes + vector index
│  └─────────────────────────────────┘  │
│  ┌─────────────────────────────────┐  │
│  │ ⚡ Execution Engine              │  │  graph/read/patch tools run
│  │    (Transparent Interception)   │  │  locally; patches return diffs
│  └─────────────────────────────────┘  │
│  ┌─────────────────────────────────┐  │
│  │ 📦 Context Optimizer             │  │  pressure-aware, age-gated
│  │    (Compression Pipeline)       │  │  compression + dedup + vaulting
│  └─────────────────────────────────┘  │
│  ┌─────────────────────────────────┐  │
│  │ 💾 Memory (per-workspace)        │  │  persistent HNSW + SQLite
│  └─────────────────────────────────┘  │
└────────┬──────────────────────────────┘
         │ translated + compressed request
         ↓
┌─────────────────┐
│  LLM Provider   │  Ollama · Anthropic · OpenAI
└─────────────────┘
```

<details>
<summary><b>What's inside</b></summary>

- **Repository Graph** — Tree-sitter AST parsing for JavaScript, TypeScript, TSX, Python, Go, Rust, Java (pinned grammar versions, compiled into a native N-API addon). Indexes functions, classes, imports/exports, call edges, HTTP routes, string literals, and env-var references into SQLite, plus a symbol-level HNSW vector index for semantic lookup. Updated live by a file watcher and after every patch.
- **Transparent Tool Interception** — `contextforge_query_graph`, `read_file_chunk`, `contextforge_patch_ast`, and `contextforge_retrieve` execute inside the proxy. Background tool hops are intercepted and resolved without a full client round-trip.
- **Tool Schema Minimization** — Claude Code ships ~100KB of tool schemas per request. ContextForge truncates non-critical descriptions semantically (never its own tools' instructions, never enums) and caches the result.
- **Keep-newest Deduplication** — when the same file appears multiple times in history, older copies become vault pointers and the newest stays full — so the model always has exactly one current copy. SimHash-based near-dup detection marks superseded pre-patch versions as outdated.
- **AST Compression** — large code files in older history become structural skeletons (signatures + first body lines) with a retrieval pointer. Age-gated: content from the last 2 turns is never compressed, so the model is never forced to re-retrieve what it just read.
- **Junk Interception** — lockfiles, minified bundles, base64 blobs, and giant single-line JSON get vaulted aggressively with a preview stub — content no model benefits from reading raw.
- **Self-verifying patches** — every successful patch returns a unified diff of the exact change applied, eliminating verification re-reads.
- **Pressure-aware policy** — compression aggressiveness scales with context size and upstream cost (local vs cloud). Small local sessions compress minimally; big cloud sessions compress hard.
- **Live Dashboard** — real-time SSE metrics at `/dashboard`; scriptable snapshots at `/v1/stats` and `/v1/savings`.

</details>

---

## How It Works — Deep Dive

<details>
<summary><b>🧠 Repository Graph</b> — AST-powered knowledge graph</summary>

On first start, ContextForge indexes your workspace (two passes: symbol extraction, then cross-file call edges) and embeds symbols into an HNSW index for semantic search.

**Example query from the model:**

```json
{ "query_type": "find_symbol", "target": "deleteFile" }
```

**Returns** file path, line range, complexity, and export status — from SQLite, in under a millisecond, without reading a single file. Other query types: `read_function`, `what_does_this_export`, `who_imports_this`, `show_callers`, `analyze_impact` (2-hop caller chain), `find_route`, and `find` — a broad search across symbols, string literals, env vars, and routes whose results include the actual matching source line, so the model can distinguish `Bucket: BUCKET_NAME` from `Bucket: process.env.AWS_BUCKET_NAME` without a follow-up read.

The graph re-indexes automatically on file changes and after every applied patch.

</details>

<details>
<summary><b>⚡ Execution Engine</b> — Transparent Tool Interception</summary>

Repository tools are served by the proxy itself. When the model chains navigation calls (find → read → patch), intermediate hops are intercepted and answered locally — the client agent sees only the meaningful results, not the plumbing.

Patching is AST-aware with fuzzy-match recovery (whitespace drift, symbol-scope misses fall back to verified global replace) and every success response embeds the applied diff:

```
@@ controllers/file.controller.js line ~92 @@
         const command = new DeleteObjectCommand({
-            Bucket: process.env.AWS_BUCKET_NAME,
+            Bucket: BUCKET_NAME,
             Key: s3Key,
```

~50 tokens of proof, replacing a 500–2,000-token verification re-read. The system prompt explicitly tells the model to trust the diff.

</details>

<details>
<summary><b>📦 Context Optimizer</b> — the compression pipeline, in order</summary>

1. **System-prompt dedup + skills-list pruning** — repeated system prompts collapse to one; Claude Code's verbose skills list becomes a one-line note.
2. **History pruning** — vault retrievals that served their purpose in earlier turns collapse to a short stub (turn-boundary and post-patch invalidation).
3. **Tool-schema minimization** — the single biggest per-turn saving (~16.8k tokens measured). ContextForge's own tool instructions are never truncated.
4. **Keep-newest semantic dedup** — exact (FNV-1a) and near-dup (SimHash) detection per file key; older occurrences become pointers, newest stays full. Never dedups toward a stub, never touches the current turn.
5. **AST compression** — pressure-aware and age-gated skeletonization of old large code blocks, vault-backed for on-demand retrieval.
6. **Junk interception** — lockfiles/minified/base64/single-line-JSON vaulted with a preview, at a much lower threshold than legitimate content.

Every stage is format-aware (Anthropic tool_result blocks and OpenAI tool messages) and skips content flagged by earlier stages.

</details>

---

## Supported Providers

| Provider      | Models                     | Notes                                                                                                  |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Ollama**    | All local & cloud models   | Default. The reason many users are here: Claude Code driving `qwen2.5-coder`, `minimax-m3:cloud`, etc. |
| **Anthropic** | Claude Sonnet, Opus, Haiku | Model picked inside Claude Code via `/model`                                                           |
| **OpenAI**    | GPT-4o, o-series           | Set `OPENAI_API_KEY`                                                                                   |
| **Gemini**    | Gemini 2.5 family          | Set `GEMINI_API_KEY`                                                                                   |

Switch providers anytime:

```bash
cf config set provider.name anthropic          # machine-wide
cf init --provider ollama --model qwen2.5-coder:14b   # per-project (committable)
cf wrap claude --provider groq                 # one session only
```

---

## Configuration

Config lives in **TOML files with a clear precedence chain** — no `.env` editing required (env vars still work and win over files, for CI/power users):

```
CLI flags  >  CF_* env vars  >  ./.contextforge.toml  >  ~/.contextforge/config.toml  >  defaults
```

```bash
cf config                        # every resolved value + WHERE it came from
cf config set proxy.port 4000    # edit global config
cf config set provider.model_override llama3.1:8b --project
cf init                          # scaffold ./.contextforge.toml for this repo
cf setup --reconfigure           # re-run the provider wizard
```

```toml
# ~/.contextforge/config.toml (created by the first-run wizard)
[proxy]
port = 3000          # 0 = auto-pick a free port
mode = "full"        # full | passthrough

[provider]
name = "ollama"      # the UPSTREAM (where requests are sent)
model_override = "qwen2.5-coder:14b"   # required for ollama

[compression]
ccr = true
nudge_tools = true   # strip native Edit/Read so the model uses graph tools
```

See [`.contextforge.example.toml`](.contextforge.example.toml) for the fully-commented reference. All state (models, per-workspace databases, logs) lives under `~/.contextforge/` — your repos stay clean.

---

## Performance

- **Pipeline overhead:** ~25–145ms per request (measured; dominated by first-turn planning — steady-state turns run ~25–40ms)
- **Indexing:** ~0.5s for a 30-file Express app at startup; incremental re-index per file save/patch afterward
- **Graph queries:** sub-millisecond SQLite lookups; semantic fallback ~50–200ms when regex-confidence is low
- **Embeddings:** int8 ONNX MiniLM (~23MB) on a dedicated inference thread with LRU caching — ~3ms warm inference
- **Net effect:** payloads roughly halve in real coding sessions, which more than repays the overhead in provider latency alone

### Benchmarks

```bash
npm run benchmark      # runs the compression suite against your own codebase
```

The most honest benchmark is your own repo — publish yours in a Discussion.

---

## Documentation

| Start here                             | Go deeper                                            |
| -------------------------------------- | ---------------------------------------------------- |
| [Quick Start](#quick-start)            | [Architecture](#architecture)                        |
| [Agent Setup](#use-with-your-ai-agent) | [How It Works — Deep Dive](#how-it-works--deep-dive) |
| [Configuration](#configuration)        | [RELEASE.md](RELEASE.md) — publish pipeline          |
| [Troubleshooting](#troubleshooting)    | [INTEGRATION.md](INTEGRATION.md) — repo layout       |
| [Contributing](#contributing)          | [FAQ](#faq)                                          |

---

## Updating

```bash
# npm install
npm update -g contextforge


# From source
git pull && npm install && npm run build:native
```

Config and per-workspace data in `~/.contextforge/` survive updates.

---

## FAQ

<details>
<summary><b>Which coding agents are officially supported?</b></summary>

**Claude Code** is the fully-supported v1 agent (`cf wrap claude`). Codex and Gemini CLI can use ContextForge's repository tools today via `cf mcp install`. Any agent honoring a custom base URL can route through the proxy manually. More first-class wraps are planned.

</details>

<details>
<summary><b>Can I really use Claude Code with local Ollama models?</b></summary>

Yes — this is a headline use case. ContextForge translates Claude Code's Anthropic-format requests into OpenAI format for Ollama (and back, streaming included). Set `provider.name = "ollama"` and a `model_override`, then `cf wrap claude`. No Anthropic API key required for local-only use.

</details>

<details>
<summary><b>Does ContextForge modify my code automatically?</b></summary>

No. Files change only when your agent explicitly calls the patch tool. Every applied patch returns the exact diff, the graph re-indexes immediately, and patches are written atomically.

</details>

<details>
<summary><b>Does it support streaming?</b></summary>

Yes. SSE streams are translated between provider formats in real time — responses appear exactly as they would direct from the provider.

</details>

<details>
<summary><b>What kind of token savings should I expect?</b></summary>

Real multi-file coding sessions measure around **50%** (see [Real Results](#real-results)). Repository-heavy work benefits most. Short chats benefit least — and by design: the policy engine compresses _less_ when context pressure is low and your upstream is a free local model, because a forced retrieval round-trip costs more than the tokens it saves.

</details>

<details>
<summary><b>How does the Repository Graph stay up to date?</b></summary>

Full index at startup, then incremental: the file watcher re-indexes changed files, and every applied patch re-indexes its file synchronously — the graph is current before the model's next query.

</details>

<details>
<summary><b>What is Large Result Vaulting?</b></summary>

Oversized or junk content (lockfiles, minified bundles, huge outputs) is stored in a local SQLite vault and replaced with a stub containing a preview and a `contextforge_retrieve` pointer. Content-hash dedup means the same content is stored once. Nothing is discarded — retrieval is always one tool call away.

</details>

<details>
<summary><b>Is my code sent anywhere besides my chosen provider?</b></summary>

No. ContextForge runs entirely on your machine — the graph, vaults, memory, and embeddings (local ONNX model) never leave it. The only outbound traffic is the compressed request to the provider _you_ configured. With Ollama, nothing leaves your machine at all.

</details>

<details>
<summary><b>Can individual optimization stages be disabled?</b></summary>

Partially: `nudge_tools` and `ccr` are config toggles, and `mode = "passthrough"` disables the whole pipeline (useful for baselining). Per-stage toggles are on the roadmap. `CF_DISABLE_FAT_CATCH=true` disables junk vaulting for debugging.

</details>

<details>
<summary><b>Do I need to compile the native components?</b></summary>

Not with `npm i -g contextforge` — prebuilt N-API binaries ship for win32-x64, darwin-x64/arm64, and linux-x64/arm64, working across Node 18/20/22+. Compiling from source is only needed for other platforms or development; `cf doctor` tells you exactly which binary loaded (`prebuild` vs `local-gyp`).

</details>

## Roadmap

- [x] `cf` CLI: wrap, setup wizard, doctor, daemon, config, per-project init
- [x] Claude Code ↔ Ollama/OpenAI/Anthropic/Groq/Gemini translation with streaming
- [x] AST knowledge graph (JS, TS, TSX, Python, Go, Rust, Java) + symbol embeddings
- [x] Pressure-aware, age-gated compression pipeline with keep-newest dedup
- [x] Self-verifying patches (diff-in-result) and junk interception
- [x] MCP registration for Claude Code, Codex, Gemini CLI
- [x] Prebuilt native binaries for 5 platforms via CI
- [ ] **v1.1:** Per-stage compression toggles · more `cf wrap` agents
- [ ] **v1.2:** Multi-workspace / monorepo support
- [ ] **v1.3:** Cross-session memory surfaced in the dashboard
- [ ] **v1.4:** Native prompt-caching integration (Anthropic, OpenAI, Gemini)
- [ ] **v1.5:** C#, Ruby, and Swift grammar support

See [open issues](https://github.com/anujkushwaha612/ContextForge/issues) for the live list.

---

## Contributing

Contributions welcome — the codebase is deliberately modular (pipeline stages are single-file, the CLI's agent registry is one entry per agent).

**Development setup:**

```bash
git clone https://github.com/anujkushwaha612/ContextForge.git
cd ContextForge
npm install
bash scripts/vendor-grammars.sh    # pinned grammars
npm run build:native               # Node 20+, Python 3, C++ toolchain
npm link
cf doctor                          # should be all green
```

**Run tests:**

```bash
npm test               # full suite
npm run test:unit
npm run test:smoke
npm run benchmark      # compression suite against your codebase
```

**Good first areas:** a new tree-sitter grammar (see `native/binding.gyp` + `scripts/vendor-grammars.sh`), a new agent in `cli/src/core/agents.js`, or a new MCP registrar in `src/mcp/registrars/`.

---

## Troubleshooting

**First move, always:**

```bash
cf doctor          # checks node, native addon, models, embedder, agent, proxy
cf doctor --fix    # re-downloads corrupt models, cleans stale state
```

Include `cf doctor --json` output in any bug report.

<details>
<summary><b>Native addon fails to load (CF_ERR_NATIVE_LOAD)</b></summary>

`cf doctor` shows which path was searched. If you're on one of the 5 prebuilt platforms, reinstall (`npm i -g contextforge`). On other platforms, build from source:

```bash
# Windows: VS Build Tools ("Desktop development with C++") + Python 3
# macOS:   xcode-select --install
# Linux:   sudo apt-get install build-essential python3
git clone https://github.com/anujkushwaha612/ContextForge.git && cd ContextForge
npm install && bash scripts/vendor-grammars.sh && npm run build:native
```

</details>

<details>
<summary><b>Models missing or corrupt (CF_ERR_MODEL_*)</b></summary>

```bash
cf doctor --fix     # re-downloads with SHA-256 verification
```

Requires HTTPS access to `huggingface.co`. Models live in `~/.contextforge/models/` (Windows: `%APPDATA%\contextforge\models`).

</details>

<details>
<summary><b>Claude launches but requests hang</b></summary>

Almost always the upstream. If you're on Ollama: is it running (`ollama serve`), and does your `model_override` exist (`ollama list`)? Watch what the proxy is doing live with `cf logs -f`.

</details>

<details>
<summary><b>Proxy won't start / port conflict (CF_ERR_PORT_CONFLICT)</b></summary>

```bash
cf status          # what's running where
cf stop            # stop the managed proxy
cf start --port 0  # auto-pick a free port
```

</details>

<details>
<summary><b>Dashboard shows "DISCONNECTED"</b></summary>

The SSE stream at `/v1/stats/stream` isn't reachable. Check `cf status` says the proxy is healthy, and try an incognito tab to rule out extension interference.

</details>

<details>
<summary><b>Compression ratio is 0% or negative on the first message</b></summary>

Expected. Tool injection costs tokens before compression can recover them, and low-pressure sessions deliberately compress less. Steady-state ratios appear by message 3 of real work.

</details>

<details>
<summary><b>LLM responses look wrong / truncated</b></summary>

Baseline against the raw pipeline: `cf wrap claude --mode passthrough`. If passthrough is fine but full mode isn't, capture a payload with `CF_DEBUG_PAYLOAD=1 cf start` and open an issue with `debug_payload.json` (redact secrets).

</details>

---

## Community

- **[GitHub Discussions](https://github.com/anujkushwaha612/ContextForge/discussions)** — questions, benchmark results, use cases
- **[Issues](https://github.com/anujkushwaha612/ContextForge/issues)** — bugs (attach `cf doctor --json`) and feature requests

---

## Acknowledgments

ContextForge is built on exceptional open-source work:

- [Tree-sitter](https://tree-sitter.github.io/) — incremental, error-tolerant parsing
- [ONNX Runtime](https://onnxruntime.ai/) — cross-platform ML inference
- [hnswlib](https://github.com/nmslib/hnswlib) — fast approximate nearest-neighbor search
- [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) — the embedding model (int8 ONNX export by [Xenova](https://huggingface.co/Xenova))
- [SQLite](https://sqlite.org/) & [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — graph, vault, and memory storage
- [Chart.js](https://www.chartjs.org/) — dashboard visualizations

---

## License

MIT — see [LICENSE](LICENSE).

**Built by [Anuj Kushwaha](https://github.com/anujkushwaha612)** with contributions from the open-source community.

---

## Placeholders to Fill Before Launch

Almost everything above is real. The short remaining list:

| Item                   | Where                         | What to do                                                                                                            |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Demo GIF               | below the intro               | Record `cf wrap claude` on a real task (vhs/asciinema) → `docs/images/demo.gif` — re-add the `<img>` block when ready |
| Benchmark table        | [Real Results](#real-results) | After the next benchmark run, add a with/without comparison from `npm run benchmark`                                  |
| LICENSE file           | repo root                     | Commit the MIT text (package.json already declares it)                                                                |
| Good-first-issue links | [Contributing](#contributing) | Open 3–4 real issues and link them                                                                                    |
| npm badge              | badges block                  | After first publish: `https://img.shields.io/npm/v/contextforge`                                                      |

---

<p align="center">
  <i>Stop wasting tokens. Start building faster.</i><br/>
  <b>⚒️ Forge better context.</b>
</p>
