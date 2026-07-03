/**
 * core/agents.js
 *
 * Agent registry: how to launch each supported agent through ContextForge.
 * Adding an agent later = one new entry, no changes to wrap.js.
 *
 * Claude Code integration (v1):
 *   - env.ANTHROPIC_BASE_URL → proxy (Claude speaks Anthropic format;
 *     the proxy translates to the configured upstream: ollama/openai/...)
 *   - --mcp-config <ephemeral json> → registers the ContextForge MCP bridge
 *     (graph/patch/read_file_chunk/retrieve tools) with CF_PORT injected,
 *     since the proxy port may be auto-picked.
 *   - ANTHROPIC_API_KEY passthrough is untouched: for ollama upstreams the
 *     key is never used upstream; a placeholder is set if absent so Claude
 *     Code doesn't block on login for local-model usage.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./native.js";
import { CFError } from "../ui/errors.js";

export function findBinary(name) {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  try {
    const lines = execFileSync(cmd, [name], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return null;

    if (isWin) {
      // `where` can return an extensionless sh-shim FIRST (e.g. nvm4w puts
      // C:\nvm4w\nodejs\claude before claude.cmd) — Windows cannot spawn it
      // (ENOENT). Prefer real Windows executables.
      const byExt = (ext) => lines.find((l) => l.toLowerCase().endsWith(ext));
      return byExt(".exe") || byExt(".cmd") || byExt(".bat") || lines[0];
    }
    return lines[0];
  } catch {
    return null;
  }
}

/**
 * Build spawn parameters for a resolved binary.
 * On Windows, .cmd/.bat cannot be spawned directly (EINVAL since the
 * CVE-2024-27980 hardening) — route through cmd.exe /c with every part
 * quoted (handles spaces in paths like "D:\NODE JS\...").
 */
export function buildSpawn(bin, args) {
  const isWin = process.platform === "win32";
  const lower = bin.toLowerCase();
  if (isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const q = (s) => (/[\s"^&|<>()]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", [q(bin), ...args.map(q)].join(" ")],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { command: bin, args, options: {} };
}

function bridgePath() {
  const candidates = [
    path.join(repoRoot(), "mcp", "bridge.js"),
    path.join(repoRoot(), "src", "mcp", "bridge.js"),
    path.join(repoRoot(), "src", "mcp", "server.js"), // legacy bridge
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export const AGENTS = {
  claude: {
    binary: "claude",
    installHint: "npm i -g @anthropic-ai/claude-code",

    /** Build spawn env + extra CLI args for this agent. */
    prepare({ port }) {
      const env = {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        // Claude Code refuses to start without a key even when the upstream
        // (e.g. ollama) never sees it. Only set a placeholder if absent.
        ...(process.env.ANTHROPIC_API_KEY ? {} : { ANTHROPIC_API_KEY: "contextforge-local" }),
      };

      const args = [];
      const cleanupFiles = [];

      const bridge = bridgePath();
      if (bridge) {
        const dir = mkdtempSync(path.join(os.tmpdir(), "cf-mcp-"));
        const mcpConfigFile = path.join(dir, "mcp.json");
        writeFileSync(
          mcpConfigFile,
          JSON.stringify(
            {
              mcpServers: {
                contextforge: {
                  command: process.execPath,
                  args: [bridge],
                  env: { CF_PORT: String(port) },
                },
              },
            },
            null,
            2
          )
        );
        args.push("--mcp-config", mcpConfigFile);
        cleanupFiles.push(mcpConfigFile);
      }

      return { env, args, cleanupFiles, mcpRegistered: !!bridge };
    },
  },
};

export function resolveAgent(name) {
  const agent = AGENTS[name];
  if (!agent) {
    throw new CFError(
      "CF_ERR_AGENT_NOT_FOUND",
      `Unknown agent "${name}". Supported in v1: ${Object.keys(AGENTS).join(", ")}`,
      "More agents (codex, gemini-cli) land in v1.x."
    );
  }
  const bin = findBinary(agent.binary);
  if (!bin) {
    throw new CFError(
      "CF_ERR_AGENT_NOT_FOUND",
      `Agent binary "${agent.binary}" not found on PATH`,
      `Install it first: ${agent.installHint}`
    );
  }
  return { ...agent, bin };
}
