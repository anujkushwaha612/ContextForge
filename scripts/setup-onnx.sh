#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-onnx.sh
#
# Downloads the ONNX model and tokenizer required by ContextForge.
# Safe to run multiple times — skips download if files already exist.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

MODELS_DIR="./contextforge_models"
MODEL_FILE="${MODELS_DIR}/all-MiniLM-L6-v2-int8.onnx"
TOKENIZER_FILE="${MODELS_DIR}/tokenizer.json"

MODEL_URL="https://huggingface.co/optimum/all-MiniLM-L6-v2/resolve/main/model.onnx"
TOKENIZER_URL="https://huggingface.co/optimum/all-MiniLM-L6-v2/resolve/main/tokenizer.json"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ContextForge — ONNX Model Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

mkdir -p "${MODELS_DIR}"

# ── Download model ────────────────────────────────────────────────────────────
if [ -f "${MODEL_FILE}" ]; then
    echo "  ✅ ONNX model already exists — skipping download"
else
    echo "  ⬇️  Downloading ONNX model (~23MB)..."
    if command -v curl &>/dev/null; then
        curl -L --progress-bar "${MODEL_URL}" -o "${MODEL_FILE}"
    elif command -v wget &>/dev/null; then
        wget -q --show-progress "${MODEL_URL}" -O "${MODEL_FILE}"
    else
        echo "  ❌ ERROR: Neither curl nor wget found. Install one and retry."
        exit 1
    fi
    echo "  ✅ ONNX model downloaded"
fi

# ── Download tokenizer ────────────────────────────────────────────────────────
if [ -f "${TOKENIZER_FILE}" ]; then
    echo "  ✅ Tokenizer already exists — skipping download"
else
    echo "  ⬇️  Downloading tokenizer.json (~400KB)..."
    if command -v curl &>/dev/null; then
        curl -L --progress-bar "${TOKENIZER_URL}" -o "${TOKENIZER_FILE}"
    elif command -v wget &>/dev/null; then
        wget -q --show-progress "${TOKENIZER_URL}" -O "${TOKENIZER_FILE}"
    else
        echo "  ❌ ERROR: Neither curl nor wget found."
        exit 1
    fi
    echo "  ✅ Tokenizer downloaded"
fi

echo ""
echo "  🎉 ONNX setup complete!"
echo ""