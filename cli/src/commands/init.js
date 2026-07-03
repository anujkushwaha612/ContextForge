/**
 * cf init — write ./.contextforge.toml for the current project.
 * Interactive-lite: takes flags, falls back to current resolved values.
 * This is the per-project answer to "I don't want to edit .env".
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolveConfig } from "../core/config.js";
import { resolveWorkspace, projectConfigPath } from "../core/paths.js";
import { ok, warn, info, dim } from "../ui/output.js";

export async function init(opts = {}) {
  const workspace = resolveWorkspace();
  const file = projectConfigPath(workspace);

  if (existsSync(file) && !opts.force) {
    warn(`${file} already exists (use --force to overwrite)`);
    return;
  }

  const { values } = resolveConfig({ workspace, flags: opts });
  const provider = values["provider.name"];
  const model = values["provider.model_override"];

  writeFileSync(
    file,
    `# ContextForge project configuration
# Overrides ~/.contextforge/config.toml for this repository only.
# Safe to commit — teammates get the same setup.
# Workspace path is NOT stored here: it's always where you run \`cf wrap\`.

[provider]
name = "${provider}"
${model ? `model_override = "${model}"` : `# model_override = "qwen2.5-coder:14b"`}

# [proxy]
# port = 3000
# mode = "full"
`
  );

  ok(`Created ${file}`);
  info(`provider ${provider}${model ? ` · model ${model}` : ""}`);
  info(dim("Edit values or use: cf config set provider.name openai --project"));
}
