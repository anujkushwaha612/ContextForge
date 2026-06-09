#!/bin/bash
# scripts/setup-onnx.sh

set -e

DEST="native/vendor/onnxruntime"
mkdir -p "$DEST"

ORT_VERSION="1.20.1"
ORT_PLATFORM="win-x64"

echo "[2/3] Downloading nlohmann/json..."

mkdir -p native/vendor/nlohmann

curl -L \
  "https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp" \
  -o native/vendor/nlohmann/json.hpp

echo "[3/3] Downloading MiniLM model..."

mkdir -p models

python -c "
from huggingface_hub import hf_hub_download
import shutil

path = hf_hub_download(
    repo_id='optimum/all-MiniLM-L6-v2',
    filename='model_quantized.onnx'
)
shutil.copy(path, 'models/all-MiniLM-L6-v2-int8.onnx')

path2 = hf_hub_download(
    repo_id='sentence-transformers/all-MiniLM-L6-v2',
    filename='tokenizer.json'
)
shutil.copy(path2, 'models/tokenizer.json')

print('Models downloaded successfully')
"

echo
echo 'Setup complete.'
echo 'Run: cd native && npx node-gyp rebuild'