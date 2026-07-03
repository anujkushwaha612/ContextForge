#!/usr/bin/env bash
# scripts/vendor-grammars.sh
#
# Clones tree-sitter runtime and language grammars into native/tree-sitter-src.
# Safe to run multiple times — skips repos that already exist.
#
# FIXED (release-hardening pass):
#   VG-1: All repos PINNED to tags — unpinned HEAD clones meant local and CI
#         could compile different grammar versions, and upstream layout
#         changes could break the release pipeline on their schedule.
#   VG-2: Paths anchored to the repo root (script runs correctly from any CWD).
#   VG-3: Clone retry (3 attempts) — one GitHub hiccup no longer fails CI.

set -euo pipefail

# VG-2: anchor to repo root regardless of caller's CWD
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"
DEST="${REPO_ROOT}/native/tree-sitter-src"
mkdir -p "$DEST"

# ─────────────────────────────────────────────
# VG-1: Pinned versions. Bump deliberately, test, commit.
# lib/src/lib.c (amalgamation) verified present in runtime 0.25.x.
# ─────────────────────────────────────────────
TS_RUNTIME_TAG="v0.25.3"
TS_JAVASCRIPT_TAG="v0.23.1"
TS_TYPESCRIPT_TAG="v0.23.2"
TS_PYTHON_TAG="v0.23.6"
TS_GO_TAG="v0.23.4"
TS_RUST_TAG="v0.23.2"
TS_JAVA_TAG="v0.23.5"

# ─────────────────────────────────────────────
# Helper: clone a pinned tag only if directory doesn't exist (VG-3: retries)
# ─────────────────────────────────────────────
clone_if_missing() {
  local url="$1"
  local dir="$2"
  local tag="$3"
  local label="$4"

  if [ -d "$dir" ]; then
    echo "  ✅ Already exists — skipping: $label"
    return 0
  fi

  echo "  ⬇️  Cloning $label @ $tag..."
  local attempt
  for attempt in 1 2 3; do
    if git clone --depth=1 --branch "$tag" "$url" "$dir" 2>/dev/null; then
      echo "  ✅ Done: $label"
      return 0
    fi
    echo "  ⚠️  Attempt $attempt failed — retrying in 3s..."
    rm -rf "$dir"
    sleep 3
  done

  echo "  ❌ ERROR: failed to clone $label after 3 attempts"
  exit 1
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ContextForge — Tree-sitter Grammar Setup (pinned)"
echo "  → $DEST"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Tree-sitter core runtime ──────────────────────────────
clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter" \
  "$DEST/tree-sitter" \
  "$TS_RUNTIME_TAG" \
  "tree-sitter runtime"

# ── Language grammars ─────────────────────────────────────
clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-javascript" \
  "$DEST/tree-sitter-javascript" \
  "$TS_JAVASCRIPT_TAG" \
  "JavaScript"

# NOTE: tsx lives INSIDE tree-sitter-typescript — one clone gets both
clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-typescript" \
  "$DEST/tree-sitter-typescript" \
  "$TS_TYPESCRIPT_TAG" \
  "TypeScript + TSX"

clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-python" \
  "$DEST/tree-sitter-python" \
  "$TS_PYTHON_TAG" \
  "Python"

clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-go" \
  "$DEST/tree-sitter-go" \
  "$TS_GO_TAG" \
  "Go"

clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-rust" \
  "$DEST/tree-sitter-rust" \
  "$TS_RUST_TAG" \
  "Rust"

clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-java" \
  "$DEST/tree-sitter-java" \
  "$TS_JAVA_TAG" \
  "Java"

# ── Verify the files binding.gyp actually compiles ────────
echo ""
echo "  Verifying build-critical files..."
MISSING=0
for f in \
  "$DEST/tree-sitter/lib/src/lib.c" \
  "$DEST/tree-sitter/lib/include/tree_sitter/api.h" \
  "$DEST/tree-sitter-javascript/src/parser.c" \
  "$DEST/tree-sitter-typescript/typescript/src/parser.c" \
  "$DEST/tree-sitter-typescript/tsx/src/parser.c" \
  "$DEST/tree-sitter-python/src/parser.c" \
  "$DEST/tree-sitter-go/src/parser.c" \
  "$DEST/tree-sitter-rust/src/parser.c" \
  "$DEST/tree-sitter-java/src/parser.c"
do
  if [ ! -f "$f" ]; then
    echo "  ❌ MISSING: $f"
    MISSING=1
  fi
done

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo "  ❌ ERROR: build-critical files missing. Delete the affected"
  echo "     directory under native/tree-sitter-src and re-run."
  exit 1
fi
echo "  ✅ All build-critical files verified"

# ── Summary ───────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ All grammars ready (pinned versions)"
echo ""
echo "  Next step:"
echo "    npm run build:native"
echo "    (or from native/: npx node-gyp rebuild)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
