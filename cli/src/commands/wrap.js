/**
 * cf wrap <agent> [-- args...] — the flagship flow.
 *
 *   1. Environment check (models present? native ok?) — auto-runs setup-lite
 *   2. Ensure proxy (reuse if healthy + same workspace, else start)
 *   3. Snapshot savings counters
 *   4. Launch agent with proxy env + MCP config, full TTY passthrough
 *   5. On exit: savings summary, teardown (unless --keep-alive or reused)
 *   6. Exit with the agent's own exit code
 */

import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { resolveConfig } from "../core/config.js";
import { resolveWorkspace, modelsDir } from "../core/paths.js";
import { ensureProxy, stopProxy, fetchHealth } from "../core/daemon.js";
import { resolveAgent, buildSpawn } from "../core/agents.js";
import { modelStatus, ensureModels } from "../core/assets.js";
import { diagnoseNative } from "../core/native.js";
import { ok, fail, warn, info, dim, bold, cyan, progressBar } from "../ui/output.js";
import { CFError } from "../ui/errors.js";
import { ensureFirstRunSetup } from "./setup.js";

// ── Environment gate (fast path <100ms when everything is in place) ──────────

async function ensureEnvironment() {
  const native = diagnoseNative();
  if (!native.ok) {
    // Internal escape hatch (tests / passthrough-only setups where the
    // server build genuinely doesn't need the embedder).
    if (process.env.CF_SKIP_NATIVE_CHECK === "1") {
      warn("Native addon check skipped (CF_SKIP_NATIVE_CHECK=1)");
    } else {
      throw new CFError("CF_ERR_NATIVE_LOAD", native.error, native.hint);
    }
  }

  const models = await modelStatus();
  if (models.some((m) => !m.ok)) {
    warn("Models missing or invalid — downloading now (first run)");
    let bar = null;
    await ensureModels({
      onEvent: (ev) => {
        if (ev.type === "start") bar = progressBar(ev.asset.name);
        else if (ev.type === "progress") bar?.update(ev.received, ev.total);
        else if (ev.type === "done") { bar?.finish(`${ev.asset.label} ready`); bar = null; }
      },
    });
  }
  ok(`Environment OK ${dim(`(native: ${native.kind ?? "skipped"}, models verified)`)}`);
}

// ── Savings summary ───────────────────────────────────────────────────────────

async function fetchSavings(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/savings`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const snap = await res.json();
    return snap?.lifetime ?? null;
  } catch {
    return null;
  }
}

function printSavingsSummary(before, after) {
  if (!before || !after) return;
  const d = (k) => (after[k] ?? 0) - (before[k] ?? 0);
  const requests = d("requests");
  if (requests <= 0) { info(dim("No requests went through the proxy this session")); return; }

  const tokensBefore = d("tokens_before");
  const saved = d("tokens_saved");
  const pct = tokensBefore > 0 ? ((saved / tokensBefore) * 100).toFixed(1) : "0.0";

  console.log("");
  if (saved >= 0) {
    ok(bold(`Session: ${requests} requests · ${tokensBefore.toLocaleString()} tokens in → ` +
      `${(tokensBefore - saved).toLocaleString()} sent · ${pct}% saved (est)`));
  } else {
    // savingsTracker ST-1: negative = multi-hop ghost interceptor overhead
    info(`Session: ${requests} requests · ${Math.abs(saved).toLocaleString()} extra tokens ` +
      dim("(multi-hop overhead — honest accounting, see savings tracker)"));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function wrap(agentName, opts = {}, command) {
  // Pass-through args after `--`: cf wrap claude -- --continue
  const passArgs = (command?.args?.slice(1) ?? []).filter((a, i) => !(i === 0 && a === "--"));

  const agent = resolveAgent(agentName);
  const workspace = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspace();

  console.log("");
  await ensureFirstRunSetup(); // first `cf wrap` ever → provider wizard runs here
  const { values } = resolveConfig({ workspace, flags: opts });

  await ensureEnvironment();

  // ── Proxy ──
  let lastPhase = "";
  const { runfile, reused } = await ensureProxy({
    configValues: values,
    workspace,
    restart: !!opts.restart,
    onProgress: (ev) => {
      if (!process.stdout.isTTY) return;
      let line = "";
      if (ev.phase === "starting") line = "starting proxy…";
      else if (ev.phase === "indexing") line = `indexing ${path.basename(workspace)} … ${ev.current ?? 0}/${ev.total ?? "?"} files`;
      else if (ev.phase === "restarting") line = `restarting proxy (${ev.reason})…`;
      else if (ev.phase === "ready") { process.stdout.write("\r\x1b[2K"); return; }
      if (line !== lastPhase) { process.stdout.write(`\r\x1b[2K  ${dim("⠿")} ${line}`); lastPhase = line; }
    },
  });

  const port = runfile.port;
  const health = await fetchHealth(port);
  if (reused) ok(`Reusing proxy on :${port} ${dim(`(pid ${runfile.pid})`)}`);
  else ok(`Proxy started on :${port} ${dim(`(pid ${runfile.pid}, ${health?.indexedFiles ?? "?"} files indexed)`)}`);
  info(`upstream ${values["provider.name"]} · dashboard ${cyan(`http://localhost:${port}/dashboard`)}`);

  // ── Launch agent ──
  const prep = agent.prepare({ port });
  ok(`Launching ${bold(agentName)} ${dim(`(ANTHROPIC_BASE_URL=http://127.0.0.1:${port}` +
    `${prep.mcpRegistered ? ", MCP tools registered" : ""})`)}`);
  console.log("");

  const savingsBefore = await fetchSavings(port);

  // Windows: .cmd shims must go through cmd.exe; sh-shims are never picked
  // (findBinary prefers .exe/.cmd). Unix: direct spawn.
  const sp = buildSpawn(agent.bin, [...prep.args, ...passArgs]);
  const child = spawn(sp.command, sp.args, {
    stdio: "inherit",
    env: { ...process.env, ...prep.env },
    ...sp.options,
  });

  // Forward signals; the agent owns the TTY, we just relay and wait.
  const forward = (sig) => () => { try { child.kill(sig); } catch { /* gone */ } };
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve(signal ? 130 : (code ?? 0)));
    child.on("error", (err) => {
      fail(`Failed to launch ${agentName}: ${err.message}`);
      resolve(1);
    });
  });

  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);

  // ── Teardown & summary ──
  console.log("");
  const savingsAfter = await fetchSavings(port);
  printSavingsSummary(savingsBefore, savingsAfter);

  for (const f of prep.cleanupFiles) { try { unlinkSync(f); } catch { /* tmp */ } }

  // Only stop a proxy WE started this session. Reused/pre-existing stays up.
  if (!reused && !opts.keepAlive) {
    const r = await stopProxy(runfile);
    if (r.stopped) ok("Proxy stopped");
  } else if (reused) {
    info(dim(`Proxy left running on :${port} (was already up — use \`cf stop\` to stop it)`));
  } else {
    info(dim(`Proxy kept alive on :${port} (--keep-alive)`));
  }
  console.log("");

  process.exit(exitCode);
}
