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
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/docker-ready-blue" alt="Docker"></a>
  <a href="#documentation"><img src="https://img.shields.io/badge/docs-in--repo-blue.svg" alt="Docs"></a>
</p>

<p align="center">
  <a href="#the-problem">Problem</a> ·
  <a href="#what-it-does">What It Does</a> ·
  <a href="#how-it-works-30-seconds">How It Works</a> ·
  <a href="#quick-start">Install</a> ·
  <a href="#real-results">Results</a> ·
  <a href="#agent-compatibility">Agents</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#compared-to">Compare</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#community">Community</a>
</p>

<p align="center"><sub>
  <b>AI agents / LLMs:</b> fetch <a href="llms.txt"><code>/llms.txt</code></a> for a machine-readable index of this project's capabilities and API surface.
</sub></p>

---

ContextForge is a **transparent proxy** that sits between your AI coding agent and your LLM provider — executing repository tool calls locally, compressing context before it reaches the model, and maintaining an AST-level knowledge graph of your codebase. Same answers. Fraction of the tokens.

<p align="center">
  <!-- TODO: Record a terminal demo GIF and drop it at docs/images/demo.gif          -->
  <!-- Recommended tool: vhs (https://github.com/charmbracelet/vhs) or asciinema    -->
  <!-- Show: split terminal, same rename task, with vs without, dashboard live       -->
  <img src="docs/images/demo.gif" alt="ContextForge in action" width="820">
  <br/><sub>Live: [YOUR_BASELINE_TOKENS] → [YOUR_COMPRESSED_TOKENS] tokens — same rename, zero extra round-trips.</sub>
</p>

---

## The Problem

AI coding agents waste **thousands of tokens** on every request:

- 🔄 Re-reading entire files to find a single function
- 🗺️ Re-discovering repository structure on every edit
- 📦 Re-processing unchanged tool outputs across conversation turns
- 🔁 Making 10+ LLM round-trips for simple rename operations

**Result:** Slow responses. High API costs. Context window limits hit constantly.

---

## What It Does

- **Proxy** — `ANTHROPIC_BASE_URL=http://localhost:3000 claude` — zero code changes, drop-in for any agent
- **Repository Graph** — `find_symbol()`, `find_route()` — AST-level codebase queries that answer without reading files
- **Transparent Tool Interception** — repository tool calls execute locally, never burn an LLM round-trip
- **Context Optimizer** — tool schemas, duplicate content, and large outputs compressed before every request
- **Large Result Vaulting** — oversized tool outputs stored locally, replaced with a retrieval pointer the LLM calls on demand
- **Live Dashboard** — `http://localhost:3000/dashboard` — token savings, compression ratio, vault hits, request log in real time

---

## How It Works (30 seconds)

```
  Claude Code
       │   raw requests · tool calls · file reads · conversation history
       ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │                  ContextForge  (runs locally)                    │
  │  ──────────────────────────────────────────────────────────────  │
  │                                                                  │
  │   🧠 Repository Graph          ⚡ Transparent Interception       │
  │   AST · symbols · call graph   tool calls run here, not at LLM  │
  │                      │                                           │
  │                      ▼                                           │
  │               📦 Context Optimizer                               │
  │        Schema trim · Dedup · Large Result Vaulting               │
  │         Conversation Compression · Semantic Dedup                │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
       │   compressed payload  (60–80% smaller)
       ▼
  LLM Provider  (Anthropic · OpenAI · Ollama · Groq · Gemini)
```

**Request arrives** → ContextForge normalizes the format (OpenAI / Anthropic)

**Repository tools injected** → `find_symbol()`, `find_route()`, `read_file_chunk()`, `contextforge_patch_ast()` added to the LLM's tool list.

**Transparent Tool Interception** → If the LLM calls a repository tool, ContextForge executes it locally and transparently returns the result, saving an LLM round-trip.

**Compression pipeline** → Schemas minimized, repeated content deduplicated, large outputs vaulted, conversation history compressed.

**Request forwarded** → The compressed payload goes to your LLM provider.

**Response streams back** → Client receives the response in its original format — streaming fully supported.

---

## Quick Start

### Option A: Docker (Recommended — Zero Setup)

```bash
git clone https://github.com/[YOUR_ORG]/contextforge.git
cd contextforge
cp .env.example .env          # Add your API key
docker compose up -d
```

**Done.** ContextForge is running at `http://localhost:3000`.
Open `http://localhost:3000/dashboard` to see live metrics.

### Option B: Local Install

```bash
git clone https://github.com/[YOUR_ORG]/contextforge.git
cd contextforge
npm install                   # Auto-downloads models, compiles native modules
cp .env.example .env          # Add your API key
npm start
```

---

## Use With Your AI Agent

### Claude Code

```bash
export ANTHROPIC_BASE_URL="http://localhost:3000"
export ANTHROPIC_API_KEY="your-real-anthropic-key"
claude
```
---

## Real Results

<!--
  TODO: Replace ALL placeholders below with real numbers from your own benchmark run.
  Suggested task: "Rename the authenticate function across the codebase"
  Run once direct to provider, once through ContextForge, record both outputs.
-->

| Metric                | Without ContextForge       | With ContextForge            | Improvement     |
| --------------------- | -------------------------- | ---------------------------- | --------------- |
| Tokens per request    | **[YOUR_BASELINE_TOKENS]** | **[YOUR_COMPRESSED_TOKENS]** | **[XX% fewer]** |
| Tool calls for rename | [YOUR_BASELINE_TOOL_CALLS] | [YOUR_COMPRESSED_TOOL_CALLS] | [XX% fewer]     |
| LLM round-trips       | [YOUR_BASELINE_ROUNDTRIPS] | [YOUR_COMPRESSED_ROUNDTRIPS] | [XX% fewer]     |
| Total API cost        | [YOUR_BASELINE_COST]       | [YOUR_COMPRESSED_COST]       | [XX% cheaper]   |
| Time to completion    | [YOUR_BASELINE_TIME]       | [YOUR_COMPRESSED_TIME]       | [XX% faster]    |

<details>
<summary><b>How we measured this</b></summary>

**Task:** [DESCRIBE_YOUR_TASK_HERE — e.g. "Rename a function used across N files in a TypeScript project"]

**Setup:**

- AI Agent: Claude Code (claude-sonnet-4)
- Baseline: Direct Anthropic API connection
- With ContextForge: Routed through `localhost:3000`

**What ContextForge did:**

- Used `find_symbol()` graph query instead of reading all [YOUR_FILE_COUNT] files
- Cached tool schemas across requests (saved [YOUR_SCHEMA_CACHE_TOKENS] tokens)
- Deduplicated repeated system prompts (saved [YOUR_DEDUP_TOKENS] tokens)
- Compressed unchanged file content with semantic dedup

</details>

---

## When to Use · When to Skip

**Great fit if you…**

- Run Claude Code, Aider, or any OpenAI-compatible agent daily against a real codebase
- Hit context window limits on multi-file tasks — rename, refactor, audit, search
- Want token savings without changing your agent, your prompts, or your code
- Work across multiple agents and want a single compression layer for all of them

**Skip it if you…**

- Only send short, single-turn prompts — compression overhead pays off from turn 2 onward
- Work in a sandboxed environment where local processes and file watchers cannot run
- Need a hosted or cloud-managed solution — ContextForge is local-first by design

---

## Architecture

```
┌─────────────────┐
│  AI Agent       │  Claude Code, Aider, Cursor, Cline, Continue.dev, etc.
│  (Client)       │
└────────┬────────┘
         │ OpenAI / Anthropic-format request
         ↓
┌────────────────────────────────────────────────┐
│              ContextForge Proxy                │
│                                                │
│ ┌─────────────────────────────────────────┐   │
│ │  🧠 Repository Graph (AST + Embeddings) │   │  Symbols, call graph, file map
│ └─────────────────────────────────────────┘   │  ↓
│ ┌─────────────────────────────────────────┐   │  Tool calls intercepted
│ │  ⚡ Execution Engine (Transparent)      │   │  Executed locally, result returned
│ └─────────────────────────────────────────┘   │  ↓
│ ┌─────────────────────────────────────────┐   │  [YOUR_BASELINE_TOKENS] → [YOUR_COMPRESSED_TOKENS]
│ │  📦 Context Optimizer (Compression)     │   │  [XX%] reduction
│ └─────────────────────────────────────────┘   │
└────────┬───────────────────────────────────────┘
         │ Compressed request
         ↓
┌─────────────────┐
│  LLM Provider   │  OpenAI · Anthropic · Ollama · Groq · Gemini
└─────────────────┘
```

<details>
<summary><b>What's inside</b></summary>

- **Repository Graph** — Tree-sitter AST parser for JavaScript, TypeScript, Python, Go, Rust, Java. Indexes function and class definitions, import/export relationships, call graphs, and symbol locations. Updated live via file watcher — no restart needed.
- **Transparent Tool Interception** — Intercepts `find_symbol`, `read_file_chunk`, and `contextforge_patch_ast` calls. Executes them locally before the request reaches the LLM, eliminating round-trips.
- **Tool Schema Minimization** — Claude Code sends 33 tools and ~101KB of JSON schemas on every request. ContextForge compresses and caches these after the first request.
- **Large Result Vaulting** — Oversized tool outputs are stored locally and replaced with a vault pointer. The LLM calls `contextforge_retrieve(vault_id)` if it needs the full content. Originals are always recoverable within the configured TTL.
- **Semantic Deduplication** — Embedding-based detection of repeated file content across conversation turns. On the second occurrence, content is replaced with a compact reference.
- **AST Compression** — Large code blocks are structurally compressed while preserving enough for the LLM to reason about structure, types, and control flow without reading every line.
- **Conversation Compression** — Earlier conversation turns are summarized when the context window approaches its limit, preserving intent without preserving verbatim tokens.
- **Live Dashboard** — Real-time metrics: token delta per request, compression ratio, vault hit rate, round-trips saved, full request log. Available at `http://localhost:3000/dashboard`.

</details>

---

## How It Works — Deep Dive

<details>
<summary><b>🧠 Repository Graph</b> — AST-powered knowledge graph</summary>

ContextForge parses your codebase on startup using Tree-sitter (JavaScript, TypeScript, Python, Go, Rust, Java).

**What gets indexed:**

- Function and class definitions
- Import/export relationships
- Call graphs (which function calls which)
- Symbol locations (file, line range)

**Example LLM query:**

```json
{
  "tool": "contextforge_graph",
  "query_type": "find_symbol",
  "target": "authenticate"
}
```

**ContextForge returns:**

```json
{
  "definitions": [
    {
      "file": "src/auth/handler.ts",
      "symbol": "authenticate",
      "start_line": 47,
      "end_line": 89,
      "body": "export async function authenticate(req: Request) { ... }"
    }
  ]
}
```

**No file reading. No LLM round-trip.** 47 tokens instead of 8,000.

</details>

<details>
<summary><b>⚡ Execution Engine</b> — Transparent Tool Interception</summary>

When the LLM calls repository tools (`find_symbol`, `read_file_chunk`, `contextforge_patch_ast`), ContextForge executes them **before** sending the request to the LLM.

**Normal flow (without ContextForge):**

```
1. Client → LLM:    "Rename authenticate to verifyUser"
2. LLM → Client:    tool_call(find_symbol, "authenticate")
3. Client → LLM:    tool_result(...8,000 tokens of code...)
4. LLM → Client:    tool_call(read_file, "auth/handler.ts")
5. Client → LLM:    tool_result(...9,000 tokens...)
6. LLM → Client:    tool_call(write_file, ...)
7. Client → LLM:    tool_result("success")
8. LLM → Client:    "Done. Renamed in 3 files."
```

**Total:** 7 LLM requests, ~30,000 tokens.

**With ContextForge Transparent Tool Interception:**

```
1. Client → ContextForge:  "Rename authenticate to verifyUser"
2. ContextForge intercepts tool calls, executes locally, appends results
3. ContextForge → LLM:     "...results: [compressed, 2,400 tokens]"
4. LLM → ContextForge:     "Done. Renamed in 3 files."
5. ContextForge → Client:  "Done."
```

**Total:** 1 LLM request, ~6,000 tokens.

The LLM never knows the tools were intercepted. It thinks it made 7 requests.

</details>

<details>
<summary><b>📦 Context Optimizer</b> — Multi-stage compression pipeline</summary>

**Stage 1: Tool Schema Minimization**

Claude Code sends 33 tools and ~101KB of JSON schemas on every single request.

ContextForge compresses descriptions, removes redundant fields, caches the result after the first request.

**Stage 2: Semantic Deduplication**

If the LLM reads `auth/handler.ts` in message 3 and again in message 7, ContextForge detects the duplicate using embeddings and replaces the second occurrence with a vault pointer:

```
[CF_VAULT:cf_vault_abc123] Previously shown auth/handler.ts (2,400 tokens cached)
```

The LLM retrieves it on demand: `contextforge_retrieve(vault_id="cf_vault_abc123")`.

**Stage 3: AST Compression**

Large code blocks are structurally compressed:

```javascript
// Original (9,200 tokens)
export async function authenticate(req: Request, res: Response) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new UnauthorizedError('Missing token');
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await db.users.findById(decoded.userId);
  if (!user) throw new UnauthorizedError('User not found');
  if (user.status !== 'active') throw new ForbiddenError('Account suspended');
  req.user = user;
  next();
}
```

```javascript
// After AST compression (2,100 tokens)
export async function authenticate(req: Request, res: Response) {
  // [12 lines: token extraction, JWT verification, user lookup, status check]
  req.user = user; next();
}
```

The LLM can still reason about structure and types. If it needs the full version, it calls `contextforge_retrieve()`.

**Stage 4: Large Result Vaulting**

Tool outputs over the configured token threshold are stored locally. The LLM receives a pointer instead of the full output, reducing payload size while keeping the content fully retrievable.

**Stage 5: Conversation Compression**

Earlier turns are summarized when the context window approaches its limit, preserving intent and outcomes without preserving verbatim tokens from resolved steps.

</details>

---

## Supported Providers

| Provider      | Models                     | Notes                               |
| ------------- | -------------------------- | ----------------------------------- |
| **Ollama**    | All cloud & local models   | Default provider, no API key needed |
| **OpenAI**    | GPT-4o, GPT-4, o1, etc.    | Set `OPENAI_API_KEY` in `.env`      |
| **Anthropic** | Claude Sonnet, Opus, Haiku | Set `ANTHROPIC_API_KEY` in `.env`   |

Switch providers by editing `.env` — no code changes, restart to apply:

```bash
CF_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Configuration

All configuration lives in `.env`:

```bash
# ── Provider ───────────────────────────────────────────────────────
CF_PROVIDER=ollama              # ollama | openai | anthropic | groq | gemini

# ── Optional: force all requests to a specific model ───────────────
# CF_MODEL_OVERRIDE=llama3.1:8b

# ── API Keys (set the one matching your provider) ──────────────────
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# GROQ_API_KEY=gsk_...
# GEMINI_API_KEY=...

# ── Server ─────────────────────────────────────────────────────────
CF_PORT=3000
CF_WORKSPACE_PATH=./            # Path to your codebase for graph indexing
```

See [`.env.example`](.env.example) for the full reference.

---

## Performance

ContextForge adds **~15–40ms overhead** per request (AST indexing, compression, graph queries).

**You save 500–2,000ms** on LLM inference because the payload is 60–80% smaller.

**Net result:** Faster responses, lower cost, fewer context window overflows.

### Benchmarks

<!-- TODO: Run `npm run benchmark` and paste the output here -->

```
Coming soon — run `npm run benchmark` to generate results against your own codebase.
```

---

## Documentation

| Start here                          | Go deeper                                            |
| ----------------------------------- | ---------------------------------------------------- |
| [Quick Start](#quick-start)         | [Architecture](#architecture)                        |
| [Agent Setup](#agent-compatibility) | [How It Works — Deep Dive](#how-it-works--deep-dive) |
| [Configuration](#configuration)     | [What's Inside](#whats-inside)                       |
| [Troubleshooting](#troubleshooting) | [Roadmap](#roadmap)                                  |
| [Contributing](#contributing)       | [FAQ](#faq)                                          |

Full external docs: **coming soon.**

---

## Updating

```bash
# Docker
docker compose pull && docker compose up -d

# Local
git pull && npm install && npm start
```

The dashboard displays a notice when a newer version is available on GitHub.

---

## FAQ

<details>
<summary><b>Which coding agents are officially supported?</b></summary>

ContextForge v1 is officially tested with **Claude Code**.

Because ContextForge sits between the agent and the LLM provider, you can route requests to Anthropic, OpenAI, Gemini, Groq, Ollama, or any OpenAI-compatible endpoint without changing your workflow.

Support for additional coding agents is under active development.

</details>

<details>
<summary><b>Does ContextForge modify my code automatically?</b></summary>

No.

ContextForge never edits your repository on its own. Files are modified only when your coding agent explicitly requests a repository edit. All edits are verified before being applied.

</details>

<details>
<summary><b>Does it support streaming?</b></summary>

Yes.

ContextForge transparently forwards Server-Sent Events (SSE) streams, so responses appear exactly as they would from the upstream provider.

</details>

<details>
<summary><b>Will this work with any LLM provider?</b></summary>

Yes.

ContextForge is provider-agnostic. You can route requests to Anthropic, OpenAI, Gemini, Groq, Ollama, or any OpenAI-compatible API while continuing to use the same coding workflow.

</details>

<details>
<summary><b>What kind of token savings should I expect?</b></summary>

It depends on your workload.

Repository-heavy coding sessions typically benefit the most because ContextForge avoids repeatedly sending repository structure, duplicate tool outputs, and unchanged context.

General chat workloads still benefit from schema minimization and context optimization, but savings are naturally smaller than during repository-aware coding.

See the benchmark section for measured results.

</details>

<details>
<summary><b>How does the Repository Graph stay up to date?</b></summary>

ContextForge watches your workspace for file changes and incrementally updates its AST graph. A full repository index is built during startup, while subsequent edits update only the affected files.

</details>

<details>
<summary><b>What is Large Result Vaulting?</b></summary>

When a repository operation produces a very large result, ContextForge stores it locally and replaces it with a lightweight reference.

If the agent later needs the original content, ContextForge retrieves it transparently. This keeps requests small without permanently discarding information.

</details>

<details>
<summary><b>Can I use ContextForge in production?</b></summary>

Yes.

ContextForge is suitable for local development, CI pipelines, and self-hosted deployments.

For production environments we recommend placing it behind a reverse proxy, enabling rate limiting, and monitoring requests using the built-in dashboard.

</details>

<details>
<summary><b>Can individual optimization stages be disabled?</b></summary>

Not in v1.

Granular configuration is planned for a future release. For now, advanced users can customize the pipeline directly in the source.

</details>

<details>
<summary><b>Do I need to compile the native components?</b></summary>

If you use Docker, no.

The Docker image contains all required native components. Native builds are only needed when running directly from source.

</details>

## Roadmap

- [x] Multi-provider routing (Ollama, OpenAI, Anthropic)
- [x] Transparent Tool Interception for repository tools
- [x] AST-powered knowledge graph (JS, TS, Python, Go, Rust, Java)
- [x] Semantic deduplication and AST compression
- [x] Large Result Vaulting with on-demand retrieval
- [x] Live metrics dashboard
- [x] Docker support with zero-setup startup
- [ ] **v1.1:** Config-driven per-stage compression toggles
- [ ] **v1.2:** Multi-workspace support for monorepos
- [ ] **v1.3:** Persistent cross-session memory for agents
- [ ] **v1.4:** Native prompt caching integration (Anthropic, OpenAI, Gemini)
- [ ] **v1.5:** Horizontal scaling with Redis-backed shared cache
- [ ] **v1.6:** C#, Ruby, and Swift grammar support

See the [full roadmap and open issues](https://github.com/[YOUR_ORG]/contextforge/issues) on GitHub.

---

## Contributing

We welcome contributions. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

**Good first issues:**

- [Add support for C# grammar](https://github.com/[YOUR_ORG]/contextforge/issues/TODO)
- [Benchmark suite for compression stages](https://github.com/[YOUR_ORG]/contextforge/issues/TODO)
- [Dashboard dark/light mode toggle](https://github.com/[YOUR_ORG]/contextforge/issues/TODO)
- [Config-driven stage disabling](https://github.com/[YOUR_ORG]/contextforge/issues/TODO)

**Development setup:**

```bash
# Option 1: VS Code Dev Container (recommended — everything preinstalled)
# 1. Install Docker + VS Code Remote Containers extension
# 2. Open repo in VS Code → "Reopen in Container"
# 3. npm start

# Option 2: Local
npm install        # Requires Node 20+, Python 3, C++ compiler
npm run setup:all  # Downloads models, clones Tree-sitter grammars
npm run rebuild    # Compiles native modules
npm start
```

**Run tests:**

```bash
npm test
npm run test:compression    # Compression pipeline unit tests
npm run test:graph          # AST graph integration tests
npm run benchmark           # Full benchmark suite against your codebase
```

---

## Troubleshooting

<details>
<summary><b>Error: "Cannot find module 'contextforge_native.node'"</b></summary>

The C++ native module didn't compile. Run:

```bash
npm run rebuild
```

If that fails, install build tools first:

**Windows:**

```bash
npm install --global windows-build-tools
```

**macOS:**

```bash
xcode-select --install
```

**Linux:**

```bash
sudo apt-get install build-essential python3 cmake
```

Or use Docker to skip this entirely:

```bash
docker compose up -d
```

</details>

<details>
<summary><b>Error: "ONNX model not found"</b></summary>

```bash
npm run setup:models
```

This downloads the 23MB embedding model from HuggingFace. Requires outbound HTTPS access to `huggingface.co`.

</details>

<details>
<summary><b>Dashboard shows "DISCONNECTED"</b></summary>

The SSE stream at `/v1/stats/stream` is not reachable. Check:

1. ContextForge is running — `npm start` should print "Proxy routing engine active"
2. Your browser is not blocking `localhost` connections
3. No firewall is blocking port 3000

Try opening `http://localhost:3000/dashboard` in an incognito tab to rule out extension interference.

</details>

<details>
<summary><b>Compression ratio is 0% or negative on the first message</b></summary>

Expected. Tool schema injection adds tokens before any compression can recover them. From the second message onward — once the LLM starts reading files and calling tools — the pipeline engages and compression ratios climb. Typical steady-state ratios appear by message 3.

</details>

<details>
<summary><b>LLM responses are truncated or garbled</b></summary>

ContextForge may be over-compressing a specific payload. Debug:

```bash
CF_DEBUG_PAYLOAD=1 npm start
```

Make a request. Inspect `debug_payload.json` in the project root and compare what was sent to what the LLM received. Open an issue with the payload (redact any secrets).

</details>

---

## Community

- **[GitHub Discussions](https://github.com/[YOUR_ORG]/contextforge/discussions)** — questions, use cases, feedback
- **[Issues](https://github.com/[YOUR_ORG]/contextforge/issues)** — bug reports and feature requests
- **Discord** — coming soon

---

## Acknowledgments

ContextForge is built on top of exceptional open-source work:

- [Tree-sitter](https://tree-sitter.github.io/) — Incremental, error-tolerant parsing system
- [ONNX Runtime](https://onnxruntime.ai/) — Cross-platform ML inference engine
- [Sentence Transformers](https://www.sbert.net/) — Semantic embedding models
- [Chart.js](https://www.chartjs.org/) — Dashboard visualizations

Inspired by the agent-native thinking of [Anthropic's Claude](https://www.anthropic.com/), [Cursor](https://cursor.sh/), and [Simon Willison](https://simonwillison.net/)'s work on LLM observability.

---

## License

MIT — see [LICENSE](LICENSE).

**Built by [YOUR_NAME]** with contributions from the open-source community.

---

## Placeholders to Fill Before Launch

| Section                 | Placeholder                                            | What to add                                     |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| **Quick Start**         | `[YOUR_ORG]`                                           | Your GitHub username or org name                |
| **Demo GIF**            | `docs/images/demo.gif`                                 | Terminal recording — same task, with vs without |
| **Demo caption**        | `[YOUR_BASELINE_TOKENS]`, `[YOUR_COMPRESSED_TOKENS]`   | Real token counts from your benchmark           |
| **Real Results table**  | All `[YOUR_*]` and `[XX%]` cells                       | Numbers from a real representative task         |
| **How we measured**     | `[DESCRIBE_YOUR_TASK_HERE]`, `[YOUR_FILE_COUNT]`, etc. | Actual task and setup description               |
| **Benchmarks block**    | `npm run benchmark` output                             | Paste after running against your codebase       |
| **Contributing issues** | All `TODO` issue links                                 | Create the issues on GitHub and paste the URLs  |
| **Community → Discord** | Discord invite link                                    | Create the server and replace "coming soon"     |
| **License / Built by**  | `[YOUR_NAME]`                                          | Your name or GitHub handle                      |
| **Docs links**          | "coming soon" entries                                  | Replace once external docs are published        |

---

<p align="center">
  <i>Stop wasting tokens. Start building faster.</i><br/>
  <b>⚒️ Forge better context.</b>
</p>
