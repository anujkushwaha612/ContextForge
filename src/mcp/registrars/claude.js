// src/mcp/registrars/claude.js — FIXED VERSION
//
// Fixes (CR-1 … CR-6):
//
//   CR-1  CONFIG PATH WRONG (critical). Claude Code stores user-scoped MCP
//         servers in ~/.claude.json (home ROOT), not ~/.claude/.claude.json.
//         The file fallback wrote a file Claude Code never reads — silent
//         "registered but tools never appear". ~/.claude/.claude.json and
//         ~/.claude/mcp.json kept as legacy READ candidates only.
//
//   CR-2  SHELL QUOTING (critical on this project!). _registerViaCli joined
//         raw strings into one shell command — a workspace like
//         "D:\NODE JS\...\server" (space!) or node in "C:\Program Files\..."
//         split into multiple args and the command failed or registered a
//         broken server. Also an injection hazard for env values.
//         Unix: execFileSync with an args ARRAY (no shell parsing at all).
//         Windows: every arg quoted via cmdQuote() (needed because .cmd
//         shims require a shell; plain execFileSync throws EINVAL on
//         modern Node).
//
//   CR-3  DATA-LOSS GUARD (critical). readJson() returned {} when the config
//         was CORRUPT (parse error), then writeJson() overwrote the user's
//         entire ~/.claude.json — which holds far more than mcpServers
//         (settings, auth, history). Now: unreadable-but-existing config
//         ABORTS registration with a clear error; writes are atomic
//         (tmp + rename) with a .bak of the previous version.
//
//   CR-4  Constructor console.log noise removed — it fired on every
//         getAllRegistrars() call, polluting `cf mcp status` output.
//         Gated behind CF_DEBUG_MCP=1.
//
//   CR-5  HOME resolution via os.homedir() (handles HOMEDRIVE+HOMEPATH
//         correctly on Windows — bare HOMEPATH lacks the drive letter).
//
//   CR-6  CLI arg building edge cases: empty spec.args no longer injects
//         an empty string; spec.command with spaces quoted; unregister
//         quoting fixed the same way.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MCPRegistrar,
  RegisterResult,
  RegisterStatus,
  ServerSpec,
} from "../base.js";

// CR-5: os.homedir() handles USERPROFILE / HOMEDRIVE+HOMEPATH / HOME properly
const HOME = os.homedir();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../../");

const IS_WIN = process.platform === "win32";
const debug = (...a) => {
  if (process.env.CF_DEBUG_MCP === "1") console.error("[Claude Registrar]", ...a);
};

// CR-2: quote one argument for cmd.exe (wrap in "", double inner quotes)
function cmdQuote(s) {
  const str = String(s);
  if (str === "") return '""';
  if (!/[\s"^&|<>()%!]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

export class ClaudeRegistrar extends MCPRegistrar {
  static agentName   = "claude";
  static displayName = "Claude Code";

  constructor({ homeDir = HOME } = {}) {
    super();

    this._home         = homeDir;
    this._claudeDir    = path.join(homeDir, ".claude");
    // CR-1: the file Claude Code actually reads for user scope
    this._userConfig   = path.join(homeDir, ".claude.json");
    // Legacy locations — READ-ONLY candidates (never written)
    this._legacyConfigs = [
      path.join(homeDir, ".claude", ".claude.json"),
      path.join(homeDir, ".claude", "mcp.json"),
    ];
    this._claudeCli    = this._findCli();

    debug(`home=${homeDir} cli=${this._claudeCli ?? "not found"} config=${this._userConfig}`);
  }

  // ── Find the claude binary on PATH (cross-platform) ──
  _findCli() {
    const candidates = IS_WIN ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];

    for (const candidate of candidates) {
      try {
        const result = IS_WIN
          ? execSync(`where ${candidate}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], shell: "cmd.exe" })
          : execFileSync("which", [candidate], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        const first = result.trim().split(/\r?\n/)[0]?.trim();
        if (first) return first;
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  detect() {
    if (this._claudeCli) return true;
    return [
      this._claudeDir,
      this._userConfig,
      path.join(process.env.APPDATA || "", "claude"),
    ].filter(Boolean).some(existsSync);
  }

  getServer(serverName) {
    for (const configPath of [this._userConfig, ...this._legacyConfigs]) {
      const entry = this._readServerEntry(configPath, serverName);
      if (entry) return entry;
    }
    return null;
  }

  registerServer(spec, { force = false } = {}) {
    const existing = this.getServer(spec.name);

    if (existing) {
      if (specsEquivalent(existing, spec)) {
        return new RegisterResult(RegisterStatus.ALREADY, "matches current configuration");
      }
      if (!force) {
        return new RegisterResult(RegisterStatus.MISMATCH, diffSpecs(existing, spec));
      }
      this.unregisterServer(spec.name);
    }

    if (this._claudeCli) {
      return this._registerViaCli(spec);
    }
    return this._registerViaFile(spec);
  }

  unregisterServer(serverName) {
    if (this._claudeCli) {
      try {
        if (IS_WIN) {
          // CR-2/CR-6: every part quoted for cmd.exe
          execSync(
            [cmdQuote(this._claudeCli), "mcp", "remove", cmdQuote(serverName), "-s", "user"].join(" "),
            { stdio: "pipe", shell: "cmd.exe" },
          );
        } else {
          execFileSync(this._claudeCli, ["mcp", "remove", serverName, "-s", "user"], { stdio: "pipe" });
        }
        return true;
      } catch {
        // fall through to file removal
      }
    }

    let removed = false;
    for (const configPath of [this._userConfig, ...this._legacyConfigs]) {
      if (this._removeFromFile(configPath, serverName)) removed = true;
    }
    return removed;
  }

  // ── CLI registration ──
  _registerViaCli(spec) {
    try {
      // claude mcp add <name> -s user [-e K=V ...] -- <command> [args...]
      const args = ["mcp", "add", spec.name, "-s", "user"];
      for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);
      args.push("--", spec.command);

      // CR-6: resolve a relative script path against the project root;
      // absolute paths pass through untouched. No empty-string injection.
      for (let i = 0; i < spec.args.length; i++) {
        const a = spec.args[i];
        args.push(
          i === 0 && a && !path.isAbsolute(a) && /\.(c|m)?js$/.test(a)
            ? path.resolve(PROJECT_ROOT, a).replace(/\\/g, "/")
            : a
        );
      }

      debug("running:", this._claudeCli, args.join(" "));

      if (IS_WIN) {
        // CR-2: .cmd shims need a shell — quote EVERY argument
        const cmd = [cmdQuote(this._claudeCli), ...args.map(cmdQuote)].join(" ");
        execSync(cmd, { stdio: "pipe", shell: "cmd.exe" });
      } else {
        // CR-2: no shell, no quoting problems, no injection
        execFileSync(this._claudeCli, args, { stdio: "pipe" });
      }

      return new RegisterResult(RegisterStatus.REGISTERED, "via `claude mcp add` (scope: user)");
    } catch (err) {
      debug(`CLI failed: ${err.message}`);
      const fileResult = this._registerViaFile(spec);
      if (fileResult.status === RegisterStatus.REGISTERED) {
        return new RegisterResult(
          RegisterStatus.REGISTERED,
          `via file fallback (CLI failed: ${firstLine(err.message)})`,
        );
      }
      return new RegisterResult(
        RegisterStatus.FAILED,
        `CLI: ${firstLine(err.message)} | file: ${fileResult.detail}`,
      );
    }
  }

  // ── File registration (fallback) ──
  _registerViaFile(spec) {
    // CR-1: write to the file Claude Code actually reads
    const target = this._userConfig;

    let config;
    try {
      config = readJsonStrict(target); // CR-3: throws on corrupt file
    } catch (err) {
      return new RegisterResult(
        RegisterStatus.FAILED,
        `${target} exists but is not valid JSON (${firstLine(err.message)}) — ` +
        `refusing to overwrite it. Fix or back up the file, then retry.`,
      );
    }

    try {
      const servers = config.mcpServers || (config.mcpServers = {});
      servers[spec.name] = specToEntry(spec);
      writeJsonAtomic(target, config); // CR-3: tmp+rename, .bak of previous
      return new RegisterResult(RegisterStatus.REGISTERED, `wrote to ${target}`);
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
      const config  = readJsonStrict(configPath); // CR-3: never wipe corrupt files
      const servers = config.mcpServers || {};
      if (!(serverName in servers)) return false;
      delete servers[serverName];
      writeJsonAtomic(configPath, config);
      return true;
    } catch {
      return false; // corrupt or unwritable — leave it alone
    }
  }

  _readServerEntry(configPath, serverName) {
    if (!existsSync(configPath)) return null;
    try {
      const config = readJsonStrict(configPath);
      const entry  = config?.mcpServers?.[serverName];
      if (!entry || typeof entry !== "object") return null;
      return entryToSpec(serverName, entry);
    } catch {
      return null;
    }
  }
}

// ── JSON helpers ──

// CR-3: strict — missing file → {}, corrupt file → THROW (caller decides).
// Strips a UTF-8 BOM, which Windows editors love to add.
function readJsonStrict(filePath) {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  if (raw.trim() === "") return {};
  return JSON.parse(raw); // throws on corrupt — intentionally not swallowed
}

// CR-3: atomic write + backup of the previous version
function writeJsonAtomic(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    try { copyFileSync(filePath, `${filePath}.bak`); } catch { /* best effort */ }
  }
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, filePath);
}

function firstLine(s) {
  return String(s).split(/\r?\n/)[0];
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
