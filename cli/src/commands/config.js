/**
 * cf config              — print resolved config with per-key source
 * cf config get <key>    — print one value (raw, script-friendly)
 * cf config set <k> <v>  — write to global (or --project) config.toml
 */

import { resolveConfig, setConfigValue, SCHEMA } from "../core/config.js";
import { resolveWorkspace, globalConfigPath, projectConfigPath } from "../core/paths.js";
import { header, dim, cyan, bold } from "../ui/output.js";
import { CFError } from "../ui/errors.js";

const SOURCE_COLOR = { flag: "flag", env: "env", project: "project", global: "global", default: "default" };

export function configShow(opts = {}) {
  const workspace = resolveWorkspace();
  const { values, sources } = resolveConfig({ workspace });

  if (opts.json) {
    console.log(JSON.stringify({ workspace, values, sources }, null, 2));
    return;
  }

  header("Resolved configuration");
  console.log(`  ${dim("workspace:")} ${workspace}`);
  console.log(`  ${dim("global:   ")} ${globalConfigPath()}`);
  console.log(`  ${dim("project:  ")} ${projectConfigPath(workspace)} ${dim("(optional)")}`);
  console.log("");
  const keyW = Math.max(...Object.keys(SCHEMA).map((k) => k.length)) + 2;
  for (const key of Object.keys(SCHEMA)) {
    const v = values[key] === null ? dim("(unset)") : bold(String(values[key]));
    console.log(`  ${key.padEnd(keyW)} ${v}  ${dim(`[${SOURCE_COLOR[sources[key]]}]`)}`);
  }
  console.log("");
}

export function configGet(key) {
  if (!SCHEMA[key]) {
    throw new CFError("CF_ERR_CONFIG_KEY", `Unknown config key "${key}"`,
      `Valid keys: ${Object.keys(SCHEMA).join(", ")}`);
  }
  const { values } = resolveConfig({ workspace: resolveWorkspace() });
  console.log(values[key] === null ? "" : String(values[key]));
}

export function configSet(key, value, opts = {}) {
  const workspace = resolveWorkspace();
  const { file, value: coerced } = setConfigValue(key, value, {
    project: !!opts.project, workspace,
  });
  console.log(`  ${cyan("✔")} ${key} = ${bold(String(coerced))} ${dim(`→ ${file}`)}`);
}
