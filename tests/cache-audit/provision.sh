#!/usr/bin/env bash
# Idempotent test-environment provisioner for the cache-audit harness.
# Re-runnable after environment resets (skips steps whose artifacts exist).
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ ! -d node_modules/better-sqlite3/build/Release ]; then
  echo "[provision] npm install --ignore-scripts"
  npm install --ignore-scripts --no-audit --no-fund >/dev/null
  echo "[provision] rebuilding better-sqlite3"
  (cd node_modules/better-sqlite3 && npx node-gyp rebuild --release --nodedir=/usr/local >/dev/null 2>&1)
fi

if [ ! -d native/tree-sitter-src/tree-sitter ]; then
  echo "[provision] vendoring tree-sitter grammars"
  bash scripts/vendor-grammars.sh >/dev/null
fi

if [ ! -f native/vendor/onnxruntime/include/onnxruntime_c_api.h ]; then
  echo "[provision] vendoring onnxruntime"
  mkdir -p native/vendor/onnxruntime/lib native/vendor/onnxruntime/include
  TARBALL=$(mktemp)
  curl -fsSL -o "$TARBALL" "https://registry.npmjs.org/@anuj612/contextforge/-/contextforge-1.0.5.tgz"
  tar xzf "$TARBALL" package/prebuilds/linux-x64
  cp package/prebuilds/linux-x64/libonnxruntime.so* native/vendor/onnxruntime/lib/
  rm -rf package "$TARBALL"
  curl -fsSL "https://api.github.com/repos/microsoft/onnxruntime/contents/include/onnxruntime/core/session/onnxruntime_c_api.h?ref=v1.20.1" -o /tmp/ort_h.json
  node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('/tmp/ort_h.json','utf-8'));if(!j.content){console.error('no content');process.exit(1);}fs.writeFileSync('native/vendor/onnxruntime/include/onnxruntime_c_api.h',Buffer.from(j.content,'base64'));"
  rm -f /tmp/ort_h.json
fi

if [ ! -f native/build/Release/contextforge_native.node ]; then
  echo "[provision] building native module"
  (cd native && npx node-gyp rebuild --release --nodedir=/usr/local >/dev/null 2>&1)
fi

if [ ! -f contextforge_models/all-MiniLM-L6-v2-int8.onnx ]; then
  mkdir -p contextforge_models
echo "[provision] generating stub embedder model"
  python3 -m venv /tmp/cfvenv >/dev/null 2>&1 || true
  /tmp/cfvenv/bin/pip install --quiet onnx numpy >/dev/null 2>&1 || true
  /tmp/cfvenv/bin/python tests/cache-audit/make_stub_model.py
fi

echo "[provision] done"
