/**
 * cf start / stop / status — thin shells over core/daemon.js
 */

import path from "node:path";
import { resolveConfig } from "../core/config.js";
import { resolveWorkspace } from "../core/paths.js";
import { ensureProxy, stopProxy, stopAll, findRunningProxy, readRunfiles, pidAlive, fetchHealth } from "../core/daemon.js";
import { header, ok, fail, warn, info, dim, bold, cyan } from "../ui/output.js";
import { EXIT } from "../ui/errors.js";

function progressReporter() {
  let lastLine = "";
  return (ev) => {
    if (!process.stdout.isTTY) return;
    let line = "";
    if (ev.phase === "starting") line = "starting proxy…";
    else if (ev.phase === "indexing") line = `indexing workspace… ${ev.current ?? 0}/${ev.total ?? "?"} files`;
    else if (ev.phase === "restarting") line = `restarting proxy (${ev.reason})…`;
    else if (ev.phase === "ready") { process.stdout.write("\r\x1b[2K"); return; }
    if (line && line !== lastLine) {
      process.stdout.write(`\r\x1b[2K  ${dim("⠿")} ${line}`);
      lastLine = line;
    }
  };
}

export async function start(opts = {}) {
  const { ensureFirstRunSetup } = await import("./setup.js");
  await ensureFirstRunSetup(); // first run → provider wizard
  const workspace = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspace();
  const { values } = resolveConfig({ workspace, flags: opts });

  header("ContextForge Proxy");
  const { runfile, reused } = await ensureProxy({
    configValues: values,
    workspace,
    restart: !!opts.restart,
    onProgress: progressReporter(),
  });

  if (reused) ok(`Reusing healthy proxy on :${runfile.port} ${dim(`(pid ${runfile.pid})`)}`);
  else ok(`Proxy started on :${runfile.port} ${dim(`(pid ${runfile.pid})`)}`);
  info(`workspace  ${workspace}`);
  info(`provider   ${values["provider.name"]} · mode ${values["proxy.mode"]}`);
  info(`dashboard  ${cyan(`http://localhost:${runfile.port}/dashboard`)}`);
  info(`logs       cf logs ${dim(`(${runfile.logFile ?? "n/a"})`)}`);
  console.log("");
}

export async function stop(opts = {}) {
  if (opts.all) {
    const results = await stopAll();
    if (!results.length) { warn("No managed proxies running"); return; }
    for (const r of results) {
      if (r.stopped) ok(`Stopped proxy on :${r.port}${r.forced ? " (forced)" : ""}`);
      else info(`Proxy on :${r.port} was already gone — cleaned runfile`);
    }
    return;
  }

  const running = await findRunningProxy();
  if (!running) { warn("No managed proxy running"); return; }
  const r = await stopProxy(running);
  if (r.stopped) ok(`Stopped proxy on :${running.port}${r.forced ? " (forced after grace period)" : " (graceful)"}`);
  else info("Proxy was already gone — cleaned runfile");
}

export async function restart() {
  const running = await findRunningProxy();
  if (!running) { warn("No managed proxy running — starting fresh with defaults"); }
  const workspace = running?.health?.workspace ?? running?.workspace ?? resolveWorkspace();
  const { values } = resolveConfig({ workspace });
  // Preserve the previous port even if it was auto-picked.
  if (running?.port) values["proxy.port"] = running.port;

  header("ContextForge Proxy");
  const { runfile } = await ensureProxy({
    configValues: values, workspace, restart: true, onProgress: progressReporter(),
  });
  ok(`Proxy restarted on :${runfile.port} ${dim(`(pid ${runfile.pid})`)}`);
  console.log("");
}

export async function status(opts = {}) {
  const entries = [];
  for (const rf of readRunfiles()) {
    const alive = rf.pid && pidAlive(rf.pid);
    const health = alive ? await fetchHealth(rf.port) : null;
    entries.push({ ...rf, alive, health });
  }

  if (opts.json) {
    console.log(JSON.stringify({ proxies: entries }, null, 2));
    process.exitCode = entries.some((e) => e.alive) ? EXIT.OK : EXIT.ERROR;
    return;
  }

  header("ContextForge Status");
  if (!entries.length) {
    info("No managed proxies. Start one: `cf start` or `cf wrap claude`");
    console.log("");
    return;
  }

  for (const e of entries) {
    if (!e.alive) { fail(`:${e.port}  dead (stale runfile — run \`cf doctor --fix\`)`); continue; }
    if (!e.health) { warn(`:${e.port}  pid ${e.pid} alive but /healthz unreachable (still starting? check cf logs)`); continue; }
    const up = e.health.uptimeMs ? `${Math.round(e.health.uptimeMs / 60000)}m` : "?";
    ok(`:${e.port}  ${bold(e.health.status)}  pid ${e.pid}  up ${up}`);
    info(`  workspace ${e.health.workspace ?? e.workspace}`);
    info(`  provider ${e.provider} · indexed ${e.health.indexedFiles ?? "?"} files · v${e.health.version ?? "?"}`);
  }
  console.log("");
}
