#!/usr/bin/env node
// src/cli/mcp.js
// Usage:
//   node src/cli/mcp.js install
//   node src/cli/mcp.js install --force
//   node src/cli/mcp.js uninstall
//   node src/cli/mcp.js status

import {
  installEverywhere,
  uninstallEverywhere,
  getAllRegistrars,
  formatResults,
  anySucceeded,
  DEFAULT_PROXY_URL,
} from "../mcp/index.js";
import { RegisterStatus } from "../mcp/base.js";
import { buildContextForgeSpec } from "../mcp/install.js";

const [,, command, ...flags] = process.argv;
const force     = flags.includes("--force");
const verbose   = flags.includes("--verbose") || flags.includes("-v");
const proxyUrl  = flags.find(f => f.startsWith("--proxy="))?.split("=")[1]
               || DEFAULT_PROXY_URL;

console.log("\n╔══════════════════════════════════════════════════╗");
console.log("║          ContextForge MCP Installer              ║");
console.log("╚══════════════════════════════════════════════════╝\n");

switch (command) {
  case "install": {
    console.log(`Installing ContextForge MCP server into all detected agents...`);
    console.log(`Proxy URL: ${proxyUrl}\n`);

    const results = await installEverywhere({ proxyUrl, force });
    const lines   = formatResults(results, { verbose });

    if (lines.length) {
      console.log(lines.join("\n"));
    } else {
      console.log("  No agents detected on this system.");
    }

    if (results._health) {
      const h = results._health;
      console.log(
        h.ok
          ? `\n🟢 Proxy healthy (${h.latencyMs}ms)`
          : `\n🔴 Proxy unreachable: ${h.error || h.statusCode}`,
      );
    }

    if (anySucceeded(results)) {
      console.log("\n✅ MCP server registered. Restart your agent to activate.\n");
    } else {
      console.log("\n⚠️  No agents were updated.\n");
    }
    break;
  }

  case "uninstall": {
    console.log("Removing ContextForge MCP server from all agents...\n");
    const results = await uninstallEverywhere();
    for (const [agent, removed] of Object.entries(results)) {
      console.log(`  ${agent}: ${removed ? "✅ removed" : "— not found"}`);
    }
    console.log("");
    break;
  }

  case "status": {
    const spec       = buildContextForgeSpec(proxyUrl);
    const registrars = getAllRegistrars();

    console.log("Agent status:\n");
    for (const r of registrars) {
      const detected = r.detect();
      const server   = detected ? r.getServer(spec.name) : null;
      const agentName = r.constructor.displayName;

      if (!detected) {
        console.log(`  ${agentName}: — not installed`);
      } else if (!server) {
        console.log(`  ${agentName}: ✓ detected, MCP not registered`);
      } else {
        console.log(`  ${agentName}: ✅ registered`);
        if (verbose) {
          console.log(`    command: ${server.command} ${server.args.join(" ")}`);
        }
      }
    }
    console.log("");
    break;
  }

  default:
    console.log("Usage:");
    console.log("  node src/cli/mcp.js install [--force] [--proxy=URL]");
    console.log("  node src/cli/mcp.js uninstall");
    console.log("  node src/cli/mcp.js status [-v]");
    console.log("");
}