/**
 * cf mcp install|uninstall|status — persistent MCP registration.
 *
 * Complements `cf wrap` (which uses ephemeral per-session --mcp-config):
 * this writes the ContextForge MCP server into agent config files
 * permanently, for users who run `cf start` and launch their agent
 * themselves, or for agents wrap doesn't support yet (Cursor, etc.).
 *
 * Thin shell over the repo's registrar library (src/mcp/index.js) —
 * replaces the old standalone `node src/cli/mcp.js` entry point.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { repoRoot } from "../core/native.js";
import { findRunningProxy } from "../core/daemon.js";
import { resolveConfig } from "../core/config.js";
import { resolveWorkspace } from "../core/paths.js";
import { header, ok, fail, warn, info, dim } from "../ui/output.js";
import { CFError } from "../ui/errors.js";

async function loadRegistrarLib() {
  const candidates = [
    path.join(repoRoot(), "src", "mcp", "index.js"),
    path.join(repoRoot(), "mcp", "index.js"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new CFError(
      "CF_ERR_MCP_LIB",
      `MCP registrar library not found (searched: ${candidates.join(", ")})`,
      "Expected src/mcp/index.js exporting installEverywhere/uninstallEverywhere/getAllRegistrars."
    );
  }
  return import(pathToFileURL(found).href);
}

/** Prefer the actually-running managed proxy's port; fall back to config. */
async function resolveProxyUrl(opts) {
  if (opts.proxy) return opts.proxy;
  const running = await findRunningProxy();
  if (running?.port) return `http://127.0.0.1:${running.port}`;
  const { values } = resolveConfig({ workspace: resolveWorkspace() });
  const port = values["proxy.port"] === 0 ? 3000 : values["proxy.port"];
  return `http://127.0.0.1:${port}`;
}

export async function mcpInstall(opts = {}) {
  const lib = await loadRegistrarLib();
  const proxyUrl = await resolveProxyUrl(opts);

  header("MCP Install");
  info(`proxy ${proxyUrl}${opts.proxy ? "" : dim("  (auto-detected)")}`);

  const results = await lib.installEverywhere({ proxyUrl, force: !!opts.force });
  const lines = lib.formatResults(results, { verbose: !!opts.verbose });
  if (lines.length) console.log(lines.map((l) => `  ${l}`).join("\n"));
  else warn("No agents detected on this system.");

  if (results._health) {
    const h = results._health;
    if (h.ok) ok(`Proxy healthy (${h.latencyMs}ms)`);
    else warn(`Proxy unreachable: ${h.error || h.statusCode} — start it with \`cf start\``);
  }

  if (lib.anySucceeded(results)) ok("Registered. Restart your agent to activate.");
  else fail("No agents were updated.");
  console.log("");
}

export async function mcpUninstall() {
  const lib = await loadRegistrarLib();
  header("MCP Uninstall");
  const results = await lib.uninstallEverywhere();
  for (const [agent, removed] of Object.entries(results)) {
    if (removed) ok(`${agent}: removed`);
    else info(`${agent}: not found`);
  }
  console.log("");
}

export async function mcpStatus(opts = {}) {
  const lib = await loadRegistrarLib();
  const { buildContextForgeSpec } = await import(
    pathToFileURL(path.join(repoRoot(), "src", "mcp", "install.js")).href
  );
  const proxyUrl = await resolveProxyUrl(opts);
  const spec = buildContextForgeSpec(proxyUrl);

  header("MCP Status");
  for (const r of await lib.getAllRegistrars()) {
    const agentName = r.constructor.displayName;
    const detected = r.detect();
    const server = detected ? r.getServer(spec.name) : null;
    if (!detected) info(`${agentName}: not installed`);
    else if (!server) warn(`${agentName}: detected, MCP not registered`);
    else {
      ok(`${agentName}: registered`);
      if (opts.verbose) info(dim(`  ${server.command} ${server.args.join(" ")}`));
    }
  }
  console.log("");
}
