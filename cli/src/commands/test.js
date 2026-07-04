/**
 * commands/test.js
 *
 * cf test — test provider connectivity and validate API key.
 * Quick way to verify your provider configuration before committing
 * to a full `cf wrap claude` session.
 *
 * Usage:
 *   cf test                    # test current provider
 *   cf test --provider groq    # test specific provider
 *   cf test --json             # machine-readable output
 */

import { resolveConfig, getProviderRequirements, VALID_PROVIDERS } from "../core/config.js";
import { testProvider } from "../core/daemon.js";
import { header, ok, fail, info, dim, bold } from "../ui/output.js";
import { CFError } from "../ui/errors.js";

export async function test(opts = {}) {
  const { values } = resolveConfig({ workspace: process.cwd() });
  const provider = opts.provider || values["provider.name"];
  const model = opts.model || values["provider.model_override"];

  if (!VALID_PROVIDERS.includes(provider)) {
    throw new CFError(
      "CF_ERR_PROVIDER_INVALID",
      `Invalid provider "${provider}"`,
      `Valid providers: ${VALID_PROVIDERS.join(", ")}`
    );
  }

  const requirements = getProviderRequirements(provider);

  if (!opts.json) {
    header("Provider Connectivity Test");
    info(`Testing ${bold(requirements.name)} connectivity...`);
    console.log("");
  }

  // Check API key for paid providers
  if (requirements.envVars.length > 0) {
    const missingEnvVars = requirements.envVars.filter(varName => !process.env[varName]);
    
    if (missingEnvVars.length > 0) {
      const envVarList = missingEnvVars.join(", ");
      const url = requirements.url ? `\n  Get your key: ${requirements.url}` : "";
      
      if (opts.json) {
        console.log(JSON.stringify({
          provider,
          ok: false,
          error: `Missing required environment variable${missingEnvVars.length > 1 ? 's' : ''}: ${envVarList}`,
          hint: `Set it with: export ${missingEnvVars[0]}=your_key_here`,
        }, null, 2));
      } else {
        fail(`Missing required environment variable${missingEnvVars.length > 1 ? 's' : ''}: ${envVarList}`);
        info(dim(`${requirements.note}${url}`));
        info(dim(`Set it with: export ${missingEnvVars[0]}=your_key_here`));
      }
      
      process.exitCode = 1;
      return;
    }
  }

  // Test provider connectivity
  try {
    const result = await testProvider(provider, { 
      model,
      timeout: opts.timeout || 10000 
    });

    if (opts.json) {
      console.log(JSON.stringify({
        provider,
        ok: result.ok,
        latency: result.latency,
        model: result.model,
        error: result.error,
        models: result.models, // For Ollama
      }, null, 2));
    } else {
      if (result.ok) {
        ok(`${requirements.name} is accessible`);
        
        if (result.latency) {
          info(`Response time: ${result.latency}ms`);
        }
        
        if (result.model) {
          info(`Model: ${result.model}`);
        }
        
        if (result.models && result.models.length > 0) {
          info(`Available models: ${result.models.slice(0, 5).join(", ")}${result.models.length > 5 ? ` ... (+${result.models.length - 5} more)` : ""}`);
        }
        
        console.log("");
        ok("Provider test passed — you're ready to use ContextForge!");
      } else {
        fail(`${requirements.name} test failed`);
        info(dim(result.error));
        
        if (provider === "ollama") {
          info(dim("Make sure Ollama is running: ollama serve"));
        } else if (result.error.includes("401") || result.error.includes("403")) {
          info(dim("API key appears invalid or expired"));
          info(dim(`Get a new key: ${requirements.url}`));
        } else if (result.error.includes("timeout") || result.error.includes("ECONN")) {
          info(dim("Network error — check your internet connection"));
          info(dim("Corporate proxies or firewalls may block API access"));
        }
        
        console.log("");
        fail("Provider test failed — fix the issue above and try again");
        process.exitCode = 1;
      }
    }
  } catch (error) {
    if (opts.json) {
      console.log(JSON.stringify({
        provider,
        ok: false,
        error: error.message,
      }, null, 2));
    } else {
      fail(`Provider test failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
  
  console.log("");
}
