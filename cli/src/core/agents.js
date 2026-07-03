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
        // args.push("--mcp-config", mcpConfigFile);
        cleanupFiles.push(mcpConfigFile);
      }

      return { env, args, cleanupFiles, mcpRegistered: !!bridge };
    },
  },

  // ── EXPERIMENTAL (v1.1 targets — wired, not yet battle-tested) ────────────

  "gemini-cli": {
    binary: "gemini",
    installHint: "npm i -g @google/gemini-cli",
    experimental: true,

    /**
     * gemini-cli redirects via GOOGLE_GEMINI_BASE_URL (undocumented but
     * stable @google/genai env var; the LiteLLM integration relies on it).
     * Requirements:
     *   - GEMINI_API_KEY must be SET (it selects the API-key auth path,
     *     which is the one that honors the base URL). For local upstreams
     *     the key value never reaches a real Google endpoint.
     *   - MCP tools: gemini-cli has no ephemeral --mcp-config equivalent;
     *     persistent registration via `cf mcp install` covers it.
     */
    prepare({ port }) {
      const env = {
        GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}`,
        ...(process.env.GEMINI_API_KEY ? {} : { GEMINI_API_KEY: "contextforge-local" }),
      };
      return { env, args: [], cleanupFiles: [], mcpRegistered: false };
    },
  },

  codex: {
    binary: "codex",
    installHint: "npm i -g @openai/codex",
    experimental: true,

    /**
     * codex redirects via -c config overrides defining an ad-hoc provider.
     * wire_api MUST be "chat": codex's built-in openai provider defaults to
     * the /v1/responses API, which the proxy does not serve — the override
     * pins it to /v1/chat/completions.
     * OPENAI_API_KEY placeholder satisfies env_key for local upstreams.
     * MCP tools: persistent registration via `cf mcp install` (codex
     * registrar writes ~/.codex/config.toml).
     */
    prepare({ port }) {
      const env = {
        ...(process.env.OPENAI_API_KEY ? {} : { OPENAI_API_KEY: "contextforge-local" }),
      };
      const args = [
        "-c", "model_provider=contextforge",
        "-c", 'model_providers.contextforge.name=ContextForge',
        "-c", `model_providers.contextforge.base_url=http://127.0.0.1:${port}/v1`,
        "-c", 'model_providers.contextforge.env_key=OPENAI_API_KEY',
        "-c", 'model_providers.contextforge.wire_api=chat',
      ];
      return { env, args, cleanupFiles: [], mcpRegistered: false };
    },
  },
};

export function resolveAgent(name) {
  const agent = AGENTS[name];
  if (!agent) {
    throw new CFError(
      "CF_ERR_AGENT_NOT_FOUND",
      `Unknown agent "${name}". Supported in v1: ${Object.keys(AGENTS).join(", ")}`,
      "Supported: claude (stable), gemini-cli + codex (experimental)."
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
