/**
 * core/config.js
 *
 * Config resolution with full source tracking.
 * Precedence (highest wins):
 *   CLI flags > CF_* env vars > ./.contextforge.toml > ~/.contextforge/config.toml > defaults
 *
 * resolveConfig() returns { values, sources } where sources[key] tells you
 * exactly which layer supplied each value — printed by `cf config`.
 *
 * toEnv() materializes the resolved config into the CF_* env vars that
 * server.js already reads, so the server needs no config-file code at all.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { globalConfigPath, projectConfigPath, cfHome } from "./paths.js";
import { CFError } from "../ui/errors.js";

// ── Schema: every known key, its default, type, and the CF_* env var it maps to ──
export const SCHEMA = {
  "proxy.port":                { def: 3000,        type: "port",   env: "CF_PORT" },
  "proxy.mode":                { def: "full",      type: "enum",   env: "CF_MODE",
                                 values: ["full", "passthrough"],
                                 // server.js checks CF_MODE === "passthrough"; "full" = unset
                                 envMap: (v) => (v === "full" ? undefined : v) },
  // "ollama" is the tested v1 default: Claude Code (client) → proxy → Ollama
  // (upstream, OpenAI-compatible). CF_PROVIDER names the UPSTREAM, not the client.
  "provider.name":             { def: "ollama",    type: "string", env: "CF_PROVIDER" },
  "provider.model_override":   { def: null,        type: "string", env: "CF_MODEL_OVERRIDE" },
  "compression.ccr":           { def: true,        type: "bool",   env: "CF_CCR_ENABLED",
                                 // server.js checks CF_CCR_ENABLED === "false"
                                 envMap: (v) => (v ? undefined : "false") },
  "compression.nudge_tools":   { def: true,       type: "bool",   env: "CF_NUDGE_TOOLS",
                                 envMap: (v) => (v ? "1" : undefined) },
  "logging.file":              { def: false,      type: "bool",   env: "CF_LOGGING_FILE",
                                 envMap: (v) => (v ? "1" : undefined) },
  // NOTE: CF_DEBUG_* env vars still work (server reads them directly) but are
  // intentionally NOT part of the user-facing config surface.
};

const FLAG_TO_KEY = {
  port: "proxy.port",
  mode: "proxy.mode",
  provider: "provider.name",
  model: "provider.model_override",
};

// ── Coercion & validation ─────────────────────────────────────────────────────

function coerce(key, raw, sourceLabel) {
  const spec = SCHEMA[key];
  if (!spec) {
    throw new CFError("CF_ERR_CONFIG_KEY", `Unknown config key "${key}" (from ${sourceLabel})`,
      `Valid keys: ${Object.keys(SCHEMA).join(", ")}`);
  }
  if (raw === null || raw === undefined) return raw;

  switch (spec.type) {
    case "port": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new CFError("CF_ERR_CONFIG_VALUE",
          `"${key}" must be a port number 0-65535, got "${raw}" (from ${sourceLabel})`,
          "Use 0 to auto-pick a free port.");
      }
      return n;
    }
    case "bool": {
      if (typeof raw === "boolean") return raw;
      const s = String(raw).toLowerCase();
      if (["true", "1", "yes", "on"].includes(s)) return true;
      if (["false", "0", "no", "off"].includes(s)) return false;
      throw new CFError("CF_ERR_CONFIG_VALUE",
        `"${key}" must be true/false, got "${raw}" (from ${sourceLabel})`);
    }
    case "enum": {
      const s = String(raw);
      if (!spec.values.includes(s)) {
        throw new CFError("CF_ERR_CONFIG_VALUE",
          `"${key}" must be one of [${spec.values.join(", ")}], got "${raw}" (from ${sourceLabel})`);
      }
      return s;
    }
    default:
      return String(raw);
  }
}

function flattenToml(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flattenToml(v, key, out);
    else out[key] = v;
  }
  return out;
}

function loadTomlFile(file, label) {
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = parseToml(readFileSync(file, "utf8"));
  } catch (err) {
    throw new CFError("CF_ERR_CONFIG_PARSE", `Failed to parse ${file}: ${err.message}`,
      `Fix the TOML syntax or delete the file to regenerate defaults.`);
  }
  const flat = flattenToml(parsed);
  const out = {};
  for (const [key, raw] of Object.entries(flat)) out[key] = coerce(key, raw, label);
  return out;
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.workspace  absolute workspace path (for project config)
 * @param {object} opts.flags      commander opts, e.g. { port: "4000", mode: "full" }
 * @returns {{ values: object, sources: object }}
 */
export function resolveConfig({ workspace, flags = {} } = {}) {
  const values = {};
  const sources = {};

  // Layer 1: defaults
  for (const [key, spec] of Object.entries(SCHEMA)) {
    values[key] = spec.def;
    sources[key] = "default";
  }

  // Layer 2: global config
  for (const [key, v] of Object.entries(loadTomlFile(globalConfigPath(), "global config"))) {
    values[key] = v; sources[key] = "global";
  }

  // Layer 3: project config
  if (workspace) {
    const pc = projectConfigPath(workspace);
    for (const [key, v] of Object.entries(loadTomlFile(pc, "project config"))) {
      values[key] = v; sources[key] = "project";
    }
  }

  // Layer 4: CF_* env vars
  for (const [key, spec] of Object.entries(SCHEMA)) {
    if (spec.env && process.env[spec.env] !== undefined && process.env[spec.env] !== "") {
      values[key] = coerce(key, process.env[spec.env], `env ${spec.env}`);
      sources[key] = "env";
    }
  }

  // Layer 5: CLI flags
  for (const [flag, key] of Object.entries(FLAG_TO_KEY)) {
    if (flags[flag] !== undefined) {
      values[key] = coerce(key, flags[flag], `--${flag}`);
      sources[key] = "flag";
    }
  }

  return { values, sources };
}

/**
 * Materialize resolved config into the CF_* env vars server.js reads.
 * Also injects the path env vars (CF_WORKSPACE_PATH, CF_MODEL_DIR, CF_DATA_DIR).
 */
export function toEnv(values, { workspace, modelDir, dataDir } = {}) {
  const env = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    if (!spec.env) continue;
    const v = values[key];
    if (v === null || v === undefined) continue;
    const mapped = spec.envMap ? spec.envMap(v) : String(v);
    if (mapped !== undefined) env[spec.env] = mapped;
  }
  if (workspace) env.CF_WORKSPACE_PATH = workspace;
  if (modelDir)  env.CF_MODEL_DIR = modelDir;
  if (dataDir)   env.CF_DATA_DIR = dataDir;
  return env;
}

// ── Mutation (cf config set) ──────────────────────────────────────────────────

export function setConfigValue(key, rawValue, { project = false, workspace } = {}) {
  const value = coerce(key, rawValue, project ? "cf config set --project" : "cf config set");
  const file = project ? projectConfigPath(workspace ?? process.cwd()) : globalConfigPath();

  let doc = {};
  if (existsSync(file)) doc = parseToml(readFileSync(file, "utf8"));

  const parts = key.split(".");
  let node = doc;
  for (const p of parts.slice(0, -1)) {
    if (typeof node[p] !== "object" || node[p] === null) node[p] = {};
    node = node[p];
  }
  node[parts.at(-1)] = value;

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, stringifyToml(doc) + "\n");
  return { file, value };
}

/** True when no global config exists yet — triggers the first-run wizard. */
export function isFirstRun() {
  return !existsSync(globalConfigPath());
}

/**
 * Write the global config.toml.
 * @param {object} answers  { provider, modelOverride } from the wizard (optional)
 */
export function writeGlobalConfig({ provider = "ollama", modelOverride = null } = {}) {
  const file = globalConfigPath();
  mkdirSync(cfHome(), { recursive: true });
  writeFileSync(file, `# ContextForge global configuration
# Precedence: CLI flags > CF_* env > ./.contextforge.toml > this file > defaults
# Run \`cf config\` to see the fully resolved values.

[proxy]
port = 3000          # 0 = auto-pick a free port
mode = "full"        # full | passthrough

[provider]
# Upstream provider (where requests are SENT, not where they come from).
# Claude Code always talks to the proxy in Anthropic format; the proxy
# translates to the upstream's format.
name = "${provider}"      # ollama | openai | anthropic | groq | gemini
${modelOverride ? `model_override = "${modelOverride}"` : `# model_override = "qwen2.5-coder:14b"`}

[compression]
ccr = true
nudge_tools = true

[logging]
file = false         # set to true to write detailed terminal logs
`);
  return { file, created: true };
}

/** Write a default global config.toml if none exists (non-interactive path). */
export function ensureGlobalConfig() {
  const file = globalConfigPath();
  if (existsSync(file)) return { file, created: false };
  return writeGlobalConfig();
}
