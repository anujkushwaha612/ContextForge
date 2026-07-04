/**
 * commands/config.js
 *
 * cf config show              — print resolved config with per-key source
 * cf config get <key>         — print one value (raw, script-friendly)
 * cf config set <k> <v>       — write to global (or --project) config.toml
 * cf config validate          — validate current configuration
 *
 * Enhanced with provider validation for paid API support.
 */

import { resolveConfig, setConfigValue, SCHEMA, validateProvider, getProviderRequirements, VALID_PROVIDERS } from "../core/config.js";
import { testProvider } from "../core/daemon.js";
import { resolveWorkspace, globalConfigPath, projectConfigPath } from "../core/paths.js";
import { header, dim, cyan, bold, ok, fail, info } from "../ui/output.js";
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
  
  // Validate provider name
  if (key === "provider.name") {
    if (!VALID_PROVIDERS.includes(value)) {
      throw new CFError(
        "CF_ERR_PROVIDER_INVALID",
        `Invalid provider "${value}"`,
        `Valid providers: ${VALID_PROVIDERS.join(", ")}\n  Example: cf config set provider.name ollama`
      );
    }
  }
  
  // Validate proxy mode
  if (key === "proxy.mode") {
    if (!["full", "passthrough"].includes(value)) {
      throw new CFError(
        "CF_ERR_CONFIG_VALUE",
        `Invalid proxy mode "${value}"`,
        `Valid modes: full, passthrough`
      );
    }
  }
  
  const { file, value: coerced } = setConfigValue(key, value, {
    project: !!opts.project, workspace,
  });
  console.log(`  ${cyan("✔")} ${key} = ${bold(String(coerced))} ${dim(`→ ${file}`)}`);
}

/**
 * Validate current configuration and optionally test provider connectivity.
 * @param {object} opts
 */
export async function configValidate(opts = {}) {
  const workspace = resolveWorkspace();
  const { values } = resolveConfig({ workspace });

  if (opts.json) {
    const result = {
      valid: true,
      provider: values["provider.name"],
      model: values["provider.model_override"],
      proxy: {
        port: values["proxy.port"],
        mode: values["proxy.mode"],
      },
      missingEnvVars: [],
      errors: [],
      connectivity: null,
    };

    // Validate provider
    const validation = validateProvider(values, false);
    result.valid = validation.ok;
    result.missingEnvVars = validation.missingEnvVars;
    result.errors = validation.errors;

    // Test connectivity if valid
    if (validation.ok && !opts.skipConnectivityTest) {
      try {
        const testResult = await testProvider(values["provider.name"], { timeout: 10000 });
        result.connectivity = {
          ok: testResult.ok,
          latency: testResult.latency,
          error: testResult.error,
        };
      } catch (error) {
        result.connectivity = { ok: false, error: error.message };
      }
    }

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  header("Configuration Validation");
  console.log("");

  let allValid = true;

  // Check provider name
  const provider = values["provider.name"];
  if (VALID_PROVIDERS.includes(provider)) {
    ok(`Provider: ${provider}`);
  } else {
    fail(`Invalid provider: ${provider}`);
    info(dim(`  Valid providers: ${VALID_PROVIDERS.join(", ")}`));
    info(dim(`  Fix with: cf config set provider.name ollama`));
    allValid = false;
  }

  // Check API key for paid providers
  const requirements = getProviderRequirements(provider);
  if (requirements && requirements.envVars.length > 0) {
    const missingEnvVars = requirements.envVars.filter(varName => !process.env[varName]);
    
    if (missingEnvVars.length === 0) {
      ok(`API key: ${requirements.envVars[0]} set`);
      
      // Test connectivity
      if (!opts.skipConnectivityTest) {
        info(dim("Testing connectivity..."));
        try {
          const testResult = await testProvider(provider, { timeout: 10000 });
          
          if (testResult.ok) {
            ok(`Connectivity: OK (${testResult.latency}ms)`);
          } else {
            fail(`Connectivity: ${testResult.error}`);
            
            if (provider === "ollama") {
              info(dim("  Make sure Ollama is running: ollama serve"));
            } else if (testResult.error.includes("401") || testResult.error.includes("403")) {
              info(dim("  API key appears invalid or expired"));
              if (requirements.url) {
                info(dim(`  Get a new key: ${requirements.url}`));
              }
            }
            
            allValid = false;
          }
        } catch (error) {
          fail(`Connectivity test failed: ${error.message}`);
          allValid = false;
        }
      }
    } else {
      fail(`API key missing: ${missingEnvVars.join(", ")}`);
      if (requirements.url) {
        info(dim(`  Get your key: ${requirements.url}`));
      }
      info(dim(`  Set it with: export ${missingEnvVars[0]}=your_key_here`));
      info(dim(`  Or run: cf setup --reconfigure`));
      allValid = false;
    }
  } else if (provider === "ollama") {
    // Test Ollama connectivity
    if (!opts.skipConnectivityTest) {
      info(dim("Testing Ollama connectivity..."));
      try {
        const testResult = await testProvider("ollama");
        
        if (testResult.ok) {
          ok(`Ollama: connected (${testResult.models?.length || 0} models)`);
        } else {
          fail(`Ollama: ${testResult.error}`);
          info(dim("  Make sure Ollama is running: ollama serve"));
          allValid = false;
        }
      } catch (error) {
        fail(`Ollama test failed: ${error.message}`);
        allValid = false;
      }
    }
  }

  // Check model override
  const model = values["provider.model_override"];
  if (model) {
    info(`Model override: ${model}`);
  }

  // Check proxy config
  console.log("");
  info(`Proxy mode: ${values["proxy.mode"]}`);
  info(`Proxy port: ${values["proxy.port"]}`);

  console.log("");
  if (allValid) {
    ok("Configuration is valid and ready to use");
  } else {
    fail("Configuration has issues — fix the errors above");
    process.exitCode = 1;
  }
  console.log("");
}
