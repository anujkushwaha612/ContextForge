#!/usr/bin/env node
/**
 * postinstall.js
 *
 * Runs automatically after `npm install`.
 * Handles the full setup sequence:
 *   1. Detect environment (CI, Docker, user machine)
 *   2. Try to load prebuilt native binary
 *   3. If no prebuilt exists, attempt node-gyp compile
 *   4. If compile fails, print friendly error with fix instructions
 *   5. Download ONNX model and tokenizer if missing
 *
 * Exit codes:
 *   0 — success or graceful skip
 *   1 — hard failure (native module broken, cannot start)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const log  = (msg) => console.log(`  ${msg}`);
const ok   = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.warn(`  ⚠️  ${msg}`);
const err  = (msg) => console.error(`  ❌ ${msg}`);
const sep  = ()    => console.log("━".repeat(54));

function hasCommand(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isCI() {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.TRAVIS ||
    process.env.CIRCLECI
  );
}

function isDocker() {
  return existsSync("/.dockerenv");
}

// ─────────────────────────────────────────────
// Step 1: Check native binary
// ─────────────────────────────────────────────

function checkNativeBinary() {
  log("");
  sep();
  log("ContextForge — Post-Install Setup");
  sep();
  log("");

  const nativePath = path.join(ROOT, "native", "build", "Release", "contextforge_native.node");

  // Try prebuilt first (node-gyp-build handles this automatically)
  try {
    require(path.join(ROOT, "native", "build", "Release", "contextforge_native.node"));
    ok("Native module loaded from existing build");
    return true;
  } catch {
    // No prebuilt or existing build — try to compile
  }

  log("Native module not found — attempting to compile...");
  log(`  Platform: ${os.platform()} ${os.arch()}`);
  log(`  Node.js:  ${process.version}`);
  log("");

  // Check prerequisites
  const hasPython = hasCommand("python3") || hasCommand("python");
  const hasMake   = hasCommand("make") || hasCommand("nmake");
  const hasGcc    = hasCommand("g++") || hasCommand("cl");

  if (!hasPython) {
    err("Python 3 not found");
    log("     Install from: https://www.python.org/downloads/");
  }
  if (!hasMake) {
    err("Make/NMAKE not found");
    if (os.platform() === "win32") {
      log("     Install: npm install -g windows-build-tools");
      log("     Or: Visual Studio Build Tools → C++ Desktop Workload");
    } else {
      log("     Linux: sudo apt-get install build-essential");
      log("     Mac: xcode-select --install");
    }
  }
  if (!hasGcc) {
    err("C++ compiler not found");
  }

  if (!hasPython || !hasMake || !hasGcc) {
    log("");
    warn("Missing build prerequisites. ContextForge has two alternatives:");
    log("");
    log("  🐳 OPTION A — Docker (no compiler needed, recommended):");
    log("     docker compose up -d");
    log("");
    log("  📦 OPTION B — Install build tools then retry:");
    if (os.platform() === "win32") {
      log("     npm install --global windows-build-tools");
    } else if (os.platform() === "darwin") {
      log("     xcode-select --install");
    } else {
      log("     sudo apt-get install build-essential python3 cmake");
    }
    log("     npm install");
    log("");
    log("  📖 Full guide: https://github.com/your-org/contextforge#installation");
    log("");

    // Non-zero exit fails npm install — we exit 0 so the partial install
    // still works and the user sees the helpful message
    return false;
  }

  // All prerequisites found — attempt compile
  log("  All build tools found — compiling native module...");
  log("  (This takes 30-90 seconds on first install)");
  log("");

  const result = spawnSync("npx", ["node-gyp", "rebuild"], {
    cwd: path.join(ROOT, "native"),
    stdio: "inherit",
    shell: true
  });

  if (result.status === 0) {
    ok("Native module compiled successfully");
    return true;
  } else {
    err("Native module compilation failed");
    log("");
    log("  The C++ compilation step failed. Possible causes:");
    log("  1. Incompatible compiler version");
    log("  2. Missing ONNX Runtime development headers");
    log("  3. CMake version too old");
    log("");
    log("  Try the Docker path instead:");
    log("  docker compose up -d");
    log("");
    return false;
  }
}

// ─────────────────────────────────────────────
// Step 2: Download ONNX model if missing
// ─────────────────────────────────────────────

async function ensureOnnxModel() {
  const modelsDir = path.join(ROOT, "contextforge_models");
  const modelFile = path.join(modelsDir, "all-MiniLM-L6-v2-int8.onnx");
  const tokenizerFile = path.join(modelsDir, "tokenizer.json");

  mkdirSync(modelsDir, { recursive: true });

  const modelExists     = existsSync(modelFile);
  const tokenizerExists = existsSync(tokenizerFile);

  if (modelExists && tokenizerExists) {
    ok("ONNX model and tokenizer already present");
    return;
  }

  log("Downloading ONNX embedding model...");

  // Use the platform-appropriate script
  if (os.platform() === "win32") {
    const result = spawnSync("powershell", [
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(ROOT, "scripts", "setup-onnx.ps1")
    ], { stdio: "inherit", shell: true });
    if (result.status !== 0) {
      warn("Model download failed — you can retry with: npm run setup:contextforge_models");
    }
  } else {
    const result = spawnSync("bash", [
      path.join(ROOT, "scripts", "setup-onnx.sh")
    ], { stdio: "inherit" });
    if (result.status !== 0) {
      warn("Model download failed — you can retry with: npm run setup:contextforge_models");
    }
  }
}

// ─────────────────────────────────────────────
// Step 3: Create .env from example if missing
// ─────────────────────────────────────────────

function ensureEnvFile() {
  const envFile    = path.join(ROOT, ".env");
  const envExample = path.join(ROOT, ".env.example");

  if (existsSync(envFile)) {
    ok(".env file already exists");
    return;
  }

  if (!existsSync(envExample)) {
    warn(".env.example not found — skipping .env creation");
    return;
  }

  try {
    copyFileSync(envExample, envFile);
    ok(".env created from .env.example");
    warn("Edit .env and add your API keys before starting");
  } catch {
    warn("Could not create .env — copy .env.example manually");
  }
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  // Skip heavy setup in CI — CI builds the native module explicitly
  if (isCI() && !isDocker()) {
    log("CI environment detected — skipping postinstall setup");
    log("CI should run: npm run build:native && npm run setup:contextforge_models");
    process.exit(0);
  }

  const nativeOk = checkNativeBinary();
  await ensureOnnxModel();
  await ensureEnvFile();

  log("");
  sep();

  if (nativeOk) {
    ok("ContextForge is ready to start!");
    log("");
    log("  Quick start:");
    log("    npm start                 — start the proxy");
    log("    open http://localhost:3000/dashboard");
    log("");
    log("  With Claude Code:");
    log("    export ANTHROPIC_BASE_URL=http://localhost:3000");
    log("    export ANTHROPIC_API_KEY=any-value");
    log("    claude");
  } else {
    warn("Setup incomplete — native module not compiled");
    log("");
    log("  Fastest path to get running:");
    log("    docker compose up -d");
    log("    open http://localhost:3000/dashboard");
  }

  sep();
  log("");

  process.exit(0);
}

main().catch((e) => {
  console.error("Postinstall error:", e.message);
  process.exit(0); // Always exit 0 — never block npm install
});