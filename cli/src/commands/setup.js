/**
 * cf setup — first-run interactive wizard + environment preparation.
 *
 *   1. Provider wizard (first run or --reconfigure): upstream + model
 *   2. Create ~/.contextforge layout + write global config
 *   3. Download + verify models
 *   4. Verify native addon
 *
 * Non-interactive contexts (CI, pipes) skip the wizard and write defaults.
 * Also invoked automatically by wrap/start on first run.
 */

import { ensureLayout, modelsDir } from "../core/paths.js";
import { isFirstRun, writeGlobalConfig, ensureGlobalConfig } from "../core/config.js";
import { ensureModels } from "../core/assets.js";
import { diagnoseNative } from "../core/native.js";
import { header, ok, warn, info, progressBar, dim, bold, cyan } from "../ui/output.js";
import { select, input, isInteractive } from "../ui/prompt.js";

/** Probe local Ollama for installed models (best effort, 2s budget). */
async function listOllamaModels() {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return null; // ollama not running — fine
  }
}

/** The provider/model wizard. Returns { provider, modelOverride }. */
async function runWizard() {
  console.log("");
  console.log(`  ${bold("Welcome to ContextForge!")} Let's configure your upstream provider.`);
  console.log(`  ${dim("This is where your agent's requests are sent. You can change it")}`);
  console.log(`  ${dim("anytime with `cf setup --reconfigure` or `cf config set`.")}`);
  console.log("");

  const provider = await select("Which upstream provider will you use?", [
    { value: "ollama",    label: "Ollama",    hint: "local or cloud models, OpenAI-compatible (recommended)" },
    { value: "anthropic", label: "Anthropic", hint: "Claude models via your Anthropic account" },
    { value: "openai",    label: "OpenAI",    hint: "GPT models via OpenAI API" },
    { value: "groq",      label: "Groq",      hint: "fast open-model inference" },
    { value: "gemini",    label: "Gemini",    hint: "Google AI Studio models" },
  ]);

  let modelOverride = null;

  if (provider === "ollama") {
    // Show what's installed locally to help the user type the right name
    const models = await listOllamaModels();
    if (models === null) {
      info(dim("Ollama isn't running right now — that's fine, enter the model name anyway."));
    } else if (models.length) {
      info(`Detected local models: ${cyan(models.slice(0, 6).join(", "))}${models.length > 6 ? dim(` +${models.length - 6} more`) : ""}`);
    } else {
      info(dim("Ollama is running but has no models yet (pull one with `ollama pull ...`)."));
    }

    modelOverride = await input(
      "Model name (local or cloud, e.g. qwen2.5-coder:14b, minimax-m3:cloud):",
      {
        def: models?.[0] ?? null,
        validate: (s) =>
          s.length > 0 ? true : "A model name is required for Ollama (it has no default).",
      }
    );
  } else if (provider === "anthropic") {
    // Claude Code picks its own model via /model — no override needed.
    info(dim("Model selection is handled inside Claude Code (/model) — nothing to set here."));
  } else {
    // openai / groq / gemini: optional override
    modelOverride = await input(
      `Model override for ${provider} (enter to skip):`,
      { def: null }
    );
  }

  return { provider, modelOverride };
}

export async function setup(opts = {}) {
  header("ContextForge Setup");

  // 1. Layout
  const home = ensureLayout();
  ok(`Home directory ready ${dim(home)}`);

  // 2. Config — wizard on first run (or --reconfigure), defaults otherwise
  const firstRun = isFirstRun();
  if ((firstRun || opts.reconfigure) && isInteractive()) {
    const answers = await runWizard();
    const { file } = writeGlobalConfig(answers);
    ok(`Config written ${dim(file)} — provider: ${bold(answers.provider)}${answers.modelOverride ? ` · model: ${bold(answers.modelOverride)}` : ""}`);
  } else {
    const { file, created } = ensureGlobalConfig();
    if (created) {
      ok(`Created default config ${dim(file)} ${dim("(non-interactive — defaults applied)")}`);
      info(dim("Run `cf setup --reconfigure` anytime for the interactive wizard."));
    } else {
      ok(`Config exists ${dim(file)} ${dim("(use --reconfigure to change provider/model)")}`);
    }
  }

  // 3. Models
  let bar = null;
  await ensureModels({
    force: opts.force ?? false,
    onEvent: (ev) => {
      switch (ev.type) {
        case "skip": ok(`${ev.asset.label} — verified, skipping`); break;
        case "invalid": warn(`${ev.asset.name}: ${ev.reason} — re-downloading`); break;
        case "start": bar = progressBar(ev.asset.name); break;
        case "progress": bar?.update(ev.received, ev.total); break;
        case "done": bar?.finish(`${ev.asset.label} — downloaded & verified`); bar = null; break;
      }
    },
  });
  info(`Models in ${modelsDir()}`);

  // 4. Native addon (informational here; doctor gives full detail)
  const native = diagnoseNative();
  if (native.ok) {
    ok(`Native addon loads (${native.kind}) ${dim(native.path)}`);
  } else {
    warn(`Native addon: ${native.error}`);
    if (native.hint) info(native.hint);
  }

  console.log("");
  ok(native.ok ? "Setup complete — try `cf doctor` or `cf wrap claude`"
               : "Setup partially complete — fix the native addon, then run `cf doctor`");
  console.log("");
  return native.ok;
}

/**
 * First-run gate for wrap/start: if no global config exists, run the full
 * setup (wizard included) before proceeding.
 */
export async function ensureFirstRunSetup() {
  if (!isFirstRun()) return true;
  info(dim("First run detected — running setup..."));
  return setup({});
}
