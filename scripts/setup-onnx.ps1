# ─────────────────────────────────────────────────────────────────────────────
# setup-onnx.ps1 — Windows PowerShell version of setup-onnx.sh
# Run with: powershell -ExecutionPolicy Bypass -File scripts\setup-onnx.ps1
# ─────────────────────────────────────────────────────────────────────────────

$ModelsDir = ".\contextforge_models"
$ModelFile = "$ModelsDir\all-MiniLM-L6-v2-int8.onnx"
$TokenizerFile = "$ModelsDir\tokenizer.json"

$ModelUrl = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model_int8.onnx"
$TokenizerUrl = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  ContextForge — ONNX Model Setup" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host ""

New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

# ── Download model ────────────────────────────────────────────────────────────
if (Test-Path $ModelFile) {
    Write-Host "  ✅ ONNX model already exists — skipping download" -ForegroundColor Green
} else {
    Write-Host "  ⬇️  Downloading ONNX model (~23MB)..." -ForegroundColor Yellow
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $ModelUrl -OutFile $ModelFile -UseBasicParsing
        Write-Host "  ✅ ONNX model downloaded" -ForegroundColor Green
    } catch {
        Write-Host "  ❌ ERROR: Failed to download model: $_" -ForegroundColor Red
        exit 1
    }
}

# ── Download tokenizer ────────────────────────────────────────────────────────
if (Test-Path $TokenizerFile) {
    Write-Host "  ✅ Tokenizer already exists — skipping download" -ForegroundColor Green
} else {
    Write-Host "  ⬇️  Downloading tokenizer.json..." -ForegroundColor Yellow
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $TokenizerUrl -OutFile $TokenizerFile -UseBasicParsing
        Write-Host "  ✅ Tokenizer downloaded" -ForegroundColor Green
    } catch {
        Write-Host "  ❌ ERROR: Failed to download tokenizer: $_" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "  🎉 ONNX setup complete!" -ForegroundColor Green
Write-Host ""