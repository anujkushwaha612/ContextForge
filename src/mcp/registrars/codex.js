// src/mcp/registrars/codex.js — FIXED VERSION
//
// Fixes (CX-1 … CX-5):
//
//   CX-1  WRONG TOML SHAPE (critical). Wrote [[mcp]] array-of-tables, but
//         Codex reads [mcp_servers.<name>] tables from ~/.codex/config.toml
//         (see developers.openai.com/codex/mcp). Every registration was
//         written in a format Codex silently ignores — "registered" but no
//         tools ever appeared.
//
//   CX-2  TOML STRING ESCAPING (critical on Windows). command/args were
//         interpolated raw into basic strings — a Windows path like
//         C:\Program Files\nodejs\node.exe contains \P and \n escapes:
//         \n becomes a NEWLINE, corrupting the whole config.toml.
//         All strings now go through tomlString() (escapes \ and ").
//
//   CX-3  Data-safety: writes are atomic (tmp+rename) with .bak, and if the
//         existing config.toml can't be read (permissions), registration
//         aborts instead of writing a fresh file over it.
//
//   CX-4  unregisterServer wrote unconditionally even when no block existed
//         (returned true after a no-op regex) — now only writes on change.
//
//   CX-5  os.homedir() instead of HOME||USERPROFILE||"" (empty string made
//         CONFIG_PATH relative to cwd).
//
// The marker-block strategy is kept: we own only the region between the
// markers and never parse/rewrite the rest of the user's config.toml.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCPRegistrar, RegisterResult, RegisterStatus, ServerSpec } from "../base.js";

const HOME         = os.homedir();                       // CX-5
const CONFIG_DIR   = path.join(HOME, ".codex");
const CONFIG_PATH  = path.join(CONFIG_DIR, "config.toml");
const MARKER_BEGIN = `# --- contextforge begin ---`;
const MARKER_END   = `# --- contextforge end ---`;

// CX-2: TOML basic-string escaping — backslashes and quotes
function tomlString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// CX-1: correct Codex shape — [mcp_servers.<name>]
function entrySection(spec) {
  const lines = [`[mcp_servers.${spec.name}]`, `command = ${tomlString(spec.command)}`];
  if (spec.args.length) {
    lines.push(`args = [${spec.args.map(tomlString).join(", ")}]`);
  }
  if (Object.keys(spec.env).length) {
    lines.push(
      `env = { ${Object.entries(spec.env)
        .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
        .join(", ")} }`
    );
  }
  return lines.join("\n");
}

export class CodexRegistrar extends MCPRegistrar {
  static agentName   = "codex";
  static displayName = "Codex";

  detect() {
    return existsSync(CONFIG_DIR) || existsSync(CONFIG_PATH);
  }

  getServer(serverName) {
    const content = this._readFile();
    if (!content) return null;
    const block = this._extractBlock(content);
    if (!block) return null;

    // Parse our own marker block only (we wrote it, shape is known).
    // Header: [mcp_servers.<name>]
    const headerRe = new RegExp(`^\\[mcp_servers\\.${escapeRe(serverName)}\\]$`, "m");
    if (!headerRe.test(block)) return null;

    const lines = block.split("\n").map((l) => l.trim());
    const command = unTomlString(lines.find((l) => l.startsWith("command ="))?.replace(/^command\s*=\s*/, ""));
    const argsLine = lines.find((l) => l.startsWith("args ="));
    const envLine  = lines.find((l) => l.startsWith("env ="));

    const args = argsLine
      ? (argsLine.match(/\[([\s\S]*)\]/)?.[1] ?? "")
          .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
          .map((s) => unTomlString(s.trim()))
          .filter((s) => s !== "")
      : [];

    const env = {};
    if (envLine) {
      const inner = envLine.match(/\{([\s\S]*)\}/)?.[1] ?? "";
      for (const pair of inner.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
        const m = pair.match(/"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/);
        if (m) env[unescapeToml(m[1])] = unescapeToml(m[2]);
      }
    }

    return new ServerSpec({ name: serverName, command: command ?? "", args, env });
  }

  registerServer(spec, { force = false } = {}) {
    const existing = this.getServer(spec.name);
    if (existing) {
      if (this._equivalent(existing, spec)) {
        return new RegisterResult(RegisterStatus.ALREADY);
      }
      if (!force) {
        return new RegisterResult(RegisterStatus.MISMATCH, "existing entry differs");
      }
    }

    // CX-3: distinguish "no file" (fine) from "unreadable file" (abort)
    let content = "";
    if (existsSync(CONFIG_PATH)) {
      const read = this._readFile();
      if (read === null) {
        return new RegisterResult(
          RegisterStatus.FAILED,
          `${CONFIG_PATH} exists but could not be read — refusing to overwrite`
        );
      }
      content = read;
    }

    const newBlock = `${MARKER_BEGIN}\n${entrySection(spec)}\n${MARKER_END}`;
    const newContent = content.includes(MARKER_BEGIN)
      ? content.replace(new RegExp(`${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}`, "g"), newBlock)
      : (content.trimEnd() ? content.trimEnd() + "\n\n" : "") + newBlock + "\n";

    try {
      writeAtomic(CONFIG_PATH, newContent); // CX-3
      return new RegisterResult(RegisterStatus.REGISTERED, `updated ${CONFIG_PATH}`);
    } catch (err) {
      return new RegisterResult(RegisterStatus.FAILED, err.message);
    }
  }

  unregisterServer(serverName) {
    if (!existsSync(CONFIG_PATH)) return false;
    const content = this._readFile();
    if (!content || !content.includes(MARKER_BEGIN)) return false;

    const newContent = content.replace(
      new RegExp(`\\n?\\n?${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}\\n?`, "g"),
      "\n"
    );
    if (newContent === content) return false; // CX-4: only write on change
    try {
      writeAtomic(CONFIG_PATH, newContent);
      return true;
    } catch {
      return false;
    }
  }

  _readFile() {
    try {
      return readFileSync(CONFIG_PATH, "utf-8").replace(/^\uFEFF/, "");
    } catch {
      return null;
    }
  }

  _extractBlock(toml) {
    const idx = toml.indexOf(MARKER_BEGIN);
    if (idx === -1) return null;
    const end = toml.indexOf(MARKER_END, idx);
    if (end === -1) return null;
    return toml.slice(idx + MARKER_BEGIN.length, end).trim();
  }

  _equivalent(a, b) {
    return a.command === b.command
      && JSON.stringify(a.args) === JSON.stringify(b.args)
      && JSON.stringify(a.env)  === JSON.stringify(b.env);
  }
}

// ── helpers ──
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unTomlString(s) {
  if (!s) return s ?? null;
  const m = String(s).trim().match(/^"((?:[^"\\]|\\.)*)"$/);
  return m ? unescapeToml(m[1]) : String(s).trim();
}

function unescapeToml(s) {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// CX-3: atomic write + backup
function writeAtomic(filePath, text) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    try { copyFileSync(filePath, `${filePath}.bak`); } catch { /* best effort */ }
  }
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, filePath);
}
