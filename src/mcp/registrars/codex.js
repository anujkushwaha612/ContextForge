// src/mcp/registrars/codex.js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path         from "node:path";
import { MCPRegistrar, RegisterResult, RegisterStatus, ServerSpec } from "../base.js";

const HOME          = process.env.HOME || process.env.USERPROFILE || "";
const CONFIG_PATH   = path.join(HOME, ".codex", "config.toml");
const MARKER_BEGIN  = `# --- contextforge begin ---`;
const MARKER_END    = `# --- contextforge end ---`;
const ENTRY_SECTION = (server) => `
[[mcp]]
name = "${server.name}"
command = "${server.command}"
${server.args.length ? `args = [${server.args.map(a => `"${a}"`).join(", ")}]` : ""}
${Object.keys(server.env).length
  ? `env = { ${Object.entries(server.env)
      .map(([k, v]) => `${k} = "${v}"`)
      .join(", ")} }`
  : ""}
`.trim();

export class CodexRegistrar extends MCPRegistrar {
  static agentName   = "codex";
  static displayName = "Codex";

  detect() {
    return existsSync(CONFIG_PATH);
  }

  getServer(serverName) {
    const content = this._readFile();
    if (!content) return null;
    const block = this._extractBlock(content);
    if (!block) return null;
    // crude TOML parser: look for [[mcp]] sections with matching name
    const sections = block.split(/^\[\[mcp\]\]$/m);
    for (const section of sections) {
      const lines = section.split("\n").map(l => l.trim());
      const nameMatch = lines.find(l => l.startsWith("name ="));
      if (!nameMatch) continue;
      const name = nameMatch.match(/"([^"]+)"/)?.[1];
      if (name !== serverName) continue;
      const cmdMatch = lines.find(l => l.startsWith("command ="));
      const argsMatch = lines.find(l => l.startsWith("args ="));
      const envMatch = lines.find(l => l.startsWith("env ="));
      const command = cmdMatch?.match(/"([^"]+)"/)?.[1] || "";
      const args = argsMatch ? argsMatch.match(/\[([^\]]*)\]/)?.[1]
        .split(",").map(s => s.trim().replace(/^"|"$/g, "")) : [];
      const env = envMatch ? this._parseEnv(envMatch) : {};
      return new ServerSpec({ name, command, args, env });
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
        return new RegisterResult(RegisterStatus.MISMATCH, "existing entry differs");
      }
    }

    const content = this._readFile() || "";
    const block   = ENTRY_SECTION(spec);
    const newBlock = `${MARKER_BEGIN}\n${block}\n${MARKER_END}`;

    let newContent;
    if (content.includes(MARKER_BEGIN)) {
      newContent = content.replace(
        new RegExp(`${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}`, "g"),
        newBlock
      );
    } else {
      newContent = content.trimEnd() + "\n\n" + newBlock + "\n";
    }

    try {
      mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, newContent, "utf-8");
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
      new RegExp(`${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}\n?`, "g"),
      ""
    );
    writeFileSync(CONFIG_PATH, newContent, "utf-8");
    return true;
  }

  _readFile() {
    try {
      return readFileSync(CONFIG_PATH, "utf-8");
    } catch { return null; }
  }

  _extractBlock(toml) {
    const idx = toml.indexOf(MARKER_BEGIN);
    if (idx === -1) return null;
    const end = toml.indexOf(MARKER_END, idx);
    if (end === -1) return null;
    return toml.slice(idx + MARKER_BEGIN.length, end).trim();
  }

  _parseEnv(line) {
    const jsonLike = line.replace(/env\s*=\s*/, "")
      .replace(/(\w+)\s*=\s*"([^"]*)"/g, '"$1":"$2"')
      .replace(/'/g, '"');
    try { return JSON.parse(jsonLike); } catch { return {}; }
  }

  _equivalent(a, b) {
    return a.command === b.command
      && JSON.stringify(a.args) === JSON.stringify(b.args)
      && JSON.stringify(a.env)  === JSON.stringify(b.env);
  }
}