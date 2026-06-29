/**
 * contextforge wrap <agent>
 *
 * Starts the ContextForge proxy, indexes the workspace,
 * then launches the requested agent with the proxy pre-configured.
 * The user types one command. Everything else is handled here.
 */

import { spawn, execSync } from "node:child_process";
import { existsSync }      from "node:fs";
import path                from "node:path";
import os                  from "node:os";
import ora                 from "ora";         // spinner
import chalk               from "chalk";       // color

// Supported agents and how to launch them with the proxy injected
const AGENTS = {
  claude: {
    detect:  () => commandExists("claude"),
    launch:  (port) => ({
      cmd:  "claude",
      args: [],
      env:  {
        ANTHROPIC_BASE_URL: `http://localhost:${port}`,
        ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY || "proxied-by-contextforge",
      },
    }),
    hint: "Install Claude Code: https://claude.ai/code",
  },


  cursor: {
    detect:  () => true, // Cursor is a GUI app — we just print settings
    launch:  null,       // Cannot be launched programmatically
    manual:  (port) => [
      "",
      chalk.yellow("  Cursor requires manual proxy configuration:"),
      "",
      `  1. Open Cursor → Settings → Models`,
      `  2. Set Base URL to:  ${chalk.cyan(`http://localhost:${port}`)}`,
      `  3. Set API Key to:   ${chalk.cyan("your-real-key")}`,
      `  4. Restart Cursor`,
      "",
    ],
  },
};

// ─────────────────────────────────────────────
// Main wrap command
// ─────────────────────────────────────────────

export async function wrap(agent, options) {
  const { port, workspace } = options;
  const agentKey = agent.toLowerCase();

  console.log("");
  console.log(chalk.bold("  ContextForge"));
  console.log(chalk.dim("  Repository-aware execution runtime for AI coding agents"));
  console.log("");

  // ── Validate agent ───────────────────────────────────────────────
  if (!AGENTS[agentKey]) {
    console.error(chalk.red(`  ✗ Unknown agent: "${agent}"`));
    console.error(`    Supported: ${Object.keys(AGENTS).join(", ")}`);
    process.exit(1);
  }

  const agentConfig = AGENTS[agentKey];

  // ── Detect workspace ─────────────────────────────────────────────
  const spinner = ora({ text: "Detecting repository...", indent: 2 }).start();
  const workspacePath = path.resolve(workspace);

  if (!existsSync(workspacePath)) {
    spinner.fail(`Workspace not found: ${workspacePath}`);
    process.exit(1);
  }

  const isGitRepo = existsSync(path.join(workspacePath, ".git"));
  spinner.succeed(
    `Repository detected  ${chalk.dim(workspacePath)}` +
    (isGitRepo ? chalk.dim("  (git)") : "")
  );

  // ── Check agent is installed ─────────────────────────────────────
  if (!agentConfig.detect()) {
    console.error("");
    console.error(chalk.red(`  ✗ ${agent} not found on your PATH`));
    console.error(`    ${agentConfig.hint}`);
    console.error("");
    process.exit(1);
  }

  // ── Start proxy ──────────────────────────────────────────────────
  const proxySpinner = ora({ text: "Starting proxy...", indent: 2 }).start();

  const proxyProcess = await startProxy({ port, workspace: workspacePath });

  // Wait for the proxy to be ready (polls /healthz)
  const ready = await waitForProxy(port, 15_000);

  if (!ready) {
    proxySpinner.fail("Proxy failed to start within 15 seconds");
    console.error("");
    console.error("  Run `contextforge doctor` to diagnose the issue.");
    console.error("");
    process.exit(1);
  }

  proxySpinner.succeed(`Proxy listening on ${chalk.cyan(`http://localhost:${port}`)}`);

  // ── Index workspace ──────────────────────────────────────────────
  const graphSpinner = ora({ text: "Indexing repository graph...", indent: 2 }).start();

  try {
    const stats = await pollGraphReady(port, 30_000);
    graphSpinner.succeed(
      `Repository graph ready  ` +
      chalk.dim(`${stats.nodes.toLocaleString()} symbols · ${stats.files} files`)
    );
  } catch {
    graphSpinner.warn("Graph indexing timed out — will complete in background");
  }

  // ── Dashboard ────────────────────────────────────────────────────
  ora({ indent: 2 })
    .succeed(`Dashboard → ${chalk.cyan(`http://localhost:${port}/dashboard`)}`);

  // ── Launch agent or print manual instructions ────────────────────
  console.log("");

  if (agentConfig.manual) {
    // Cursor-style: print instructions
    agentConfig.manual(port).forEach((line) => console.log(line));
    console.log(
      chalk.bold("  ContextForge is running.") +
      "  Press Ctrl+C to stop."
    );
    handleShutdown(proxyProcess);
    return;
  }

  // All other agents: launch directly
  const { cmd, args, env } = agentConfig.launch(port);

  console.log(
    `  ${chalk.bold(chalk.green("✓"))} Launching ${chalk.bold(agent)} through ContextForge...`
  );
  console.log("");
  console.log(chalk.dim("─".repeat(54)));
  console.log("");

  const agentProcess = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: false,
  });

  // When the agent exits, shut down the proxy cleanly
  agentProcess.on("exit", (code) => {
    console.log("");
    console.log(chalk.dim("  Agent exited — shutting down ContextForge proxy..."));
    proxyProcess.kill("SIGTERM");
    process.exit(code ?? 0);
  });

  handleShutdown(proxyProcess, agentProcess);
}

// ─────────────────────────────────────────────
// Helpers
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

async function startProxy({ port, workspace }) {
  const serverPath = new URL("../../src/server.js", import.meta.url).pathname;

  const proc = spawn("node", [serverPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CF_PORT:           String(port),
      CF_WORKSPACE_PATH: workspace,
      NODE_ENV:          "production",
    },
    detached: false,
  });

  // Surface proxy errors without overwhelming the terminal
  proc.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg.includes("ERROR") || msg.includes("FATAL")) {
      console.error(chalk.red(`\n  Proxy error: ${msg}`));
    }
  });

  return proc;
}

async function waitForProxy(port, timeoutMs) {
  const start = Date.now();
  const url   = `http://localhost:${port}/healthz`;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // Not ready yet — keep polling
    }
    await sleep(300);
  }
  return false;
}

async function pollGraphReady(port, timeoutMs) {
  const start = Date.now();
  const url   = `http://localhost:${port}/v1/graph/stats`;

  while (Date.now() - start < timeoutMs) {
    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const data = await res.json();
      if (data.ready) return data;
    } catch {
      // Not ready yet
    }
    await sleep(500);
  }
  throw new Error("Graph indexing timed out");
}

function handleShutdown(proxyProcess, agentProcess) {
  process.on("SIGINT",  () => shutdown(proxyProcess, agentProcess));
  process.on("SIGTERM", () => shutdown(proxyProcess, agentProcess));
}

function shutdown(proxyProcess, agentProcess) {
  console.log("");
  console.log(chalk.dim("  Shutting down ContextForge..."));
  agentProcess?.kill("SIGTERM");
  proxyProcess?.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}