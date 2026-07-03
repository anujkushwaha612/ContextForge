#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-onnx.sh
#
# Downloads the ONNX model and tokenizer required by ContextForge.
# - Downloads the REAL int8 quantized model (23 MB, Xenova export)
# - SHA-256 verified, atomic writes (no corrupt half-downloads surviving)
# - Resumable, retrying, idempotent
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Anchor to the repo root (script lives in scripts/), not the caller's CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"
MODELS_DIR="${CF_MODEL_DIR:-${REPO_ROOT}/contextforge_models}"

# NOTE: optimum/all-MiniLM-L6-v2 model.onnx is the fp32 model (91 MB), NOT int8.
# Xenova's model_quantized.onnx is the actual int8 export (23 MB).
# The tokenizer.json in both repos is byte-identical.
MODEL_URL="https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx"
TOKENIZER_URL="https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json"

MODEL_FILE="${MODELS_DIR}/all-MiniLM-L6-v2-int8.onnx"
TOKENIZER_FILE="${MODELS_DIR}/tokenizer.json"

# Pinned checksums (HF LFS oid == sha256 of content; tokenizer computed directly).
MODEL_SHA256="afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"
TOKENIZER_SHA256="da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ContextForge — ONNX Model Setup"
echo "  → ${MODELS_DIR}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

mkdir -p "${MODELS_DIR}"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'   # macOS
    else
        echo "  ⚠️  No sha256 tool found — skipping verification" >&2
        echo "SKIP"
    fi
}

# fetch <url> <dest> <sha256> <label>
fetch() {
    local url="$1" dest="$2" expected="$3" label="$4"
    local tmp="${dest}.tmp"

    # Already present AND checksum matches → skip.
    if [ -f "${dest}" ]; then
        local have
        have="$(sha256_of "${dest}")"
        if [ "${have}" = "${expected}" ] || [ "${have}" = "SKIP" ]; then
            echo "  ✅ ${label} already exists (verified) — skipping"
            return 0
        fi
        echo "  ⚠️  ${label} exists but checksum mismatch — re-downloading"
        rm -f "${dest}"
    fi

    echo "  ⬇️  Downloading ${label}..."
    if command -v curl >/dev/null 2>&1; then
        # --fail: don't save HTML error pages as the model
        # -C -  : resume partial .tmp from a previous interrupted run
        curl --fail --location --retry 3 --retry-delay 2 -C - \
             --progress-bar "${url}" -o "${tmp}"
    elif command -v wget >/dev/null 2>&1; then
        wget -q --show-progress --tries=3 --continue "${url}" -O "${tmp}"
    else
        echo "  ❌ ERROR: Neither curl nor wget found. Install one and retry."
        exit 1
    fi

    # Verify BEFORE the file gets its final name.
    local got
    got="$(sha256_of "${tmp}")"
    if [ "${got}" != "SKIP" ] && [ "${got}" != "${expected}" ]; then
        echo "  ❌ ERROR: ${label} checksum mismatch"
        echo "     expected: ${expected}"
        echo "     got:      ${got}"
        rm -f "${tmp}"
        exit 1
    fi

    mv "${tmp}" "${dest}"   # atomic: file only exists under final name if valid
    echo "  ✅ ${label} downloaded & verified"
}

fetch "${MODEL_URL}"     "${MODEL_FILE}"     "${MODEL_SHA256}"     "ONNX model (int8, ~23MB)"
fetch "${TOKENIZER_URL}" "${TOKENIZER_FILE}" "${TOKENIZER_SHA256}" "tokenizer.json (~700KB)"

echo ""
echo "  🎉 ONNX setup complete!"
echo ""
