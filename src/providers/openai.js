/**
 * providers/openai.js
 *
 * OpenAI API adapter.
 * Injects OPENAI_API_KEY from env if present.
 * Supports custom base URLs via OPENAI_HOST (for Azure, LM Studio, etc.)
 */

export const OpenAIAdapter = {
  name: "openai",
  hostname: process.env.OPENAI_HOST || "api.openai.com",
  port: parseInt(process.env.OPENAI_PORT || "443", 10),
  protocol: "https",

  transformHeaders(incomingHeaders) {
    const outgoing = { ...incomingHeaders };

    // Point host header at OpenAI (or custom host)
    outgoing.host = this.hostname;

    // Inject API key from env, overriding whatever the client sent
    const key = process.env.OPENAI_API_KEY;
    if (key) {
      outgoing["authorization"] = `Bearer ${key}`;
    }

    // Anthropic-specific headers OpenAI does not understand — strip them
    delete outgoing["anthropic-version"];
    delete outgoing["anthropic-beta"];
    delete outgoing["x-api-key"];

    // Remove hop-by-hop headers
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
    // Strip query params and normalize Anthropic paths to OpenAI format.
    // Claude Code sends /v1/messages?beta=true — OpenAI doesn't have /messages.
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

    normalized = normalized || "/v1/chat/completions";

    // OpenRouter requires an /api prefix that standard OpenAI does not use.
    // Detect by hostname and prepend it only when needed.
    if (this.hostname === "openrouter.ai" && !normalized.startsWith("/api/")) {
      normalized = "/api" + normalized;
    }

    return normalized;
  },
};
