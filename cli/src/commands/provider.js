/**
 * commands/provider.js
 *
 * cf provider list   — show all available providers and their requirements
 * cf provider status — check current provider configuration and connectivity
 *
 * Helps users understand which providers are available and what's needed
 * to use each one.
 */

import { resolveConfig, getProviderRequirements, getAvailableProviders, validateProvider } from "../core/config.js";
import { testProvider } from "../core/daemon.js";
import { header, ok, fail, info, dim, bold } from "../ui/output.js";
import { CFError } from "../ui/errors.js";

/**
 * cf provider list — show all available providers
 */
export async function providerList(opts = {}) {
  const providers = getAvailableProviders();

  if (opts.json) {
    console.log(JSON.stringify({ providers }, null, 2));
    return;
  }

  header("Available Providers");
  console.log("");

  for (const provider of providers) {
    console.log(`  ${bold(provider.displayName)} ${dim(`(${provider.name})`)}`);
    
    if (provider.requiresApiKey) {
      info(`  Requires: ${provider.envVars.join(", ")}`);
      if (provider.url) {
        info(`  Get API key: ${provider.url}`);
      }
    } else {
      info(`  No API key required (local models)`);
    }
    
    if (provider.defaultModel) {
      info(`  Default model: ${provider.defaultModel}`);
    }
    
    if (provider.note) {
      info(dim(`  ${provider.note}`));
    }
    
    console.log("");
  }

  info("Use `cf config set provider.name <name>` to switch providers");
  info("Use `cf provider status` to check current provider configuration");
  console.log("");
}

/**
 * cf provider status — check current provider configuration
 */
export async function providerStatus(opts = {}) {
  const { values } = resolveConfig({ workspace: process.cwd() });
  const provider = values["provider.name"];
  const model = values["provider.model_override"];

  if (opts.json) {
    const result = {
      provider,
      model,
      configured: false,
      valid: false,
      connectivity: null,
    };

    try {
      const validation = validateProvider(values, false);
      result.configured = validation.ok;
      result.valid = validation.ok;

      if (validation.ok) {
        const testResult = await testProvider(provider, { timeout: 10000 });
        result.connectivity = {
          ok: testResult.ok,
          latency: testResult.latency,
          error: testResult.error,
        };
      } else {
        result.errors = validation.errors;
        result.missingEnvVars = validation.missingEnvVars;
      }
    } catch (error) {
      result.error = error.message;
    }

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  header("Provider Status");
  console.log("");

  info(`Current provider: ${bold(provider)}`);
  if (model) {
    info(`Model override: ${model}`);
  }
  console.log("");

  // Validate configuration
  const validation = validateProvider(values, false);

  if (!validation.ok) {
    fail("Configuration invalid");
    
    if (validation.errors.length > 0) {
      for (const error of validation.errors) {
        info(dim(`  ✖ ${error}`));
      }
    }
    
    if (validation.missingEnvVars.length > 0) {
      info(dim(`  ✖ Missing environment variables: ${validation.missingEnvVars.join(", ")}`));
      const requirements = getProviderRequirements(provider);
      if (requirements?.url) {
        info(dim(`  Get API key: ${requirements.url}`));
      }
    }
    
    console.log("");
    info("Run `cf setup --reconfigure` to configure a provider");
    process.exitCode = 1;
    return;
  }

  ok("Configuration valid");

  // Test connectivity
  info(dim("Testing connectivity..."));
  
  try {
    const testResult = await testProvider(provider, { 
      model,
      timeout: 10000 
    });

    if (testResult.ok) {
      ok(`Connected (${testResult.latency}ms)`);
      
      if (testResult.model) {
        info(`Model: ${testResult.model}`);
      }
      
      if (testResult.models && testResult.models.length > 0) {
        info(`Available models: ${testResult.models.length}`);
      }
      
      console.log("");
      ok("Provider is ready to use");
    } else {
      fail("Connection failed");
      info(dim(`  Error: ${testResult.error}`));
      
      if (provider === "ollama") {
        info(dim("  Make sure Ollama is running: ollama serve"));
      } else if (testResult.error.includes("401") || testResult.error.includes("403")) {
        info(dim("  API key appears invalid or expired"));
        const requirements = getProviderRequirements(provider);
        if (requirements?.url) {
          info(dim(`  Get a new key: ${requirements.url}`));
        }
      }
      
      console.log("");
      fail("Provider is not ready");
      process.exitCode = 1;
    }
  } catch (error) {
    fail(`Connection test failed: ${error.message}`);
    process.exitCode = 1;
  }

  console.log("");
}
