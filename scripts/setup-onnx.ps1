# ─────────────────────────────────────────────────────────────────────────────
# setup-onnx.ps1
#
# Downloads the ONNX model and tokenizer required by ContextForge.
# - Downloads the REAL int8 quantized model (23 MB, Xenova export)
# - SHA-256 verified
# - Atomic writes (no corrupt half-downloads surviving)
# - Retrying, idempotent
#
# Run:
# powershell -ExecutionPolicy Bypass -File scripts\setup-onnx.ps1
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

# Anchor to repo root (script lives in scripts/)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

if ($env:CF_MODEL_DIR) {
    $ModelsDir = $env:CF_MODEL_DIR
}
else {
    $ModelsDir = Join-Path $RepoRoot "contextforge_models"
}

$ModelUrl = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx"
$TokenizerUrl = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json"

$ModelFile = Join-Path $ModelsDir "all-MiniLM-L6-v2-int8.onnx"
$TokenizerFile = Join-Path $ModelsDir "tokenizer.json"

$ModelSha256 = "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"
$TokenizerSha256 = "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  ContextForge — ONNX Model Setup" -ForegroundColor Cyan
Write-Host "  → $ModelsDir" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host ""

New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

function Get-FileSha256 {
    param([string]$Path)
    (Get-FileHash -Algorithm SHA256 $Path).Hash.ToLower()
}

function Download-WithRetry {
    param(
        [string]$Url,
        [string]$OutFile,
        [int]$Retries = 3
    )

    for ($i = 1; $i -le $Retries; $i++) {
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest `
                -Uri $Url `
                -OutFile $OutFile `
                -MaximumRedirection 5 `
                -UseBasicParsing

            return
        }
        catch {
            if ($i -eq $Retries) {
                throw
            }

            Start-Sleep -Seconds 2
        }
    }
}

function Fetch {
    param(
        [string]$Url,
        [string]$Destination,
        [string]$ExpectedHash,
        [string]$Label
    )

    $Tmp = "$Destination.tmp"

    if (Test-Path $Destination) {
        $ExistingHash = Get-FileSha256 $Destination

        if ($ExistingHash -eq $ExpectedHash) {
            Write-Host "  ✅ $Label already exists (verified) — skipping" -ForegroundColor Green
            return
        }

        Write-Host "  ⚠️  $Label exists but checksum mismatch — re-downloading" -ForegroundColor Yellow
        Remove-Item $Destination -Force
    }

    Write-Host "  ⬇️  Downloading $Label..." -ForegroundColor Yellow

    Download-WithRetry $Url $Tmp

    $DownloadedHash = Get-FileSha256 $Tmp

    if ($DownloadedHash -ne $ExpectedHash) {
        Remove-Item $Tmp -Force -ErrorAction SilentlyContinue

        Write-Host "  ❌ ERROR: $Label checksum mismatch" -ForegroundColor Red
        Write-Host "     expected: $ExpectedHash"
        Write-Host "     got:      $DownloadedHash"

        exit 1
    }

    Move-Item $Tmp $Destination -Force

    Write-Host "  ✅ $Label downloaded & verified" -ForegroundColor Green
}

Fetch `
    $ModelUrl `
    $ModelFile `
    $ModelSha256 `
    "ONNX model (int8, ~23MB)"

Fetch `
    $TokenizerUrl `
    $TokenizerFile `
    $TokenizerSha256 `
    "tokenizer.json (~700KB)"

Write-Host ""
Write-Host "  🎉 ONNX setup complete!" -ForegroundColor Green
Write-Host ""