/**
 * contextforge doctor
 *
 * Checks every dependency and configuration value that ContextForge needs.
 * Prints a clear pass/fail/warn for each check.
 * Always exits 0 — this is a diagnostic tool, not a gatekeeper.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync }          from "node:fs";
import path                    from "node:path";
import os                      from "node:os";
import chalk                   from "chalk";

const PASS = chalk.green("  ✓");
const FAIL = chalk.red("  ✗");
const WARN = chalk.yellow("  ⚠");

export async function doctor() {
  console.log("");
  console.log(chalk.bold("  contextforge doctor"));
  console.log(chalk.dim("  Checking your environment..."));
  console.log("");

  const results = [];

  // ── Node.js version ──────────────────────────────────────────────
  const nodeVersion = process.version;
  const nodeMajor   = parseInt(nodeVersion.slice(1));
  results.push(
    nodeMajor >= 20
      ? { icon: PASS, label: `Node.js ${nodeVersion}` }
      : { icon: FAIL, label: `Node.js ${nodeVersion} — requires ≥ 20`, fix: "https://nodejs.org/" }
  );

  // ── Native runtime ───────────────────────────────────────────────
  try {
    const nativePath = new URL("../../native/build/Release/contextforge_native.node", import.meta.url).pathname;
    await import(nativePath);
    results.push({ icon: PASS, label: "Native runtime (C++ module)" });
  } catch {
    results.push({
      icon: FAIL,
      label: "Native runtime not compiled",
      fix:  "npm run rebuild  —or—  docker compose up -d",
    });
  }

  // ── ONNX model ───────────────────────────────────────────────────
  const modelPath = new URL("../../models/all-MiniLM-L6-v2-int8.onnx", import.meta.url).pathname;
  results.push(
    existsSync(modelPath)
      ? { icon: PASS, label: "ONNX embedding model" }
      : { icon: WARN, label: "ONNX model missing", fix: "npm run setup:models" }
  );

  // ── Tree-sitter grammars ─────────────────────────────────────────
  const vendorPath = new URL("../../vendor", import.meta.url).pathname;
  results.push(
    existsSync(vendorPath)
      ? { icon: PASS, label: "Tree-sitter grammars" }
      : { icon: WARN, label: "Tree-sitter grammars missing", fix: "npm run setup:grammars" }
  );

  // ── .env file ────────────────────────────────────────────────────
  const envPath = new URL("../../.env", import.meta.url).pathname;
  results.push(
    existsSync(envPath)
      ? { icon: PASS, label: ".env configured" }
      : { icon: WARN, label: ".env not found", fix: "cp .env.example .env" }
  );

  // ── Provider configured ──────────────────────────────────────────
  const provider = process.env.CF_PROVIDER;
  const keyMap   = {
    openai:    "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    groq:      "GROQ_API_KEY",
    gemini:    "GEMINI_API_KEY",
    ollama:    null, // no key needed
  };

  if (!provider) {
    results.push({ icon: WARN, label: "CF_PROVIDER not set (will default to ollama)" });
  } else {
    const requiredKey = keyMap[provider];
    if (requiredKey && !process.env[requiredKey]) {
      results.push({
        icon: WARN,
        label: `Provider: ${provider} — ${requiredKey} not set`,
        fix:  `Add ${requiredKey}=your-key to .env`,
      });
    } else {
      results.push({ icon: PASS, label: `Provider: ${provider || "ollama (default)"}` });
    }
  }

  // ── Proxy reachable (if running) ─────────────────────────────────
  const port = process.env.CF_PORT || "3000";
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    results.push(
      res.ok
        ? { icon: PASS, label: `Proxy running on port ${port}` }
        : { icon: WARN, label: `Proxy on port ${port} returned ${res.status}` }
    );

    // If proxy is up, also check graph
    try {
      const graphRes  = await fetch(`http://localhost:${port}/v1/graph/stats`, {
        signal: AbortSignal.timeout(1500),
      });
      const graphData = await graphRes.json();
      results.push(
        graphData.ready
          ? {
              icon: PASS,
              label: `Repository graph ready  ${chalk.dim(`${graphData.nodes?.toLocaleString() ?? "?"} symbols`)}`,
            }
          : { icon: WARN, label: "Repository graph still indexing..." }
      );
    } catch {
      results.push({ icon: WARN, label: "Could not reach graph stats endpoint" });
    }

    // Dashboard
    results.push({ icon: PASS, label: `Dashboard → http://localhost:${port}/dashboard` });

  } catch {
    results.push({ icon: WARN, label: `Proxy not running on port ${port}  (start with: contextforge wrap claude)` });
  }

  // ── Workspace ────────────────────────────────────────────────────
  const workspace = process.env.CF_WORKSPACE_PATH || process.cwd();
  const isGit     = existsSync(path.join(workspace, ".git"));
  results.push({
    icon:  PASS,
    label: `Workspace: ${workspace}` + (isGit ? chalk.dim("  (git repo)") : ""),
  });

  // ── Agents detected on PATH ──────────────────────────────────────
  const agents = {
    claude: "Claude Code",
  };

  for (const [cmd, name] of Object.entries(agents)) {
    const found = commandExists(cmd);
    results.push({
      icon:  found ? PASS : WARN,
      label: found ? `${name} found on PATH` : `${name} not found  (optional)`,
    });
  }

  // ── Print results ────────────────────────────────────────────────
  for (const { icon, label, fix } of results) {
    console.log(`${icon}  ${label}`);
    if (fix) {
      console.log(`       ${chalk.dim("→")} ${chalk.dim(fix)}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  const failures = results.filter((r) => r.icon === FAIL).length;
  const warnings = results.filter((r) => r.icon === WARN).length;

  console.log("");

  if (failures === 0 && warnings === 0) {
    console.log(chalk.green("  Everything looks good. Run: contextforge wrap claude"));
  } else if (failures === 0) {
    console.log(chalk.yellow(`  ${warnings} warning${warnings > 1 ? "s" : ""} — ContextForge may still work.`));
    console.log(chalk.yellow("  Fix warnings above for best results."));
  } else {
    console.log(chalk.red(`  ${failures} error${failures > 1 ? "s" : ""} found — fix these before starting.`));
  }

  console.log("");
}

// ─────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────

function commandExists(cmd) {
  try {
    execSync(
      os.platform() === "win32" ? `where ${cmd}` : `which ${cmd}`,
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}