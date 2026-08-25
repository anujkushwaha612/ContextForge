# Sandbox provisioning (Arena / sandbox environments)

Sandbox resets wipe the provisioned build artifacts (`node_modules`,
`native/build`, `native/tree-sitter-src`, `native/vendor/onnxruntime`,
`contextforge_models/`). **One command restores everything:**

```bash
cd <repo> && bash scripts/provision-sandbox.sh
```

Idempotent — every step is skipped when its artifact already exists, so
re-running after each reset is the intended workflow.

## What it does (and why each step is shaped that way)

Sandbox network facts (observed): `registry.npmjs.org` ✅,
`github.com` / `api.github.com` ✅, `nodejs.org` ❌ blocked,
`huggingface.co` ❌ blocked, GitHub release CDN (`objects.githubusercontent.com`) ❌.

1. **`npm install`** (plain, `--ignore-scripts` fallback).
2. **better-sqlite3** — rebuilt with `node-gyp --nodedir="$(dirname $(dirname $(which node)))"`
   because nodejs.org (the usual node-headers source) is blocked; the
   sandbox node ships its headers in its own prefix. The check is
   `new (require('better-sqlite3'))(':memory:')` — a plain `require` is NOT
   a valid check (the JS wrapper loads without the native binding; only
   constructing a `Database` exercises it).
3. **tree-sitter grammars** — `scripts/vendor-grammars.sh` (pinned tags,
   cloned from GitHub ✅).
4. **onnxruntime** — the lib comes from the published npm tarball
   (`npm pack @anuj612/contextforge@<version>` → `prebuilds/linux-x64/libonnxruntime.so*`)
   because the GitHub release CDN is blocked; the single C header comes
   from the GitHub API contents endpoint (`api.github.com` ✅).
5. **`contextforge_native.node`** — `node-gyp rebuild --release
   --nodedir=...` (same local-headers reason as better-sqlite3).
6. **Embedder model** — tries `scripts/setup-onnx.sh` (real
   all-MiniLM-L6-v2 int8 model from HuggingFace) first; when HuggingFace
   is unreachable it falls back to `scripts/provision-sandbox-stub-model.py`,
   which generates a VALID ONNX model + tokenizer that satisfies the
   native embedder's contract (deterministic but not semantically
   meaningful embeddings — fine for pipeline smoke-tests, not for real
   semantic search).
7. **Self-verification** — constructs a better-sqlite3 Database, loads
   `contextforge_native.node` and checks all seven exports
   (`SemanticCache, HybridRetriever, ASTCompressor, simhash,
   hammingDistance, PersistentMemoryStore, OnnxEmbedder`), checks the
   model files exist. Exits non-zero on any failure.

## Quick end-to-end smoke test (after provisioning)

```bash
# 1. mock upstream (fixed response)
node -e '
require("http").createServer((req,res)=>{let b="";req.on("data",c=>b+=c);
req.on("end",()=>{res.writeHead(200,{"Content-Type":"application/json"});
res.end(JSON.stringify({id:"smoke",object:"chat.completion",model:"smoke",
choices:[{index:0,message:{role:"assistant",content:"SMOKE OK"},finish_reason:"stop"}],
usage:{prompt_tokens:10,completion_tokens:2}}))})}).listen(18081,"127.0.0.1",
()=>console.log("mock on 18081"))' &

# 2. the proxy (stub model, optimize off, no nudge)
mkdir -p /tmp/cf-smoke-ws && echo 'function f(){return 1}' > /tmp/cf-smoke-ws/a.js
CF_WORKSPACE_PATH=/tmp/cf-smoke-ws CF_DATA_DIR=/tmp/cf-smoke-data CF_PORT=13001 \
CF_PROVIDER=ollama OLLAMA_HOST=127.0.0.1 OLLAMA_PORT=18081 \
CF_OPTIMIZE=false CF_NUDGE_TOOLS=0 CF_SAVINGS_PATH=/tmp/cf-smoke-savings.json \
node /path/to/repo/src/server.js &

# 3. expect {"...","content":"SMOKE OK","..."}
curl -s -X POST http://127.0.0.1:13001/v1/chat/completions \
  -H "content-type: application/json" -d '{"model":"m","messages":[{"role":"user","content":"hi"}]}'
```

Expected: `{"...","content":"SMOKE OK",...}` and `CF_READY port=13001`
in the server log. The stub model means embedding-dependent features
(semantic retrieval, planner semantic fallback) run but return
non-meaningful vectors — the rest of the pipeline (compression, graph,
proxying) works normally.
