// Verified by Claude Code
/**
 * providers/gemini.js
 *
 * Google Gemini API adapter (via the OpenAI-compatible endpoint).
 *
 * Google exposes an OpenAI-compatible shim at:
 *   https://generativelanguage.googleapis.com/v1beta/openai/
 *
 * This means ContextForge can route to Gemini without changing the
 * internal payload format — only the host, path prefix, and auth
 * header format need to change.
 *
 * Auth: Gemini uses a query-param key OR a Bearer token.
 * We use the Bearer token approach (via the OpenAI-compat shim)
 * so the header format stays consistent with other providers.
 *
 * Env vars:
 *   GEMINI_API_KEY        — Google AI Studio API key (required)
 *   GEMINI_HOST           — Override host (default: generativelanguage.googleapis.com)
 *   GEMINI_PORT           — Override port (default: 443)
 *   GEMINI_API_VERSION    — Override API version prefix (default: v1beta)
 */

export const GeminiAdapter = {
  name:     "gemini",
  hostname: process.env.GEMINI_HOST || "generativelanguage.googleapis.com",
  port:     parseInt(process.env.GEMINI_PORT || "443", 10),
  protocol: "https",

  // The OpenAI-compatible shim base path on Google's servers
  _apiVersion: process.env.GEMINI_API_VERSION || "v1beta",

  transformHeaders(incomingHeaders) {
    const outgoing = { ...incomingHeaders };

    // Point host header at Google's API
    outgoing.host = this.hostname;

    // Gemini OpenAI-compat shim accepts Bearer token auth
    const key = process.env.GEMINI_API_KEY;
    if (key) {
      outgoing["authorization"] = `Bearer ${key}`;
    }

    // Gemini does not accept these Anthropic-specific headers
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
    // 1. Cross-provider support: Map Anthropic paths back to OpenAI format
    let normalizedUrl = incomingUrl;
    if (normalizedUrl.includes("/messages")) {
      normalizedUrl = normalizedUrl.replace("/messages", "/chat/completions");
    }

    // 2. Strip query parameters (Google's shim hates Anthropic's ?beta=true)
    normalizedUrl = normalizedUrl.split("?")[0];

    // PG-1 FIX: a gemini-cli CLIENT sends the NATIVE Gemini path
    // (/v1beta/models/<model>:generateContent) — but the proxy body is
    // OpenAI format, so it must go to the shim's /chat/completions, not
    // be prefix-rewritten into /v1beta/openai/models/... (Google 404s).
    // This made the most natural pairing — gemini client + gemini
    // upstream — fail on every request.
    if (/generatecontent/i.test(normalizedUrl)) { // matches :generateContent AND :streamGenerateContent
      normalizedUrl = "/v1/chat/completions";
    }

    // 3. Prepend the Gemini shim base
    const shimBase = `/${this._apiVersion}/openai`;

    if (normalizedUrl.startsWith(shimBase)) {
      return normalizedUrl;
    }

    const stripped = normalizedUrl.replace(/^\/v\d+(?:beta)?/, "");
    return `${shimBase}${stripped}`;
  },
};