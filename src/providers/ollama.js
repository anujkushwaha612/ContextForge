export const OllamaAdapter = {
  name:     "ollama",
  hostname: process.env.OLLAMA_HOST || "127.0.0.1",
  port:     parseInt(process.env.OLLAMA_PORT || "11434", 10),
  protocol: "http",

  transformHeaders(incomingHeaders) {
    const outgoing = { ...incomingHeaders };

    // Point host header at Ollama with explicit port
    outgoing.host = `${this.hostname}:${this.port}`;

    // Inject API key if the Ollama instance requires auth
    const key = process.env.OLLAMA_API_KEY;
    if (key) {
      outgoing["authorization"] = `Bearer ${key}`;
    }

    // Anthropic-specific headers Ollama does not understand — strip them
    delete outgoing["anthropic-version"];
    delete outgoing["anthropic-beta"];
    delete outgoing["x-api-key"];

    // Remove hop-by-hop headers that must not be forwarded
    delete outgoing["content-length"];
    delete outgoing["accept-encoding"];
    delete outgoing["connection"];

    return outgoing;
  },

  transformPath(incomingUrl) {
    // Normalize all client path formats to Ollama's single endpoint.
    //
    // Claude Code sends:  /v1/messages?beta=true  (Anthropic format)
    // OpenAI clients send: /v1/chat/completions
    // Both must map to:   /v1/chat/completions
    //
    // Strip query params — Ollama ignores them but they cause log noise.

    let normalized = incomingUrl.split("?")[0];

    if (normalized.includes("/messages")) {
      normalized = "/v1/chat/completions";
    }

    // Already correct path — pass through
    if (!normalized || normalized === "/") {
      normalized = "/v1/chat/completions";
    }

    return normalized;
  },
};