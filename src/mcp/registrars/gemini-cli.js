// src/mcp/registrars/gemini-cli.js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path   from "node:path";
import { MCPRegistrar, RegisterResult, RegisterStatus, ServerSpec } from "../base.js";

const HOME        = process.env.HOME || process.env.USERPROFILE || "";
const CONFIG_DIR  = path.join(HOME, ".gemini");
const CONFIG_FILE = path.join(CONFIG_DIR, "mcp.json");

export class GeminiCLIRegistrar extends MCPRegistrar {
  static agentName   = "gemini-cli";
  static displayName = "Gemini CLI";

  detect() {
    return existsSync(CONFIG_DIR);
  }

  getServer(serverName) {
    if (!existsSync(CONFIG_FILE)) return null;
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      const entry  = config?.mcpServers?.[serverName];
      if (!entry) return null;
      return new ServerSpec({
        name:    serverName,
        command: String(entry.command || ""),
        args:    Array.isArray(entry.args) ? entry.args.map(String) : [],
        env:     typeof entry.env === "object" ? { ...entry.env } : {},
      });
    } catch { return null; }
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
    }

    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      const config  = existsSync(CONFIG_FILE)
        ? JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
        : {};
      config.mcpServers = config.mcpServers || {};
      config.mcpServers[spec.name] = {
        command: spec.command,
        ...(spec.args.length ? { args: spec.args } : {}),
        ...(Object.keys(spec.env).length ? { env: spec.env } : {}),
      };
      writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
      return new RegisterResult(RegisterStatus.REGISTERED, `wrote to ${CONFIG_FILE}`);
    } catch (err) {
      return new RegisterResult(RegisterStatus.FAILED, err.message);
    }
  }

  unregisterServer(serverName) {
    if (!existsSync(CONFIG_FILE)) return false;
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      if (!config?.mcpServers?.[serverName]) return false;
      delete config.mcpServers[serverName];
      writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
      return true;
    } catch { return false; }
  }

  _equivalent(a, b) {
    return a.command === b.command
      && JSON.stringify(a.args) === JSON.stringify(b.args)
      && JSON.stringify(a.env)  === JSON.stringify(b.env);
  }
}