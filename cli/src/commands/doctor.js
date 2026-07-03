/**
 * cf doctor — diagnose the install. Checks in dependency order:
 *   1. Node version           5. Write access to CF home
 *   2. Native addon loads     6. Stale runfiles
 *   3. Models verified        7. Agent binary (claude)
 *   4. Embedder smoke test    8. Proxy health (if running)
 *
 * --fix    re-download corrupt models, clean stale runfiles
 * --json   machine-readable output for bug reports
 */

import { accessSync, constants, readdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cfHome, modelsDir, runDir, ensureLayout } from "../core/paths.js";
import { modelStatus, ensureModels } from "../core/assets.js";
import { diagnoseNative, smokeTestEmbedder, platformTriple } from "../core/native.js";
import { header, ok, fail, warn, info, dim } from "../ui/output.js";
import { EXIT } from "../ui/errors.js";

const MIN_NODE_MAJOR = 18;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Shared with wrap — prefers .exe/.cmd over extensionless sh-shims on Windows
import { findBinary as findAgentBinary } from "../core/agents.js";

export async function doctor(opts = {}) {
  const fix = !!opts.fix;
  const results = [];
  const add = (name, okFlag, detail, hint = null) =>
    results.push({ name, ok: okFlag, detail, hint });

  if (!opts.json) header(`ContextForge Doctor ${dim(`(${platformTriple()}, node ${process.version})`)}`);
  ensureLayout();

  // 1. Node version
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= MIN_NODE_MAJOR, `Node ${process.version}`,
    major >= MIN_NODE_MAJOR ? null : `Node >= ${MIN_NODE_MAJOR} required — upgrade via nvm or nodejs.org`);

  // 2. Native addon
  const native = diagnoseNative();
  add("native-addon", native.ok,
    native.ok ? `loads (${native.kind}): ${native.path}` : native.error, native.hint ?? null);

  // 3. Models
  let models = await modelStatus();
  let broken = models.filter((m) => !m.ok);
  if (broken.length && fix) {
    if (!opts.json) warn(`Fixing ${broken.length} model asset(s)...`);
    await ensureModels();
    models = await modelStatus();
    broken = models.filter((m) => !m.ok);
  }
  for (const m of models) {
    add(`model:${m.asset.name}`, m.ok,
      m.ok ? `verified (${(m.asset.size / 1024 / 1024).toFixed(1)} MB)` : m.reason,
      m.ok ? null : "Run `cf doctor --fix` or `cf setup` to re-download");
  }

  // 4. Embedder smoke test (only if 2+3 passed — no point otherwise)
  if (native.ok && broken.length === 0) {
    const smoke = await smokeTestEmbedder(modelsDir());
    add("embedder", smoke.ok, smoke.ok ? "embed('warmup') → 384 dims" : smoke.error,
      smoke.ok ? null : "Addon/model mismatch — rebuild addon or `cf doctor --fix`");
  } else {
    add("embedder", false, "skipped (native addon or models not ready)");
  }

  // 5. Write access
  try {
    accessSync(cfHome(), constants.W_OK);
    add("home-writable", true, cfHome());
  } catch {
    add("home-writable", false, cfHome(), "Fix permissions on the ContextForge home directory");
  }

  // 6. Stale runfiles
  let stale = [];
  try {
    for (const f of readdirSync(runDir())) {
      if (!f.startsWith("proxy-") || !f.endsWith(".json")) continue;
      const p = path.join(runDir(), f);
      try {
        const rf = JSON.parse(readFileSync(p, "utf8"));
        if (!rf.pid || !pidAlive(rf.pid)) {
          stale.push(p);
          if (fix) unlinkSync(p);
        }
      } catch { stale.push(p); if (fix) unlinkSync(p); }
    }
  } catch { /* run dir empty/absent is fine */ }
  add("runfiles", stale.length === 0 || fix,
    stale.length === 0 ? "no stale runfiles"
      : fix ? `cleaned ${stale.length} stale runfile(s)`
      : `${stale.length} stale runfile(s)`,
    stale.length && !fix ? "Run `cf doctor --fix` to clean" : null);

  // 7. Agent binary
  const claudeBin = findAgentBinary("claude");
  add("agent:claude", !!claudeBin, claudeBin ?? "not found on PATH",
    claudeBin ? null : "Install with: npm i -g @anthropic-ai/claude-code");

  // 8. Proxy health (best effort — only if a live runfile exists)
  let proxyChecked = false;
  try {
    for (const f of readdirSync(runDir())) {
      if (!f.startsWith("proxy-")) continue;
      const rf = JSON.parse(readFileSync(path.join(runDir(), f), "utf8"));
      if (rf.pid && pidAlive(rf.pid) && rf.port) {
        proxyChecked = true;
        try {
          const res = await fetch(`http://127.0.0.1:${rf.port}/healthz`, { signal: AbortSignal.timeout(3000) });
          add(`proxy:${rf.port}`, res.ok, res.ok ? `healthy (pid ${rf.pid})` : `HTTP ${res.status}`,
            res.ok ? null : "Proxy is running but unhealthy — `cf restart`");
        } catch {
          add(`proxy:${rf.port}`, false, `pid ${rf.pid} alive but /healthz unreachable`,
            "Port may be blocked or the proxy is still indexing — check `cf logs`");
        }
      }
    }
  } catch { /* ignore */ }
  if (!proxyChecked) add("proxy", true, "not running (start with `cf start` or `cf wrap claude`)");

  // ── Report ──
  const failed = results.filter((r) => !r.ok);
  if (opts.json) {
    console.log(JSON.stringify({ platform: platformTriple(), node: process.version, checks: results, ok: failed.length === 0 }, null, 2));
  } else {
    for (const r of results) {
      (r.ok ? ok : fail)(`${r.name.padEnd(28)} ${r.detail}`);
      if (!r.ok && r.hint) info(dim(`  ↳ ${r.hint}`));
    }
    console.log("");
    if (failed.length === 0) ok("All checks passed — you're ready: `cf wrap claude`");
    else fail(`${failed.length} check(s) failed${fix ? "" : " — try `cf doctor --fix`"}`);
    console.log("");
  }

  process.exitCode = failed.length === 0 ? EXIT.OK : EXIT.ENV;
  return failed.length === 0;
}
