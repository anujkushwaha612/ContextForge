// src/mcp/registrars/gemini-cli.js — FIXED VERSION
//
// Fixes (GM-1 … GM-4):
//
//   GM-1  WRONG CONFIG FILE (critical). Gemini CLI reads mcpServers from
//         ~/.gemini/settings.json — NOT ~/.gemini/mcp.json. Every
//         registration wrote a file Gemini CLI never opens ("registered"
//         but tools never appear). mcp.json kept as a legacy READ/REMOVE
//         candidate only.
//
//   GM-2  DATA-LOSS GUARD (critical — same disease as claude.js CR-3).
//         settings.json holds ALL user settings (model prefs, auth, theme).
//         registerServer parsed it and, on corruption, the old pattern
//         would either throw raw or (via a {} fallback) overwrite the
//         whole file. Now: corrupt-but-existing file aborts with a clear
//         error; writes are atomic (tmp+rename) with a .bak.
//
//   GM-3  os.homedir() instead of HOME||USERPROFILE||"" (empty string
//         made paths relative to cwd).
//
//   GM-4  BOM stripped on read (Windows editors); env values coerced to
//         strings on read for stable _equivalent comparison.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCPRegistrar, RegisterResult, RegisterStatus, ServerSpec } from "../base.js";

const HOME         = os.homedir();                        // GM-3
const CONFIG_DIR   = path.join(HOME, ".gemini");
const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json"); // GM-1: the real file
const LEGACY_FILE   = path.join(CONFIG_DIR, "mcp.json");      // read/remove only

export class GeminiCLIRegistrar extends MCPRegistrar {
  static agentName   = "gemini-cli";
  static displayName = "Gemini CLI";

  detect() {
    return existsSync(CONFIG_DIR);
  }

  getServer(serverName) {
    for (const file of [SETTINGS_FILE, LEGACY_FILE]) {
      const entry = this._readEntry(file, serverName);
      if (entry) return entry;
    }
    return null;
  }

  registerServer(spec, { force = false } = {}) {
    const existing = this.getServer(spec.name);
    if (existing) {
      if (this._equivalent(existing, spec)) {
        return new RegisterResult(RegisterStatus.ALREADY);
      }
      if (!force) {
        return new RegisterResult(RegisterStatus.MISMATCH, "entry exists but differs");
      }
      this.unregisterServer(spec.name); // clears legacy copies too
    }

    // GM-2: corrupt settings.json must ABORT, never be overwritten
    let config;
    try {
      config = readJsonStrict(SETTINGS_FILE);
    } catch (err) {
      return new RegisterResult(
        RegisterStatus.FAILED,
        `${SETTINGS_FILE} exists but is not valid JSON (${err.message.split("\n")[0]}) — ` +
        `refusing to overwrite it. Fix or back up the file, then retry.`
      );
    }

    try {
      config.mcpServers = config.mcpServers || {};
      config.mcpServers[spec.name] = {
        command: spec.command,
        ...(spec.args.length ? { args: spec.args } : {}),
        ...(Object.keys(spec.env).length ? { env: spec.env } : {}),
      };
      writeJsonAtomic(SETTINGS_FILE, config); // GM-2
      return new RegisterResult(RegisterStatus.REGISTERED, `wrote to ${SETTINGS_FILE}`);
    } catch (err) {
      return new RegisterResult(RegisterStatus.FAILED, err.message);
    }
  }

  unregisterServer(serverName) {
    let removed = false;
    for (const file of [SETTINGS_FILE, LEGACY_FILE]) {
      if (!existsSync(file)) continue;
      try {
        const config = readJsonStrict(file); // GM-2: never wipe corrupt files
        if (!config?.mcpServers?.[serverName]) continue;
        delete config.mcpServers[serverName];
        writeJsonAtomic(file, config);
        removed = true;
      } catch {
        /* corrupt or unwritable — leave it alone */
      }
    }
    return removed;
  }

  _readEntry(file, serverName) {
    if (!existsSync(file)) return null;
    try {
      const config = readJsonStrict(file);
      const entry  = config?.mcpServers?.[serverName];
      if (!entry || typeof entry !== "object") return null;
      return new ServerSpec({
        name:    serverName,
        command: String(entry.command || ""),
        args:    Array.isArray(entry.args) ? entry.args.map(String) : [],
        env:     typeof entry.env === "object" && entry.env
          ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)])) // GM-4
          : {},
      });
    } catch {
      return null;
    }
  }

  _equivalent(a, b) {
    return a.command === b.command
      && JSON.stringify(a.args) === JSON.stringify(b.args)
      && JSON.stringify(a.env)  === JSON.stringify(b.env);
  }
}

// ── helpers (same semantics as claude.js fixed) ──
function readJsonStrict(filePath) {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf-8").replace(/^\uFEFF/, ""); // GM-4
  if (raw.trim() === "") return {};
  return JSON.parse(raw); // throws on corrupt — caller decides
}

function writeJsonAtomic(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    try { copyFileSync(filePath, `${filePath}.bak`); } catch { /* best effort */ }
  }
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, filePath);
}
