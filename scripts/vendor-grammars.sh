#!/bin/bash
# scripts/vendor-grammars.sh

set -e
DEST="native/tree-sitter-src"
mkdir -p "$DEST"

echo "Cloning tree-sitter runtime..."
git clone --depth=1 https://github.com/tree-sitter/tree-sitter \
  "$DEST/tree-sitter"

echo "Cloning grammars..."
git clone --depth=1 https://github.com/tree-sitter/tree-sitter-javascript \
  "$DEST/tree-sitter-javascript"

# NOTE: tsx is INSIDE tree-sitter-typescript — one clone gets both
git clone --depth=1 https://github.com/tree-sitter/tree-sitter-typescript \
  "$DEST/tree-sitter-typescript"

# Verify tsx files exist after clone
if [ ! -f "$DEST/tree-sitter-typescript/tsx/src/parser.c" ]; then
  echo "ERROR: tsx/src/parser.c not found inside tree-sitter-typescript"
  exit 1
fi

git clone --depth=1 https://github.com/tree-sitter/tree-sitter-python \
  "$DEST/tree-sitter-python"

git clone --depth=1 https://github.com/tree-sitter/tree-sitter-go \
  "$DEST/tree-sitter-go"

git clone --depth=1 https://github.com/tree-sitter/tree-sitter-rust \
  "$DEST/tree-sitter-rust"

git clone --depth=1 https://github.com/tree-sitter/tree-sitter-java \
  "$DEST/tree-sitter-java"

echo "Done. Run: cd native && npx node-gyp rebuild"