// src/mcp/install.js — FIXED VERSION
//
// Fixes (IN-1 … IN-6):
//
//   IN-1  ENV MISMATCH (critical): spec env was CONTEXTFORGE_PROXY_URL, but
//         bridge.js reads CF_PORT / CF_PROXY_HOST. A non-default proxy URL
//         was registered but silently IGNORED by the bridge — tools would
//         hit :3000 regardless. Now parses the URL into CF_PORT (+ CF_PROXY_HOST
//         when not 127.0.0.1), always set explicitly.
//
//   IN-2  command was "node" — GUI-launched agents (Cursor, Windsurf apps)
//         often don't have node on PATH. Now process.execPath (absolute),
//         with "node" only as documented fallback via useSystemNode option.
//
//   IN-3  healthCheck option was accepted but never implemented; the CLI
//         reads results._health. Implemented: GET {proxyUrl}/healthz with
//         3s timeout, latency measured.
//
//   IN-4  uninstallEverywhere ignored the ledger — removed ANY server named
//         "contextforge", even user-managed ones the ledger explicitly
//         exists to protect. Now: only removes when the ledger fingerprint
//         matches, unless { force: true }.
//
//   IN-5  Ledger adoption: an ALREADY result (spec matches but wasn't in the
//         ledger — e.g. registered by an older version) now records to the
//         ledger so future uninstalls work.
//
//   IN-6  Registrar constructors can throw (bad HOME, weird env) — one bad
//         registrar killed getAllRegistrars() for every agent. Each is now
//         constructed defensively.

import { RegisterStatus, ServerSpec } from "./base.js";
import {
  recordInstall,
  clearInstall,
  contextforgeInstalledMatching,
} from "./ledger.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const DEFAULT_PROXY_URL = "http://127.0.0.1:3000";

// IN-6: defensive construction — one broken registrar must not kill the rest
export function getAllRegistrars() {
  const factories = [
    () => import("./registrars/claude.js").then((m) => new m.ClaudeRegistrar()),
    () => import("./registrars/cursor.js").then((m) => new m.CursorRegistrar()),
    () => import("./registrars/windsurf.js").then((m) => new m.WindsurfRegistrar()),
    () => import("./registrars/codex.js").then((m) => new m.CodexRegistrar()),
    () => import("./registrars/gemini-cli.js").then((m) => new m.GeminiCLIRegistrar()),
  ];
  return Promise.allSettled(factories.map((f) => f())).then((settled) =>
    settled
      .filter((s) => {
        if (s.status === "rejected" && process.env.CF_DEBUG_MCP === "1") {
          console.error("[MCP] registrar unavailable:", s.reason?.message);
        }
        return s.status === "fulfilled";
      })
      .map((s) => s.value)
  );
}

export function buildContextForgeSpec(proxyUrl = DEFAULT_PROXY_URL, { useSystemNode = false } = {}) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = path.dirname(__filename);
  const bridgePath = path.resolve(__dirname, "./bridge.js").replace(/\\/g, "/");

  // IN-1: bridge.js reads CF_PORT / CF_PROXY_HOST — set them explicitly.
  const env = {};
  try {
    const u = new URL(proxyUrl);
    env.CF_PORT = u.port || (u.protocol === "https:" ? "443" : "80");
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
      env.CF_PROXY_HOST = u.hostname;
    }
  } catch {
    env.CF_PORT = "3000";
  }

  return new ServerSpec({
    name: "contextforge",
    // IN-2: absolute node path — survives GUI agents with no PATH
    command: useSystemNode ? "node" : process.execPath,
    args: [bridgePath],
    env,
  });
}

// IN-3: real health check for results._health
async function probeHealth(proxyUrl) {
  const started = Date.now();
  try {
    const res = await fetch(new URL("/healthz", proxyUrl), {
      signal: AbortSignal.timeout(3000),
    });
    return {
      ok: res.ok,
      statusCode: res.status,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - started };
  }
}

export async function installEverywhere({
  proxyUrl = DEFAULT_PROXY_URL,
  agents = null,
  force = false,
  registrars = null,
  healthCheck = true,
} = {}) {
  const spec = buildContextForgeSpec(proxyUrl);
  const all = registrars || (await getAllRegistrars());
  const selected = all.filter(
    (r) => !agents || agents.includes(r.constructor.agentName),
  );

  const results = {};

  for (const registrar of selected) {
    const agentName = registrar.constructor.agentName;

    try {
      if (!registrar.detect()) {
        results[agentName] = {
          status: RegisterStatus.NOT_DETECTED,
          detail: `${registrar.constructor.displayName} not found`,
          ok: false,
        };
        continue;
      }

      const result = registrar.registerServer(spec, { force });
      results[agentName] = result;

      // IN-5: record on REGISTERED and adopt on ALREADY
      if (
        result.status === RegisterStatus.REGISTERED ||
        result.status === RegisterStatus.ALREADY
      ) {
        recordInstall(agentName, spec);
      }
    } catch (err) {
      // IN-6: one agent's failure must not abort the others
      results[agentName] = {
        status: RegisterStatus.FAILED,
        detail: err.message,
        ok: false,
      };
    }
  }

  if (healthCheck) {
    results._health = await probeHealth(proxyUrl); // IN-3
  }

  return results;
}

// ── Result presentation helpers (used by `cf mcp install`) ──────────────────
// Previously lived in index.js; exported here too so index.js can re-export.

const STATUS_ICON = {
  [RegisterStatus.REGISTERED]:   "✅",
  [RegisterStatus.ALREADY]:      "✓ ",
  [RegisterStatus.MISMATCH]:     "⚠️ ",
  [RegisterStatus.FAILED]:       "❌",
  [RegisterStatus.NOT_DETECTED]: "— ",
};

export function formatResults(results, { verbose = false } = {}) {
  const lines = [];
  for (const [agent, r] of Object.entries(results)) {
    if (agent.startsWith("_")) continue; // _health etc.
    const icon = STATUS_ICON[r.status] ?? "? ";
    const detail =
      r.status === RegisterStatus.NOT_DETECTED && !verbose
        ? "" // keep the quiet case quiet
        : r.detail
          ? ` — ${r.detail}`
          : "";
    if (r.status === RegisterStatus.NOT_DETECTED && !verbose) {
      lines.push(`${icon} ${agent}: not installed`);
    } else {
      lines.push(`${icon} ${agent}: ${r.status}${detail}`);
    }
  }
  return lines;
}

export function anySucceeded(results) {
  return Object.entries(results).some(
    ([k, r]) => !k.startsWith("_") && (r.ok ?? false),
  );
}

export async function uninstallEverywhere({
  agents = null,
  registrars = null,
  force = false,
} = {}) {
  const all = registrars || (await getAllRegistrars());
  const selected = all.filter(
    (r) => !agents || agents.includes(r.constructor.agentName),
  );

  const results = {};
  for (const registrar of selected) {
    const agentName = registrar.constructor.agentName;
    try {
      // IN-4: the ledger's whole purpose — don't remove entries we didn't
      // install (or that the user has since modified), unless forced.
      const current = registrar.getServer("contextforge");
      if (!current) {
        results[agentName] = false;
        continue;
      }
      if (!force && !contextforgeInstalledMatching(agentName, current)) {
        results[agentName] = false; // exists, but not ours / user-modified
        if (process.env.CF_DEBUG_MCP === "1") {
          console.error(
            `[MCP] ${agentName}: entry exists but not ledger-matched — skipped (use force)`,
          );
        }
        continue;
      }

      const removed = registrar.unregisterServer("contextforge");
      if (removed) clearInstall(agentName, "contextforge");
      results[agentName] = removed;
    } catch (err) {
      results[agentName] = false;
      if (process.env.CF_DEBUG_MCP === "1") {
        console.error(`[MCP] ${agentName} uninstall failed:`, err.message);
      }
    }
  }
  return results;
}
