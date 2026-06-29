#!/usr/bin/env node
/**
 * ContextForge CLI
 * Entry point for all contextforge commands.
 */

import { program } from "commander";
import { wrap }      from "./commands/wrap.js";
import { doctor }    from "./commands/doctor.js";
import { proxy }     from "./commands/proxy.js";
import { dashboard } from "./commands/dashboard.js";
import { graph }     from "./commands/graph.js";
import { benchmark } from "./commands/benchmark.js";

program
  .name("contextforge")
  .description("Repository-aware execution runtime for AI coding agents")
  .version("1.0.0");

program
  .command("wrap <agent>")
  .description("Wrap an AI agent through ContextForge  (claude)")
  .option("--port <port>", "Proxy port", "3000")
  .option("--workspace <path>", "Repository to index", process.cwd())
  .action(wrap);

program
  .command("doctor")
  .description("Check that everything is installed and configured correctly")
  .action(doctor);

program
  .command("proxy")
  .description("Start the proxy without wrapping a specific agent")
  .option("--port <port>", "Proxy port", "3000")
  .action(proxy);

program
  .command("dashboard")
  .description("Open the live metrics dashboard in your browser")
  .action(dashboard);

program
  .command("graph")
  .description("Show repository graph stats for the current workspace")
  .option("--workspace <path>", "Repository path", process.cwd())
  .action(graph);

program
  .command("benchmark")
  .description("Run a compression benchmark against the current workspace")
  .action(benchmark);

program.parse();