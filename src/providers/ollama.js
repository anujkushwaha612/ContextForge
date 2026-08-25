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

    // HA-1 (headroom analysis): never leak ContextForge's own proxy
    // fingerprint headers upstream (x-cf-dry-run, x-cf-max-retries,
    // x-cf-mock-port, x-contextforge-user-id, x-contextforge-workspace).
    // Same bug class headroom documented in their own audit (P5-49/50/51:
    // "X-Headroom-* request headers leak upstream") — provider-side
    // fingerprinting of proxy traffic is a subscription-revocation risk.
    for (const h of Object.keys(outgoing)) {
      if (h.startsWith("x-cf-") || h.startsWith("x-contextforge-")) delete outgoing[h];
    }

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

    // PO-FIX: gemini-cli clients send /v1beta/models/<model>:generateContent
    // (or :streamGenerateContent). The proxy translates the BODY to OpenAI
    // format, but the PATH fell through untouched → upstream 404 on every
    // gemini-wrapped session. Map it like /messages.
    if (/generatecontent/i.test(normalized)) { // matches :generateContent AND :streamGenerateContent
      normalized = "/v1/chat/completions";
    }

    // Already correct path — pass through
    if (!normalized || normalized === "/") {
      normalized = "/v1/chat/completions";
    }

    return normalized;
  },
};