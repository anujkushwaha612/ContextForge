// src/mcp/registrars/windsurf.js
// Windsurf uses ~/.windsurf/mcp.json — same shape as Cursor

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path   from "node:path";
import { MCPRegistrar, RegisterResult, RegisterStatus, ServerSpec } from "../base.js";

const HOME = process.env.HOME || process.env.USERPROFILE || "";

export class WindsurfRegistrar extends MCPRegistrar {
  static agentName   = "windsurf";
  static displayName = "Windsurf";

  constructor({ homeDir = HOME } = {}) {
    super();
    this._windsurfDir = path.join(homeDir, ".windsurf");
    this._configFile  = path.join(homeDir, ".windsurf", "mcp.json");
  }

  detect() {
    return existsSync(this._windsurfDir);
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
        env:     typeof entry.env === "object" && entry.env ? { ...entry.env } : {},
      });
    } catch {
      return null;
    }
  }

  registerServer(spec, { force = false } = {}) {
    const existing = this.getServer(spec.name);
    if (existing) {
      const same =
        existing.command === spec.command &&
        JSON.stringify(existing.args) === JSON.stringify(spec.args) &&
        JSON.stringify(existing.env)  === JSON.stringify(spec.env);
      if (same) return new RegisterResult(RegisterStatus.ALREADY);
      if (!force) return new RegisterResult(RegisterStatus.MISMATCH, "existing config differs");
    }

    try {
      mkdirSync(this._windsurfDir, { recursive: true });
      const config = existsSync(this._configFile)
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
      const config = JSON.parse(readFileSync(this._configFile, "utf-8"));
      if (!config?.mcpServers?.[serverName]) return false;
      delete config.mcpServers[serverName];
      writeFileSync(this._configFile, JSON.stringify(config, null, 2) + "\n");
      return true;
    } catch {
      return false;
    }
  }
}