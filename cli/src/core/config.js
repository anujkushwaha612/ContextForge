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
 *
 * Enhanced with provider validation for paid API support.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { globalConfigPath, projectConfigPath, cfHome } from "./paths.js";
import { CFError } from "../ui/errors.js";

// ── Provider Registry ───────────────────────────────────────────────────────
export const VALID_PROVIDERS = ["ollama", "anthropic", "openai", "groq", "gemini"];

// Provider-specific configuration requirements
const PROVIDER_REQUIREMENTS = {
  ollama: {
    name: "Ollama",
    envVars: [],
    supportsModelOverride: true,
    defaultModel: null,
    url: null,
    note: "Local models via Ollama (no API key required)",
  },
  anthropic: {
    name: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    supportsModelOverride: false, // Claude Code picks model via /model
    defaultModel: "claude-3-sonnet-20240229",
    url: "https://console.anthropic.com/",
    note: "Claude models via Anthropic API",
  },
  openai: {
    name: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    supportsModelOverride: true,
    defaultModel: "gpt-4o",
    url: "https://platform.openai.com/api-keys",
    note: "GPT models via OpenAI API",
  },
  groq: {
    name: "Groq",
    envVars: ["GROQ_API_KEY"],
    supportsModelOverride: true,
    defaultModel: "llama-3.1-70b-versatile",
    url: "https://console.groq.com/keys",
    note: "Fast inference for open models",
  },
  gemini: {
    name: "Google Gemini",
    envVars: ["GEMINI_API_KEY"],
    supportsModelOverride: true,
    defaultModel: "gemini-2.0-flash-exp",
    url: "https://aistudio.google.com/app/apikey",
    note: "Google Gemini models",
  },
};

// ── Schema: every known key, its default, type, and the CF_* env var it maps to ──
export const SCHEMA = {
  "proxy.port":                { def: 3000,        type: "port",   env: "CF_PORT" },
  "proxy.mode":                { def: "full",      type: "enum",   env: "CF_MODE",
                                 values: ["full", "passthrough"],
                                 // server.js checks CF_MODE === "passthrough"; "full" = unset
                                 envMap: (v) => (v === "full" ? undefined : v) },
  // "ollama" is the tested v1 default: Claude Code (client) → proxy → Ollama
  // (upstream, OpenAI-compatible). CF_PROVIDER names the UPSTREAM, not the client.
  "provider.name":             { def: "ollama",    type: "enum",   env: "CF_PROVIDER",
                                 values: VALID_PROVIDERS },
  "provider.model_override":   { def: null,        type: "string", env: "CF_MODEL_OVERRIDE" },
  "compression.nudge_tools":   { def: true,       type: "bool",   env: "CF_NUDGE_TOOLS",
                                 envMap: (v) => (v ? "1" : undefined) },
  "logging.file":              { def: false,      type: "bool",   env: "CF_LOGGING_FILE",
                                 envMap: (v) => (v ? "1" : undefined) },
  // NOTE: CF_DEBUG_* env vars still work (server reads them directly) but are
  // intentionally NOT part of the user-facing config surface.
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

const FLAG_TO_KEY = {
  port: "proxy.port",
  mode: "proxy.mode",
  provider: "provider.name",
  model: "provider.model_override",
};

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

// ── Provider Validation ───────────────────────────────────────────────────────

/**
 * Get provider requirements/metadata.
 * @param {string} providerName
 * @returns {object|null}
 */
export function getProviderRequirements(providerName) {
  return PROVIDER_REQUIREMENTS[providerName] || null;
}

/**
 * Validate that a provider name is valid.
 * @param {string} provider
 * @throws {CFError} if invalid
 */
export function validateProviderName(provider) {
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new CFError(
      "CF_ERR_PROVIDER_INVALID",
      `Invalid provider "${provider}"`,
      `Valid providers: ${VALID_PROVIDERS.join(", ")}`
    );
  }
}

/**
 * Validate that required environment variables are set for a provider.
 * @param {string} provider - Provider name
 * @param {boolean} throwOnError - Whether to throw on missing vars (default: false)
 * @returns {{ ok: boolean, missing: string[], provider: string }}
 */
export function validateProviderEnvVars(provider, throwOnError = false) {
  const requirements = PROVIDER_REQUIREMENTS[provider];
  if (!requirements) {
    if (throwOnError) {
      throw new CFError("CF_ERR_PROVIDER_INVALID", `Unknown provider: ${provider}`);
    }
    return { ok: false, missing: [], provider, error: "Unknown provider" };
  }

  const missing = requirements.envVars.filter(varName => !process.env[varName]);
  const ok = missing.length === 0;

  if (!ok && throwOnError && missing.length > 0) {
    const url = requirements.url ? `\n  Get your key: ${requirements.url}` : "";
    throw new CFError(
      "CF_ERR_API_KEY_MISSING",
      `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      `${requirements.note}${url}\n  Set it with: export ${missing[0]}=your_key_here`
    );
  }

  return { ok, missing, provider };
}

/**
 * Validate current provider configuration (name + env vars).
 * @param {object} configValues - Resolved config values
 * @param {boolean} throwOnError - Whether to throw on errors
 * @returns {{ ok: boolean, provider: string, missingEnvVars: string[], errors: string[] }}
 */
export function validateProvider(configValues, throwOnError = false) {
  const provider = configValues["provider.name"];
  const errors = [];
  
  // Validate provider name
  if (!VALID_PROVIDERS.includes(provider)) {
    errors.push(`Invalid provider: ${provider}`);
    if (throwOnError) {
      throw new CFError("CF_ERR_PROVIDER_INVALID", `Invalid provider: ${provider}`,
        `Valid providers: ${VALID_PROVIDERS.join(", ")}`);
    }
  }

  // Validate environment variables
  const envValidation = validateProviderEnvVars(provider, throwOnError);
  
  return {
    ok: errors.length === 0 && envValidation.ok,
    provider,
    missingEnvVars: envValidation.missing,
    errors,
  };
}

/**
 * Get all available providers with their metadata.
 * @returns {Array<{name: string, requiresApiKey: boolean, envVars: string[]}>}
 */
export function getAvailableProviders() {
  return Object.entries(PROVIDER_REQUIREMENTS).map(([name, req]) => ({
    name,
    displayName: req.name,
    requiresApiKey: req.envVars.length > 0,
    envVars: req.envVars,
    defaultModel: req.defaultModel,
    url: req.url,
    note: req.note,
  }));
}
