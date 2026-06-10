// src/mcp/registrars/claude.js
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MCPRegistrar,
  RegisterResult,
  RegisterStatus,
  ServerSpec,
} from "../base.js";

// ── Resolve home dir with full Windows fallback chain ──
const HOME =
  process.env.HOME ||
  process.env.USERPROFILE ||
  process.env.HOMEPATH ||
  "";

// ── Resolve project root (where server.js lives) ──
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../../");

export class ClaudeRegistrar extends MCPRegistrar {
  static agentName   = "claude";
  static displayName = "Claude Code";

  constructor({ homeDir = HOME } = {}) {
    super();

    this._home         = homeDir;
    this._claudeDir    = path.join(homeDir, ".claude");
    this._modernConfig = path.join(homeDir, ".claude", ".claude.json");
    this._legacyConfig = path.join(homeDir, ".claude", "mcp.json");
    this._claudeCli    = this._findCli();

    console.log(`[Claude Registrar] Home:    ${homeDir}`);
    console.log(`[Claude Registrar] CLI:     ${this._claudeCli ?? "not found"}`);
    console.log(`[Claude Registrar] Config:  ${this._modernConfig}`);
  }

  // ── Find the claude binary on PATH (cross-platform) ──
  _findCli() {
    const isWin = process.platform === "win32";

    // On Windows, Git Bash might expose `where` but not `which`
    // Try both — also try claude.cmd explicitly
    const candidates = isWin
      ? ["claude.cmd", "claude.exe", "claude"]
      : ["claude"];

    for (const candidate of candidates) {
      try {
        const cmd = isWin
          ? `where ${candidate} 2>nul`
          : `which ${candidate} 2>/dev/null`;

        const result = execSync(cmd, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          // Use cmd.exe on Windows for `where` to work properly
          shell: isWin ? "cmd.exe" : "/bin/sh",
        }).trim();

        if (result) {
          // `where` can return multiple lines — take the first
          const first = result.split(/\r?\n/)[0].trim();
          if (first) return first;
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  detect() {
    if (this._claudeCli) return true;

    // Check all possible .claude directory locations
    const dirs = [
      this._claudeDir,
      path.join(process.env.USERPROFILE || "", ".claude"),
      path.join(process.env.APPDATA    || "", "claude"),
    ].filter(Boolean);

    return dirs.some(existsSync);
  }

  getServer(serverName) {
    for (const configPath of [this._modernConfig, this._legacyConfig]) {
      const entry = this._readServerEntry(configPath, serverName);
      if (entry) return entry;
    }
    return null;
  }

  registerServer(spec, { force = false } = {}) {
    const existing = this.getServer(spec.name);

    if (existing) {
      if (specsEquivalent(existing, spec)) {
        return new RegisterResult(
          RegisterStatus.ALREADY,
          "matches current configuration",
        );
      }
      if (!force) {
        return new RegisterResult(
          RegisterStatus.MISMATCH,
          diffSpecs(existing, spec),
        );
      }
      this.unregisterServer(spec.name);
    }

    // Prefer CLI if available — it's more reliable on Windows
    if (this._claudeCli) {
      return this._registerViaCli(spec);
    }
    return this._registerViaFile(spec);
  }

  unregisterServer(serverName) {
    if (this._claudeCli) {
      try {
        execSync(
          `"${this._claudeCli}" mcp remove "${serverName}" -s user`,
          {
            stdio: "pipe",
            shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
          },
        );
        return true;
      } catch {
        // fall through to file removal
      }
    }

    let removed = false;
    for (const configPath of [this._modernConfig, this._legacyConfig]) {
      if (this._removeFromFile(configPath, serverName)) removed = true;
    }
    return removed;
  }

  // ── CLI registration ──
  _registerViaCli(spec) {
    try {
      const envArgs = Object.entries(spec.env)
        .flatMap(([k, v]) => ["-e", `${k}=${v}`]);

      // Build the command as an array then join
      // Use forward slashes for the path — claude CLI handles them on Windows
      const serverPath = spec.args[0]
        ? path.resolve(PROJECT_ROOT, spec.args[0]).replace(/\\/g, "/")
        : spec.args.join(" ");

      const parts = [
        `"${this._claudeCli}"`,
        "mcp", "add", spec.name,
        "-s", "user",
        ...envArgs,
        "--",
        spec.command,
        serverPath,
        ...spec.args.slice(1),
      ];

      const cmd = parts.join(" ");
      console.log(`[Claude Registrar] Running: ${cmd}`);

      execSync(cmd, {
        stdio: "pipe",
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      });

      return new RegisterResult(
        RegisterStatus.REGISTERED,
        "via `claude mcp add` (scope: user)",
      );
    } catch (err) {
      console.warn(`[Claude Registrar] CLI failed: ${err.message}`);
      // Fall back to file
      const fileResult = this._registerViaFile(spec);
      if (fileResult.status === RegisterStatus.REGISTERED) {
        return new RegisterResult(
          RegisterStatus.REGISTERED,
          `via file fallback (CLI failed: ${err.message})`,
        );
      }
      return new RegisterResult(
        RegisterStatus.FAILED,
        `CLI: ${err.message} | file: ${fileResult.detail}`,
      );
    }
  }

  // ── File registration (fallback) ──
  _registerViaFile(spec) {
    // On Windows use USERPROFILE to be safe
    const home   = process.env.USERPROFILE || this._home;
    let target   = path.join(home, ".claude", ".claude.json");

    // If modern config doesn't exist but legacy does, use legacy
    if (!existsSync(target) && existsSync(path.join(home, ".claude", "mcp.json"))) {
      target = path.join(home, ".claude", "mcp.json");
    }

    try {
      const config  = readJson(target);
      const servers = config.mcpServers || (config.mcpServers = {});
      servers[spec.name] = specToEntry(spec);
      writeJson(target, config);
      return new RegisterResult(
        RegisterStatus.REGISTERED,
        `wrote to ${target}`,
      );
    } catch (err) {
      return new RegisterResult(
        RegisterStatus.FAILED,
        `could not write ${target}: ${err.message}`,
      );
    }
  }

  _removeFromFile(configPath, serverName) {
    if (!existsSync(configPath)) return false;
    try {
      const config  = readJson(configPath);
      const servers = config.mcpServers || {};
      if (!(serverName in servers)) return false;
      delete servers[serverName];
      writeJson(configPath, config);
      return true;
    } catch {
      return false;
    }
  }

  _readServerEntry(configPath, serverName) {
    if (!existsSync(configPath)) return null;
    try {
      const config = readJson(configPath);
      const entry  = config?.mcpServers?.[serverName];
      if (!entry || typeof entry !== "object") return null;
      return entryToSpec(serverName, entry);
    } catch {
      return null;
    }
  }
}

// ── JSON helpers ──
function readJson(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function specToEntry(spec) {
  const entry = { command: spec.command };
  if (spec.args.length)              entry.args = [...spec.args];
  if (Object.keys(spec.env).length)  entry.env  = { ...spec.env };
  return entry;
}

function entryToSpec(name, entry) {
  return new ServerSpec({
    name,
    command: String(entry.command || ""),
    args:    Array.isArray(entry.args) ? entry.args.map(String) : [],
    env:     typeof entry.env === "object" && entry.env
      ? Object.fromEntries(
          Object.entries(entry.env).map(([k, v]) => [k, String(v)]),
        )
      : {},
  });
}

function specsEquivalent(a, b) {
  return (
    a.name    === b.name    &&
    a.command === b.command &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.env)  === JSON.stringify(b.env)
  );
}

function diffSpecs(existing, requested) {
  const parts = [];
  if (existing.command !== requested.command)
    parts.push(`command: ${existing.command} → ${requested.command}`);
  if (JSON.stringify(existing.args) !== JSON.stringify(requested.args))
    parts.push(`args: ${JSON.stringify(existing.args)} → ${JSON.stringify(requested.args)}`);
  if (JSON.stringify(existing.env) !== JSON.stringify(requested.env))
    parts.push(`env changed`);
  return parts.length ? parts.join("; ") : "spec differs";
}