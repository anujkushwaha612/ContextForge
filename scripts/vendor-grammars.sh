#!/bin/bash
# scripts/vendor-grammars.sh
#
# Clones tree-sitter runtime and language grammars into native/tree-sitter-src.
# Safe to run multiple times — skips repos that already exist.

set -e

DEST="native/tree-sitter-src"
mkdir -p "$DEST"

# ─────────────────────────────────────────────
# Helper: clone only if directory doesn't exist
# ─────────────────────────────────────────────
clone_if_missing() {
  local url="$1"
  local dir="$2"
  local label="$3"

  if [ -d "$dir" ]; then
    echo "  ✅ Already exists — skipping: $label"
  else
    echo "  ⬇️  Cloning $label..."
    git clone --depth=1 "$url" "$dir"
    echo "  ✅ Done: $label"
  fi
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ContextForge — Tree-sitter Grammar Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Tree-sitter core runtime ──────────────────────────────
clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter" \
  "$DEST/tree-sitter" \
  "tree-sitter runtime"

# ── Language grammars ─────────────────────────────────────
clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-javascript" \
  "$DEST/tree-sitter-javascript" \
  "JavaScript"

# NOTE: tsx lives INSIDE tree-sitter-typescript — one clone gets both
clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-typescript" \
  "$DEST/tree-sitter-typescript" \
  "TypeScript + TSX"

clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-python" \
  "$DEST/tree-sitter-python" \
  "Python"

clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-go" \
  "$DEST/tree-sitter-go" \
  "Go"

clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-rust" \
  "$DEST/tree-sitter-rust" \
  "Rust"

clone_if_missing \
  "https://github.com/tree-sitter/tree-sitter-java" \
  "$DEST/tree-sitter-java" \
  "Java"

# ── Verify tsx parser exists ──────────────────────────────
echo ""
echo "  Verifying tsx parser..."
if [ ! -f "$DEST/tree-sitter-typescript/tsx/src/parser.c" ]; then
  echo ""
  echo "  ❌ ERROR: tsx/src/parser.c not found inside tree-sitter-typescript"
  echo "     Try deleting native/tree-sitter-src/tree-sitter-typescript"
  echo "     and running this script again."
  exit 1
fi
echo "  ✅ tsx parser.c verified"

# ── Summary ───────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ All grammars ready"
echo ""
echo "  Next step:"
echo "    npm run rebuild"
echo "    (or from native/: npx node-gyp rebuild)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""