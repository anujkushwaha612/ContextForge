// src/mcp/registrars/cursor.js
// Cursor stores MCP config in ~/.cursor/mcp.json
// Same JSON shape as Claude's legacy mcp.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path   from "node:path";
import { MCPRegistrar, RegisterResult, RegisterStatus, ServerSpec } from "../base.js";

const HOME = process.env.HOME || process.env.USERPROFILE || "";

export class CursorRegistrar extends MCPRegistrar {
  static agentName   = "cursor";
  static displayName = "Cursor";

  constructor({ homeDir = HOME } = {}) {
    super();
    this._cursorDir  = path.join(homeDir, ".cursor");
    this._configFile = path.join(homeDir, ".cursor", "mcp.json");
  }

  detect() {
    return existsSync(this._cursorDir);
  }

  getServer(serverName) {
    if (!existsSync(this._configFile)) return null;
    try {
      const config = JSON.parse(readFileSync(this._configFile, "utf-8"));
      const entry  = config?.mcpServers?.[serverName];
      if (!entry) return null;
      return new ServerSpec({
        name:    serverName,
        command: String(entry.command || ""),
        args:    Array.isArray(entry.args) ? entry.args.map(String) : [],
        env:     typeof entry.env === "object" && entry.env
          ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)]))
          : {},
      });
    } catch {
      return null;
    }
  }

  registerServer(spec, { force = false } = {}) {
    const existing = this.getServer(spec.name);

    if (existing) {
      if (this._equivalent(existing, spec)) {
        return new RegisterResult(RegisterStatus.ALREADY, "matches current configuration");
      }
      if (!force) {
        return new RegisterResult(RegisterStatus.MISMATCH, "existing config differs");
      }
    }

    try {
      mkdirSync(this._cursorDir, { recursive: true });
      const config  = existsSync(this._configFile)
        ? JSON.parse(readFileSync(this._configFile, "utf-8"))
        : {};
      config.mcpServers = config.mcpServers || {};
      config.mcpServers[spec.name] = {
        command: spec.command,
        ...(spec.args.length ? { args: spec.args } : {}),
        ...(Object.keys(spec.env).length ? { env: spec.env } : {}),
      };
      writeFileSync(this._configFile, JSON.stringify(config, null, 2) + "\n");
      return new RegisterResult(RegisterStatus.REGISTERED, `wrote to ${this._configFile}`);
    } catch (err) {
      return new RegisterResult(RegisterStatus.FAILED, err.message);
    }
  }

  unregisterServer(serverName) {
    if (!existsSync(this._configFile)) return false;
    try {
      const config  = JSON.parse(readFileSync(this._configFile, "utf-8"));
      if (!config?.mcpServers?.[serverName]) return false;
      delete config.mcpServers[serverName];
      writeFileSync(this._configFile, JSON.stringify(config, null, 2) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  _equivalent(a, b) {
    return (
      a.command === b.command &&
      JSON.stringify(a.args) === JSON.stringify(b.args) &&
      JSON.stringify(a.env)  === JSON.stringify(b.env)
    );
  }
}