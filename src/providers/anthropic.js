/**
 * providers/anthropic.js
 *
 * Anthropic Claude API adapter.
 * Translates OpenAI-format requests to Anthropic's native format:
 *   - /v1/chat/completions  →  /v1/messages
 *   - Authorization: Bearer  →  x-api-key
 *   - Injects anthropic-version header
 */

export const AnthropicAdapter = {
  name:     "anthropic",
  hostname: process.env.ANTHROPIC_HOST || "api.anthropic.com",
  port:     parseInt(process.env.ANTHROPIC_PORT || "443", 10),
  protocol: "https",

  transformHeaders(incomingHeaders) {
    const outgoing = { ...incomingHeaders };

    // Point host header at Anthropic (or custom host)
    outgoing.host = this.hostname;

    // Anthropic uses x-api-key instead of Authorization Bearer
    // Priority: env var > client-forwarded header
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) {
      outgoing["x-api-key"] = envKey;
      delete outgoing["authorization"];
    } else if (outgoing.authorization) {
      // Fall back to stripping Bearer prefix from forwarded header
      outgoing["x-api-key"] = outgoing.authorization.replace(/^Bearer\s+/i, "");
      delete outgoing["authorization"];
    }

    // Anthropic requires this version header on every request
    outgoing["anthropic-version"] =
      incomingHeaders["anthropic-version"] || "2023-06-01";

    // Remove hop-by-hop headers
    delete outgoing["content-length"];
    delete outgoing["accept-encoding"];
    delete outgoing["connection"];

    return outgoing;
  },

  transformPath(incomingUrl) {
    // Map OpenAI chat completions endpoint to Anthropic messages endpoint
    if (incomingUrl.includes("/chat/completions")) {
      return "/v1/messages";
    }
    return incomingUrl;
  },
};