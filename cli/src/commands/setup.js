/**
 * commands/setup.js
 *
 * cf setup — first-run interactive wizard + environment preparation.
 *
 *   1. Provider wizard (first run or --reconfigure): upstream + model
 *   2. Create ~/.contextforge layout + write global config
 *   3. Download + verify models
 *   4. Verify native addon
 *
 * Non-interactive contexts (CI, pipes) skip the wizard and write defaults.
 * Also invoked automatically by wrap/start on first run.
 *
 * Enhanced with provider-specific guidance and API key validation.
 */

import { ensureLayout, modelsDir } from "../core/paths.js";
import {
  isFirstRun,
  writeGlobalConfig,
  ensureGlobalConfig,
  VALID_PROVIDERS,
  getProviderRequirements,
} from "../core/config.js";
import { ensureModels } from "../core/assets.js";
import { diagnoseNative } from "../core/native.js";
import { testProvider } from "../core/daemon.js";
import { header, ok, warn, info, fail, progressBar, dim, bold, cyan } from "../ui/output.js";
import { select, input, password, confirm, isInteractive } from "../ui/prompt.js";
import { CFError } from "../ui/errors.js";

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

/**
 * Show provider-specific guidance after selection.
 * @param {string} provider
 */
function showProviderGuidance(provider) {
  const requirements = getProviderRequirements(provider);
  if (!requirements) return;

  console.log("");
  info(bold(`${requirements.name} Provider Notes:`));

  if (requirements.envVars.length > 0) {
    info(
      dim(
        `• Required environment variable${requirements.envVars.length > 1 ? "s" : ""}: ${requirements.envVars.join(", ")}`
      )
    );
  }

  if (requirements.url) {
    info(dim(`• Get API key: ${requirements.url}`));
  }

  if (provider === "anthropic") {
    info(dim("• Model selection happens inside Claude Code (/model command)"));
  } else if (provider === "openai") {
    info(dim("• Model can be configured via model_override"));
  } else if (provider === "gemini") {
    info(dim("• Model can be configured via model_override"));
  } else if (provider === "ollama") {
    info(dim("• Local models - no API key required"));
    info(dim("• Pull models: ollama pull llama3.1, ollama pull qwen2.5-coder"));
  }

  console.log("");
}

/**
 * Validate and optionally test API key for a provider.
 * @param {string} provider
 * @returns {Promise<{valid: boolean, key: string|null}>}
 */
async function validateApiKey(provider) {
  const requirements = getProviderRequirements(provider);
  if (!requirements || requirements.envVars.length === 0) {
    return { valid: true, key: null }; // No API key needed (e.g., Ollama)
  }

  const envVar = requirements.envVars[0];
  let apiKey = process.env[envVar];

  // Check if API key is already set
  if (apiKey) {
    ok(`${envVar} found in environment`);

    // Ask if user wants to test it
    if (isInteractive()) {
      const shouldTest = await confirm(`Test API key connectivity?`, { default: true });
      if (shouldTest) {
        info(dim("Testing API key..."));
        const testResult = await testProvider(provider);
        if (testResult.ok) {
          ok(`API key validated (${testResult.latency}ms)`);
          return { valid: true, key: apiKey };
        } else {
          fail(`API key test failed: ${testResult.error}`);
          const proceed = await confirm("Continue anyway?", { default: false });
          if (!proceed) {
            return { valid: false, key: null };
          }
        }
      }
    }

    return { valid: true, key: apiKey };
  }

  // API key not set - offer to set it
  warn(`${envVar} not found in environment`);

  if (!isInteractive()) {
    return { valid: false, key: null };
  }

  const shouldSet = await confirm(`Would you like to set it now?`, { default: true });
  if (!shouldSet) {
    return { valid: false, key: null };
  }

  // Prompt for API key
  console.log("");
  apiKey = await password(`Enter your ${envVar}:`, {
    validate: (s) => (s.length > 0 ? true : "API key cannot be empty"),
  });

  if (!apiKey) {
    return { valid: false, key: null };
  }

  // CRITICAL: Set the API key in process.env BEFORE testing
  // testProvider reads from process.env, so we must set it there first
  process.env[envVar] = apiKey;

  // Test the API key
  info(dim("Testing API key..."));
  const testResult = await testProvider(provider);

  if (testResult.ok) {
    ok(`API key validated (${testResult.latency}ms)`);

    // Ask if user wants to save it to shell config
    const shouldSave = await confirm(`Save ${envVar} to ~/.bashrc for future sessions?`, {
      default: true,
    });
    if (shouldSave) {
      await saveEnvVarToShell(envVar, apiKey);
    }

    return { valid: true, key: apiKey };
  } else {
    fail(`API key test failed: ${testResult.error}`);
    const proceed = await confirm("Continue anyway?", { default: false });
    if (!proceed) {
      return { valid: false, key: null };
    }
    return { valid: true, key: apiKey };
  }
}

/**
 * Save environment variable to shell configuration file.
 * @param {string} varName
 * @param {string} value
 */
async function saveEnvVarToShell(varName, value) {
  const { appendFileSync, existsSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const home = os.homedir();

  // Windows: prefer PowerShell profile or .bashrc (if Git Bash)
  // macOS/Linux: .zshrc (default on modern macOS), .bashrc, .profile
  let shellConfigFiles;
  if (process.platform === "win32") {
    shellConfigFiles = [path.join(home, ".bashrc"), path.join(home, ".bash_profile")];
  } else {
    shellConfigFiles = [
      path.join(home, ".zshrc"),
      path.join(home, ".bashrc"),
      path.join(home, ".profile"),
    ];
  }

  // Find existing config file, or default to first option
  let configFile = shellConfigFiles.find((f) => existsSync(f));
  if (!configFile) {
    configFile = shellConfigFiles[0]; // create if none exist
  }

  try {
    // Check if the variable is already set in this file
    const { readFileSync } = await import("node:fs");
    let existing = "";
    try {
      existing = readFileSync(configFile, "utf8");
    } catch {}

    if (existing.includes(`export ${varName}=`)) {
      info(dim(`  ${varName} already in ${configFile} — updating value`));
      // Replace existing line
      const updated = existing
        .replace(new RegExp(`export\\s+${varName}="[^"]*"`, "g"), `export ${varName}="${value}"`)
        .replace(new RegExp(`export\\s+${varName}='[^']*'`, "g"), `export ${varName}="${value}"`)
        .replace(new RegExp(`export\\s+${varName}=[^\\s]+`, "g"), `export ${varName}="${value}"`);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(configFile, updated);
    } else {
      const exportLine = `\n# ContextForge API key (added by cf setup)\nexport ${varName}="${value}"\n`;
      appendFileSync(configFile, exportLine);
    }

    ok(`Saved ${varName} to ${configFile}`);
    if (process.platform === "win32") {
      info(dim(`  Restart your terminal, or run: source "${configFile}"`));
    } else {
      info(dim(`  Restart your terminal, or run: source ${configFile}`));
    }
  } catch (error) {
    warn(`Could not write to ${configFile}: ${error.message}`);
    info(dim(`  Set it manually: export ${varName}="${value}"`));
  }
}

/** The provider/model wizard. Returns { provider, modelOverride }. */
async function runWizard() {
  console.log("");
  console.log(`  ${bold("Welcome to ContextForge!")} Let's configure your upstream provider.`);
  console.log(`  ${dim("This is where your agent's requests are sent. You can change it")}`);
  console.log(`  ${dim("anytime with \`cf setup --reconfigure\` or \`cf config set\`.")}`);
  console.log("");

  const provider = await select("Which upstream provider will you use?", [
    {
      value: "ollama",
      label: "Ollama",
      hint: "local or cloud models, OpenAI-compatible (recommended)",
    },
    { value: "anthropic", label: "Anthropic", hint: "Claude models via your Anthropic account" },
    { value: "openai", label: "OpenAI", hint: "GPT models via OpenAI API" },
    { value: "groq", label: "Groq", hint: "fast open-model inference" },
    { value: "gemini", label: "Gemini", hint: "Google AI Studio models" },
  ]);

  // Show provider-specific guidance
  showProviderGuidance(provider);

  let modelOverride = null;

  if (provider === "ollama") {
    // Show what's installed locally to help the user type the right name
    const models = await listOllamaModels();
    if (models === null) {
      info(dim("Ollama isn't running right now — that's fine, enter the model name anyway."));
    } else if (models.length) {
      info(
        `Detected local models: ${cyan(models.slice(0, 6).join(", "))}${models.length > 6 ? dim(` +${models.length - 6} more`) : ""}`
      );
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
    const requirements = getProviderRequirements(provider);
    modelOverride = await input(`Model override for ${provider} (enter to skip):`, {
      def: requirements?.defaultModel || null,
    });
  }

  // Validate API key if needed
  if (provider !== "ollama") {
    const keyResult = await validateApiKey(provider);

    if (!keyResult.valid && isInteractive()) {
      console.log("");
      warn("API key configuration incomplete");
      const proceed = await confirm("Continue setup anyway?", { default: false });
      if (!proceed) {
        console.log("");
        info("Setup cancelled. Run `cf setup` again when ready.");
        process.exit(0);
      }
    }
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
    ok(
      `Config written ${dim(file)} — provider: ${bold(answers.provider)}${answers.modelOverride ? ` · model: ${bold(answers.modelOverride)}` : ""}`
    );
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
        case "skip":
          ok(`${ev.asset.label} — verified, skipping`);
          break;
        case "invalid":
          warn(`${ev.asset.name}: ${ev.reason} — re-downloading`);
          break;
        case "start":
          bar = progressBar(ev.asset.name);
          break;
        case "progress":
          bar?.update(ev.received, ev.total);
          break;
        case "done":
          bar?.finish(`${ev.asset.label} — downloaded & verified`);
          bar = null;
          break;
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
  ok(
    native.ok
      ? "Setup complete — try `cf doctor` or `cf wrap claude`"
      : "Setup partially complete — fix the native addon, then run `cf doctor`"
  );
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
