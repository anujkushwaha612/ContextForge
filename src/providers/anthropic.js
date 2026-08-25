/**
 * providers/anthropic.js
 *
 * Anthropic Claude API adapter — via Anthropic's OpenAI-COMPAT endpoint.
 *
 * PA-1 FIX (critical): the old adapter did the OPPOSITE of what the
 * pipeline needs. upstreamRequest.js sends JSON.stringify(currentPayload)
 * — an OPENAI-format body (system role inside messages, function-style
 * tools, no top-level max_tokens). The old transformPath forwarded the
 * client's /v1/messages path to Anthropic's NATIVE endpoint, which
 * rejects OpenAI-shaped bodies → CF_PROVIDER=anthropic 400'd on every
 * request. Anthropic's documented OpenAI-compat endpoint accepts exactly
 * the body we send:  https://api.anthropic.com/v1/chat/completions
 *
 * PA-2 FIX: the compat endpoint authenticates with
 * Authorization: Bearer <key> (standard OpenAI SDK style), not x-api-key.
 *
 * PC-3 (provider-cache audit): the compat endpoint does NOT support
 * Anthropic's prompt caching — a Claude Code session behind ContextForge
 * got zero cache hits while paying full input price every turn. Set
 * CF_ANTHROPIC_NATIVE=1 to enable the native /v1/messages egress
 * (see src/proxy/anthropicNative.js): the client's original system
 * blocks and tools — including every cache_control breakpoint — are
 * forwarded byte-verbatim, ContextForge appends its own rule/tools
 * AFTER the client's marked prefix, and responses (including native
 * usage with cache_read_input_tokens) pass through verbatim. The
 * default stays compat so existing gateway setups are not broken.
 */

export const AnthropicAdapter = {
  name:     "anthropic",
  hostname: process.env.ANTHROPIC_HOST || "api.anthropic.com",
  port:     parseInt(process.env.ANTHROPIC_PORT || "443", 10),
  protocol: "https",

  transformHeaders(incomingHeaders) {
    const outgoing = { ...incomingHeaders };

    outgoing.host = this.hostname;

    // PA-2: compat endpoint wants Authorization: Bearer <key>.
    // Priority: env var > key the client forwarded (either header form).
    const envKey = process.env.ANTHROPIC_API_KEY;
    const clientKey =
      outgoing["x-api-key"] ||
      (outgoing.authorization
        ? outgoing.authorization.replace(/^Bearer\s+/i, "")
        : null);
    const key = envKey || clientKey;
    if (key) {
      outgoing["authorization"] = `Bearer ${key}`;
    }
    delete outgoing["x-api-key"];

    // Compat endpoint does not require anthropic-version; drop it so the
    // request is a clean OpenAI-style request.
    delete outgoing["anthropic-version"];
    delete outgoing["anthropic-beta"];

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
    // PA-1: ALL client shapes → the compat endpoint. The body we send is
    // OpenAI-format; only /v1/chat/completions accepts it.
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
    if (!normalized || normalized === "/") {
      normalized = "/v1/chat/completions";
    }
    return normalized;
  },
};