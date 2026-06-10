// src/mcp/install.js
import { ClaudeRegistrar } from "./registrars/claude.js";
import { CursorRegistrar } from "./registrars/cursor.js";
import { WindsurfRegistrar } from "./registrars/windsurf.js";
import { RegisterStatus } from "./base.js";
import { recordInstall, clearInstall } from "./ledger.js";
import { checkProxyHealth } from "./health.js";
import { ServerSpec } from "./base.js";
import { CodexRegistrar } from "./registrars/codex.js";
import { GeminiCLIRegistrar } from "./registrars/gemini-cli.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const DEFAULT_PROXY_URL = "http://127.0.0.1:3000";

export function getAllRegistrars() {
  return [
    new ClaudeRegistrar(),
    new CursorRegistrar(),
    new WindsurfRegistrar(),
    new CodexRegistrar(), // ← added
    new GeminiCLIRegistrar(), // ← added
  ];
}

export function buildContextForgeSpec(proxyUrl = DEFAULT_PROXY_URL) {
  const __filename   = fileURLToPath(import.meta.url);
  const __dirname    = path.dirname(__filename);
  // Points to the MCP stdio bridge, NOT server.js
  const bridgePath   = path.resolve(__dirname, "./server.js")
    .replace(/\\/g, "/");

  const env = {};
  if (proxyUrl && proxyUrl !== DEFAULT_PROXY_URL) {
    env["CONTEXTFORGE_PROXY_URL"] = proxyUrl;
  }

  return new ServerSpec({
    name:    "contextforge",
    command: "node",
    args:    [bridgePath],   // ← src/mcp/server.js not server.js
    env,
  });
}

export async function installEverywhere({
  proxyUrl = DEFAULT_PROXY_URL,
  agents = null,
  force = false,
  registrars = null,
  healthCheck = true,
} = {}) {
  const spec = buildContextForgeSpec(proxyUrl);
  const selected = (registrars || getAllRegistrars()).filter(
    (r) => !agents || agents.includes(r.constructor.agentName),
  );

  const results = {};

  for (const registrar of selected) {
    const agentName = registrar.constructor.agentName;

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

    // Record in ledger if we successfully registered
    if (result.status === RegisterStatus.REGISTERED) {
      recordInstall(agentName, spec);
    }
  }

  // Health check — verify proxy is reachable
  if (
    healthCheck &&
    Object.entries(results)
      .filter(([k]) => k !== "_health")
      .some(([, r]) => r.ok)
  ) {
    const health = await checkProxyHealth(proxyUrl);
    results._health = health;

    if (!health.ok) {
      console.warn(
        `\n[MCP] ⚠️  Proxy health check failed: ${health.error || health.statusCode}`,
      );
      console.warn(
        `[MCP]    Make sure ContextForge is running: node src/server.js`,
      );
    } else {
      console.log(`[MCP] ✅ Proxy healthy (${health.latencyMs}ms)`);
    }
  }

  return results;
}

export async function uninstallEverywhere({
  agents = null,
  registrars = null,
} = {}) {
  const spec = buildContextForgeSpec();
  const selected = (registrars || getAllRegistrars()).filter(
    (r) => !agents || agents.includes(r.constructor.agentName),
  );

  const results = {};
  for (const registrar of selected) {
    const agentName = registrar.constructor.agentName;
    const removed = registrar.unregisterServer(spec.name);
    if (removed) clearInstall(agentName, spec.name);
    results[agentName] = removed;
  }
  return results;
}
