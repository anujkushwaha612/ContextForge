/**
 * core/daemon.js
 *
 * Proxy lifecycle: spawn server.js detached, health-gate on /healthz,
 * runfiles in ~/.contextforge/run/, reuse detection, graceful stop.
 *
 * Runfile schema (~/.contextforge/run/proxy-<port>.json):
 *   { pid, port, workspace, provider, mode, managed, version, startedAt, logFile, errFile }
 */

import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runDir, runfilePath, logsDir, modelsDir, workspaceDataDir, ensureLayout } from "./paths.js";
import { toEnv } from "./config.js";
import { repoRoot } from "./native.js";
import { CFError } from "../ui/errors.js";

const HEALTH_TIMEOUT_MS = 120_000; // indexing large repos takes time
const STOP_GRACE_MS = 7_000;       // server drains for 5s; give it 7

// ── Runfile helpers ───────────────────────────────────────────────────────────

export function readRunfiles() {
  const out = [];
  try {
    for (const f of readdirSync(runDir())) {
      if (!f.startsWith("proxy-") || !f.endsWith(".json")) continue;
      try {
        out.push({ file: path.join(runDir(), f), ...JSON.parse(readFileSync(path.join(runDir(), f), "utf8")) });
      } catch { /* corrupt runfile — doctor cleans these */ }
    }
  } catch { /* no run dir yet */ }
  return out;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cleanRunfile(rf) {
  try { unlinkSync(rf.file ?? runfilePath(rf.port)); } catch { /* already gone */ }
}

// ── Health ────────────────────────────────────────────────────────────────────

export async function fetchHealth(port, timeoutMs = 2_500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Find a live, managed proxy. Cleans stale runfiles as a side effect. */
export async function findRunningProxy() {
  for (const rf of readRunfiles()) {
    if (!rf.pid || !pidAlive(rf.pid)) { cleanRunfile(rf); continue; }
    const health = await fetchHealth(rf.port);
    if (health) return { ...rf, health };
    // pid alive but no health — could be still indexing; report it anyway
    return { ...rf, health: null };
  }
  return null;
}

// ── Start ─────────────────────────────────────────────────────────────────────

function serverEntrypoint() {
  const root = repoRoot();
  const candidates = [path.join(root, "src", "server.js"), path.join(root, "server.js")];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new CFError("CF_ERR_PROXY_START",
      `Cannot locate server.js (searched: ${candidates.join(", ")})`,
      "Set CF_REPO_ROOT to your ContextForge checkout, or reinstall the package.");
  }
  return found;
}

/**
 * Parse `CF_LISTENING port=NNNN pid=NNNN` from the log file (needed for
 * port 0 — the server prints this as soon as the socket is bound, before
 * indexing, so progress polling works even with an OS-assigned port).
 */
function parseListeningLine(logFile) {
  try {
    const m = readFileSync(logFile, "utf8").match(/CF_(?:LISTENING|READY) port=(\d+) pid=(\d+)/);
    return m ? { port: Number(m[1]), pid: Number(m[2]) } : null;
  } catch { return null; }
}

function tailFile(file, lines = 20) {
  try { return readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-lines).join("\n"); }
  catch { return "(no log output)"; }
}

/**
 * Start the proxy daemon.
 * @param {object} p
 * @param {object} p.configValues   resolved config values
 * @param {string} p.workspace      absolute workspace path
 * @param {function} p.onProgress   ({phase, current, total}) → void
 * @returns {Promise<runfile>}
 */
export async function startProxy({ configValues, workspace, onProgress } = {}) {
  ensureLayout();
  const entry = serverEntrypoint();
  const requestedPort = configValues["proxy.port"];

  // Refuse to start on a port owned by an unmanaged process.
  if (requestedPort !== 0) {
    const existing = await fetchHealth(requestedPort);
    if (existing) {
      const managed = readRunfiles().some((rf) => rf.port === requestedPort && pidAlive(rf.pid));
      throw new CFError("CF_ERR_PORT_CONFLICT",
        managed
          ? `A managed proxy is already running on port ${requestedPort}`
          : `Port ${requestedPort} is in use by another ContextForge-like process`,
        managed ? "Use `cf stop` first, or `--restart`." : "Pick another port: `cf start --port 0` (auto).");
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const loggingEnabled = !!configValues["logging.file"];
  const logFile = loggingEnabled ? path.join(logsDir(), `proxy-${stamp}.log`) : null;
  const errFile = loggingEnabled ? path.join(logsDir(), `proxy-${stamp}.err.log`) : null;
  const portFile = (!loggingEnabled && requestedPort === 0) ? path.join(runDir(), `port-${stamp}.txt`) : null;

  const dataDir = workspaceDataDir(workspace);
  const env = {
    ...process.env,
    ...toEnv(configValues, {
      workspace,
      modelDir: modelsDir(),
      dataDir,
    }),
    CF_PORT: String(requestedPort),
    // savingsTracker defaults to $CWD/CF-savings/ — keep state per-workspace
    // in ~/.contextforge/data/<hash>/ instead.
    CF_SAVINGS_PATH: path.join(dataDir, "proxy_savings.json"),
  };

  if (portFile) {
    env.CF_PORT_FILE = portFile;
  }

  const outStream = logFile ? openSync(logFile, "a") : "ignore";
  const errStream = errFile ? openSync(errFile, "a") : "ignore";

  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    env,
    detached: true,
    stdio: ["ignore", outStream, errStream],
  });
  child.unref();

  onProgress?.({ phase: "starting" });

  // ── Health-gate: poll until status ok, streaming indexing progress ──
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let port = requestedPort;

  while (Date.now() < deadline) {
    // Died early? Surface stderr instead of timing out silently.
    if (!pidAlive(child.pid)) {
      const errTail = errFile ? tailFile(errFile) : "(Logging disabled. Set logging.file = true in config to see errors.)";
      throw new CFError("CF_ERR_PROXY_START",
        `Proxy exited during startup. Last stderr:\n${errTail}`,
        errFile ? `Full logs: ${errFile}` : `Enable logs in config to see full output.`);
    }

    if (port === 0) {
      const sourceFile = logFile || portFile;
      if (sourceFile && existsSync(sourceFile)) {
        const listening = parseListeningLine(sourceFile);
        if (listening) port = listening.port;
      }
    }

    if (port !== 0) {
      const health = await fetchHealth(port);
      if (health) {
        if (health.status === "ok") {
          const runfile = {
            pid: child.pid, port, workspace,
            provider: configValues["provider.name"],
            mode: configValues["proxy.mode"],
            managed: true, version: health.version ?? "unknown",
            startedAt: new Date().toISOString(),
            logFile, errFile,
          };
          if (portFile) try { unlinkSync(portFile); } catch {}
          writeFileSync(runfilePath(port), JSON.stringify(runfile, null, 2));
          onProgress?.({ phase: "ready", port, indexedFiles: health.indexedFiles });
          return runfile;
        }
        onProgress?.({ phase: health.status, ...health.progress });
      }
    }
    await sleep(250);
  }

  // Timed out — kill the half-started proxy, don't leave an orphan.
  try { process.kill(child.pid, "SIGKILL"); } catch { /* already dead */ }
  if (portFile) try { unlinkSync(portFile); } catch {}
  throw new CFError("CF_ERR_PROXY_HEALTH",
    `Proxy did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`,
    logFile ? `Large repos can exceed the indexing window. Check: ${logFile}` : `Enable logs in config for troubleshooting.`);
}

// ── Ensure (reuse-or-start) ───────────────────────────────────────────────────

/**
 * The workhorse for `wrap` and `start`:
 *  - healthy proxy w/ same workspace → reuse
 *  - different workspace/config, or --restart → stop + start
 *  - none → start
 * @returns {Promise<{ runfile, reused: boolean }>}
 */
export async function ensureProxy({ configValues, workspace, restart = false, onProgress } = {}) {
  const running = await findRunningProxy();

  if (running && !restart) {
    const sameWorkspace = running.health?.workspace === workspace || running.workspace === workspace;
    if (sameWorkspace && running.health?.status === "ok") {
      return { runfile: running, reused: true };
    }
    // Wrong workspace or unhealthy — restart it.
    onProgress?.({ phase: "restarting", reason: sameWorkspace ? "unhealthy" : "workspace-changed" });
    await stopProxy(running);
  } else if (running && restart) {
    onProgress?.({ phase: "restarting", reason: "forced" });
    await stopProxy(running);
  }

  const runfile = await startProxy({ configValues, workspace, onProgress });
  return { runfile, reused: false };
}

// ── Stop ──────────────────────────────────────────────────────────────────────

export async function stopProxy(rf) {
  if (!rf?.pid || !pidAlive(rf.pid)) { cleanRunfile(rf); return { stopped: false, reason: "not-running" }; }

  try { process.kill(rf.pid, "SIGTERM"); } catch { /* raced */ }

  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(rf.pid)) { cleanRunfile(rf); return { stopped: true, forced: false }; }
    await sleep(150);
  }

  try { process.kill(rf.pid, "SIGKILL"); } catch { /* raced */ }
  cleanRunfile(rf);
  return { stopped: true, forced: true };
}

export async function stopAll() {
  const results = [];
  for (const rf of readRunfiles()) results.push({ port: rf.port, ...(await stopProxy(rf)) });
  return results;
}
