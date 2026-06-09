import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { GroqAdapter } from './groq.js';
import { OllamaAdapter } from './ollama.js';

/**
 * Provider Factory
 * Returns the correct lightweight Strategy Adapter for routing upstream traffic.
 */
export const ProviderFactory = {
    getAdapter: (providerName) => {
        switch (providerName.toLowerCase()) {
            case 'openai': return OpenAIAdapter;
            case 'anthropic': return AnthropicAdapter;
            case 'groq': return GroqAdapter;
            case 'ollama': return OllamaAdapter;
            default:
                throw new Error(`Unknown provider adapter requested: ${providerName}`);
        }
    },
};
