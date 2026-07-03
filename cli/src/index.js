/**
 * ContextForge CLI — commander wiring only. All logic lives in commands/ and core/.
 */

import { program } from "commander";
import { handleFatal } from "./ui/errors.js";

const VERSION = "1.0.0-rc.1";

// Lazy imports keep startup <50ms — commands load only when invoked.
const lazy = (loader, fn) => async (...args) => {
  const mod = await loader();
  return mod[fn](...args);
};

export function run() {
  program
    .name("contextforge")
    .description("Repository-aware execution runtime for AI coding agents")
    .version(VERSION)
    .enablePositionalOptions() // required for wrap's passThroughOptions
    .option("--verbose", "show stack traces on errors")
    .configureHelp({ sortSubcommands: false });

  // ── Setup ──
  program
    .command("setup")
    .description("Prepare the environment: provider wizard, models, native addon")
    .option("--force", "re-download models even if verified")
    .option("--reconfigure", "re-run the provider/model wizard")
    .action(lazy(() => import("./commands/setup.js"), "setup"));

  program
    .command("doctor")
    .description("Diagnose the installation (8 checks)")
    .option("--fix", "auto-fix: re-download corrupt models, clean stale runfiles")
    .option("--json", "machine-readable output")
    .action(lazy(() => import("./commands/doctor.js"), "doctor"));

  // ── Core (Step 2/3 — daemon + wrap) ──
  program
    .command("wrap <agent>")
    .description("Run an AI agent through ContextForge (v1: claude)")
    .option("--port <n>", "proxy port (0 = auto)")
    .option("--workspace <path>", "repository to index (default: git root)")
    .option("--provider <name>", "upstream provider: ollama | openai | anthropic | groq | gemini")
    .option("--model <name>", "upstream model override, e.g. minimax-m3:cloud")
    .option("--mode <mode>", "full | passthrough")
    .option("--restart", "force-restart the proxy")
    .option("--keep-alive", "leave proxy running after agent exits")
    .allowExcessArguments(true) // everything after `--` goes to the agent
    .action(lazy(() => import("./commands/wrap.js"), "wrap"));

  program
    .command("start")
    .description("Start the proxy in the background")
    .option("--port <n>", "proxy port (0 = auto)")
    .option("--workspace <path>", "repository to index (default: git root)")
    .option("--provider <name>", "upstream provider: ollama | openai | anthropic | groq | gemini")
    .option("--model <name>", "upstream model override, e.g. minimax-m3:cloud")
    .option("--mode <mode>", "full | passthrough")
    .option("--restart", "force-restart even if a healthy proxy is running")
    .action(lazy(() => import("./commands/daemonCmds.js"), "start"));

  program
    .command("restart")
    .description("Restart the managed proxy with the same config")
    .action(lazy(() => import("./commands/daemonCmds.js"), "restart"));

  program
    .command("logs")
    .description("Show proxy logs")
    .option("-f, --follow", "keep tailing")
    .option("-n, --lines <n>", "number of lines", "50")
    .action(lazy(() => import("./commands/logs.js"), "logs"));

  program
    .command("stop")
    .description("Stop the managed proxy")
    .option("--all", "stop all managed proxies")
    .action(lazy(() => import("./commands/daemonCmds.js"), "stop"));

  program
    .command("status")
    .description("Show proxy state (pid, port, workspace, uptime)")
    .option("--json", "machine-readable output")
    .action(lazy(() => import("./commands/daemonCmds.js"), "status"));

  program
    .command("init")
    .description("Create ./.contextforge.toml for this project (provider/model per repo)")
    .option("--provider <name>", "upstream provider for this project")
    .option("--model <name>", "model override for this project")
    .option("--force", "overwrite existing file")
    .action(lazy(() => import("./commands/init.js"), "init"));

  // ── MCP (persistent registration — wrap uses ephemeral config instead) ──
  const mcp = program
    .command("mcp")
    .description("Register the ContextForge MCP server with installed agents");
  mcp
    .command("install")
    .description("Register MCP server in all detected agent configs")
    .option("--force", "overwrite existing registration")
    .option("--proxy <url>", "proxy URL (default: auto-detect running proxy)")
    .option("-v, --verbose", "show detail per agent")
    .action(lazy(() => import("./commands/mcp.js"), "mcpInstall"));
  mcp
    .command("uninstall")
    .description("Remove MCP registration from all agents")
    .action(lazy(() => import("./commands/mcp.js"), "mcpUninstall"));
  mcp
    .command("status")
    .description("Show per-agent MCP registration state")
    .option("--proxy <url>", "proxy URL (default: auto-detect)")
    .option("-v, --verbose", "show registered command lines")
    .action(lazy(() => import("./commands/mcp.js"), "mcpStatus"));

  // ── Config ──
  const config = program.command("config").description("Show or edit configuration");
  config
    .command("show", { isDefault: true })
    .description("Print resolved config with the source of each value")
    .option("--json", "machine-readable output")
    .action(lazy(() => import("./commands/config.js"), "configShow"));
  config
    .command("get <key>")
    .description("Print a single resolved value")
    .action(lazy(() => import("./commands/config.js"), "configGet"));
  config
    .command("set <key> <value>")
    .description("Set a value in global (or --project) config")
    .option("--project", "write to ./.contextforge.toml instead of global")
    .action(lazy(() => import("./commands/config.js"), "configSet"));

  // ── Global error handling ──
  process.on("uncaughtException", (err) =>
    handleFatal(err, { verbose: program.opts().verbose }));
  process.on("unhandledRejection", (err) =>
    handleFatal(err instanceof Error ? err : new Error(String(err)),
      { verbose: program.opts().verbose }));

  program.parseAsync().catch((err) =>
    handleFatal(err, { verbose: program.opts().verbose }));
}
