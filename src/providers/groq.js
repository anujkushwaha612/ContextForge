/**
 * providers/groq.js
 *
 * Groq Cloud API adapter.
 * Groq is OpenAI-compatible — same endpoint paths, same auth format.
 * Injects GROQ_API_KEY from env if present.
 */

export const GroqAdapter = {
  name:     "groq",
  hostname: process.env.GROQ_HOST || "api.groq.com",
  port:     parseInt(process.env.GROQ_PORT || "443", 10),
  protocol: "https",

  transformHeaders(incomingHeaders) {
    const outgoing = { ...incomingHeaders };

    // Point host header at Groq (or custom host)
    outgoing.host = this.hostname;

    // Inject Groq API key from env
    const key = process.env.GROQ_API_KEY;
    if (key) {
      outgoing["authorization"] = `Bearer ${key}`;
    }

    // Remove hop-by-hop headers
    delete outgoing["content-length"];
    delete outgoing["accept-encoding"];
    delete outgoing["connection"];

    return outgoing;
  },

  transformPath(incomingUrl) {
    // Groq is OpenAI-compatible — pass paths through unchanged
    return incomingUrl;
  },
};