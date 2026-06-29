/**
 * providers/index.js
 *
 * Central provider registry and factory.
 *
 * All adapters are plain objects (Strategy pattern).
 * ProviderFactory.getAdapter() returns the adapter directly —
 * no instantiation needed.
 *
 * Adding a new provider:
 *   1. Create src/providers/myprovider.js exporting MyProviderAdapter
 *   2. Import it here and add it to REGISTRY
 *   3. Set CF_PROVIDER=myprovider in .env
 */

import { OllamaAdapter }    from "./ollama.js";
import { OpenAIAdapter }    from "./openai.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GroqAdapter }      from "./groq.js";
import { GeminiAdapter }    from "./gemini.js";

const REGISTRY = {
  ollama:    OllamaAdapter,
  openai:    OpenAIAdapter,
  anthropic: AnthropicAdapter,
  groq:      GroqAdapter,
  gemini:    GeminiAdapter,
};

export const ProviderFactory = {
  /**
   * Returns the provider adapter for the given name.
   *
   * All adapters are plain objects — this returns them directly.
   * The returned object is guaranteed to have:
   *   - name:             string
   *   - hostname:         string
   *   - port:             number
   *   - protocol:         "http" | "https"
   *   - transformHeaders: (headers) => headers
   *   - transformPath:    (url) => url
   *
   * @param {string} name - Provider identifier (case-insensitive)
   * @returns {object} Provider adapter
   * @throws {Error} If provider name is not registered
   */
  getAdapter(name) {
    const key = (name || "ollama").toLowerCase().trim();
    const adapter = REGISTRY[key];

    if (!adapter) {
      const available = Object.keys(REGISTRY).join(", ");
      throw new Error(
        `[ProviderFactory] Unknown provider "${name}". ` +
        `Set CF_PROVIDER to one of: ${available}`
      );
    }

    console.log(
      `[ProviderFactory] ✅ Provider: ${adapter.name} ` +
      `→ ${adapter.protocol}://${adapter.hostname}:${adapter.port}`
    );

    return adapter;
  },

  /**
   * Lists all registered provider names.
   * @returns {string[]}
   */
  listProviders() {
    return Object.keys(REGISTRY);
  },
};