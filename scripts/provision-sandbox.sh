#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ContextForge — sandbox provisioning (Arena/sandbox environments)
#
# Re-provisions everything that sandbox resets tend to wipe:
#   1. node_modules            (JS deps)
#   2. better-sqlite3 native   (node-gyp with local node headers)
#   3. native/tree-sitter-src  (pinned grammars, cloned from GitHub)
#   4. native/vendor/onnxruntime (lib + C API header)
#   5. native/build            (contextforge_native.node, from source)
#   6. contextforge_models/    (real model if HuggingFace is reachable,
#                               stub model otherwise — sandbox fallback)
#
# Idempotent: every step is skipped when its artifact already exists.
# Run from anywhere:  bash scripts/provision-sandbox.sh
#
# Sandbox network facts (as observed in the Arena sandbox, 2026-08):
#   - registry.npmjs.org        → reachable
#   - github.com / api.github.com / codeload → reachable
#   - nodejs.org                → BLOCKED  (use --nodedir=/usr/local instead)
#   - huggingface.co            → BLOCKED  (use the stub-model fallback)
#   - objects.githubusercontent.com (release CDN) → BLOCKED
#     (so GitHub *release asset* downloads fail; the npm tarball +
#      the GitHub API contents endpoint are the working routes)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

log() { echo "[provision] $*"; }

# ── 1. JS dependencies ──────────────────────────────────────────────────────
if [ ! -d node_modules/better-sqlite3 ]; then
  log "installing node_modules (plain install first, ignore-scripts fallback)"
  npm install --no-audit --no-fund >/dev/null 2>&1 \
    || npm install --ignore-scripts --no-audit --no-fund
fi

# ── 2. better-sqlite3 native binding ────────────────────────────────────────
# nodejs.org is blocked in the sandbox, so plain `npm install` cannot fetch
# node headers for node-gyp. The sandbox node install ships its headers in
# /usr/local/include/node → point node-gyp at the local prefix with --nodedir.
NODE_PREFIX="$(dirname "$(dirname "$(command -v node)")")"
# NOTE: require('better-sqlite3') alone is NOT a valid check — the JS wrapper
# loads fine without the native binding (binding is lazy). Constructing a
# Database is what actually exercises the binding.
if ! node -e "new (require('better-sqlite3'))(':memory:')" >/dev/null 2>&1; then
  log "rebuilding better-sqlite3 (node-gyp, --nodedir=$NODE_PREFIX)"
  (cd node_modules/better-sqlite3 && npx node-gyp rebuild --release --nodedir="$NODE_PREFIX")
fi
node -e "new (require('better-sqlite3'))(':memory:'); console.log('[provision] better-sqlite3 OK')"

# ── 3. tree-sitter grammars (pinned tags, cloned from GitHub) ───────────────
if [ ! -d native/tree-sitter-src/tree-sitter ]; then
  log "vendoring tree-sitter grammars (pinned tags)"
  bash scripts/vendor-grammars.sh
fi

# ── 4. onnxruntime (lib + C header) ─────────────────────────────────────────
# GitHub release CDN is blocked in the sandbox, so the lib comes from the
# published npm tarball (prebuilds/linux-x64) and the single C header comes
# from the GitHub API contents endpoint (api.github.com works).
ORT_VER="$(grep -oP 'ORT_VERSION: "\K[^"]+' .github/workflows/prebuild.yml | head -1)"
if [ ! -f native/vendor/onnxruntime/lib/libonnxruntime.so ] \
   || [ ! -f native/vendor/onnxruntime/include/onnxruntime_c_api.h ]; then
  log "provisioning onnxruntime ${ORT_VER:-1.20.1}"
  mkdir -p native/vendor/onnxruntime/lib native/vendor/onnxruntime/include
  TMPD="$(mktemp -d)"
  if [ ! -f native/vendor/onnxruntime/lib/libonnxruntime.so ]; then
    PKGVER="$(node -p 'require("./package.json").version' 2>/dev/null || echo 1.0.5)"
    ( cd "$TMPD" && ( npm pack "@anuj612/contextforge@$PKGVER" || npm pack "@anuj612/contextforge@1.0.5" ) >/dev/null 2>&1 )
    TGZ="$(ls "$TMPD"/*.tgz | head -1)"
    ( cd "$TMPD" && tar xzf "$TGZ" package/prebuilds/linux-x64 )
    cp "$TMPD"/package/prebuilds/linux-x64/libonnxruntime.so* native/vendor/onnxruntime/lib/
  fi
  if [ ! -f native/vendor/onnxruntime/include/onnxruntime_c_api.h ]; then
    VER="${ORT_VER:-1.20.1}"
    curl -fsSL "https://api.github.com/repos/microsoft/onnxruntime/contents/include/onnxruntime/core/session/onnxruntime_c_api.h?ref=v${VER}" -o "$TMPD/ort_h.json"
    node -e "
      const fs = require('fs');
      const j = JSON.parse(fs.readFileSync('$TMPD/ort_h.json', 'utf-8'));
      if (!j.content) { console.error('header fetch failed:', j.error || 'no content'); process.exit(1); }
      fs.writeFileSync('native/vendor/onnxruntime/include/onnxruntime_c_api.h', Buffer.from(j.content, 'base64'));
    "
  fi
  rm -rf "$TMPD"
fi

# ── 5. native module (from source, with local node headers) ────────────────
if [ ! -f native/build/Release/contextforge_native.node ]; then
  log "building contextforge_native.node (node-gyp, --nodedir=$NODE_PREFIX)"
  (cd native && npx node-gyp rebuild --release --nodedir="$NODE_PREFIX")
fi

# ── 6. ONNX model + tokenizer ───────────────────────────────────────────────
if [ ! -f contextforge_models/all-MiniLM-L6-v2-int8.onnx ] \
   || [ ! -f contextforge_models/tokenizer.json ]; then
  log "provisioning embedder model (real model if HuggingFace is reachable, else stub)"
  mkdir -p contextforge_models
  if bash scripts/setup-onnx.sh >/dev/null 2>&1; then
    log "real model installed via scripts/setup-onnx.sh"
  else
    log "HuggingFace unreachable → generating STUB model (pipeline smoke-tests only)"
    python3 -m venv /tmp/cfvenv 2>/dev/null || true
    /tmp/cfvenv/bin/pip install --quiet onnx numpy 2>/dev/null || /tmp/cfvenv/bin/pip install --quiet --break-system-packages onnx numpy
    /tmp/cfvenv/bin/python scripts/provision-sandbox-stub-model.py
  fi
fi

# ── 7. verification ─────────────────────────────────────────────────────────
log "verifying"
node -e "require('better-sqlite3'); console.log('[provision] better-sqlite3 OK')"
node -e "
  const m = require('./native/build/Release/contextforge_native.node');
  const need = ['SemanticCache','HybridRetriever','ASTCompressor','simhash','hammingDistance','PersistentMemoryStore','OnnxEmbedder'];
  const missing = need.filter(n => !m[n]);
  if (missing.length) { console.error('[provision] native module missing:', missing); process.exit(1); }
  console.log('[provision] contextforge_native OK');
"
node -e "
  const fs = require('fs');
  const need = ['contextforge_models/all-MiniLM-L6-v2-int8.onnx','contextforge_models/tokenizer.json'];
  for (const f of need) if (!fs.existsSync(f)) { console.error('[provision] missing', f); process.exit(1); }
  console.log('[provision] models OK');
"
log "provisioning complete"
