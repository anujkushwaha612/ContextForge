/**
 * commands/doctor.js
 *
 * cf doctor — diagnose the install. Checks in dependency order:
 *   1. Node version           5. Write access to CF home
 *   2. Native addon loads     6. Stale runfiles
 *   3. Models verified        7. Agent binary (claude)
 *   4. Embedder smoke test    8. Proxy health (if running)
 *   9. Provider config        10. Provider connectivity
 *
 * --fix    re-download corrupt models, clean stale runfiles
 * --json   machine-readable output for bug reports
 *
 * Enhanced with provider validation and connectivity testing.
 */

import { accessSync, constants, readdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cfHome, modelsDir, runDir, ensureLayout } from "../core/paths.js";
import { modelStatus, ensureModels } from "../core/assets.js";
import { diagnoseNative, smokeTestEmbedder, platformTriple } from "../core/native.js";
import { resolveConfig, validateProvider, getProviderRequirements, VALID_PROVIDERS } from "../core/config.js";
import { testProvider } from "../core/daemon.js";
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

  // 9. Provider configuration
  const { values } = resolveConfig({ workspace: process.cwd() });
  const provider = values["provider.name"];
  
  if (VALID_PROVIDERS.includes(provider)) {
    add("provider:name", true, provider);
    
    // Check API key for paid providers
    const requirements = getProviderRequirements(provider);
    if (requirements && requirements.envVars.length > 0) {
      const missingEnvVars = requirements.envVars.filter(varName => !process.env[varName]);
      
      if (missingEnvVars.length === 0) {
        add("provider:apikey", true, "environment variables set");
        
        // 10. Provider connectivity (only if API key is set and not skipped)
        if (!opts.skipProviderTest && provider !== "ollama") {
          try {
            info(dim("Testing provider connectivity..."));
            const testResult = await testProvider(provider, { timeout: 10000 });
            
            if (testResult.ok) {
              const latency = testResult.latency ? `${testResult.latency}ms` : "OK";
              add("provider:connectivity", true, `connected (${latency})`);
            } else {
              add("provider:connectivity", false, testResult.error,
                "Check your API key and network connection. Run `cf test` for details.");
            }
          } catch (error) {
            add("provider:connectivity", false, error.message,
              "Provider test failed. Run `cf test` for more details.");
          }
        } else if (provider === "ollama") {
          // Test Ollama connectivity
          try {
            const testResult = await testProvider("ollama");
            if (testResult.ok) {
              add("provider:connectivity", true, `connected (${testResult.models?.length || 0} models)`);
            } else {
              add("provider:connectivity", false, testResult.error,
                "Make sure Ollama is running: ollama serve");
            }
          } catch (error) {
            add("provider:connectivity", false, error.message);
          }
        }
      } else {
        const envVarList = missingEnvVars.join(", ");
        const url = requirements.url ? `\n  Get your key: ${requirements.url}` : "";
        add("provider:apikey", false, `missing: ${envVarList}`,
          `${requirements.note}${url}\n  Set it with: export ${missingEnvVars[0]}=your_key_here`);
      }
    }
  } else {
    add("provider:name", false, `invalid: ${provider}`,
      `Valid providers: ${VALID_PROVIDERS.join(", ")}\n  Fix with: cf config set provider.name ollama`);
  }

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
