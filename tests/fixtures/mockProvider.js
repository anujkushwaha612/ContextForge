/**
 * MockProvider — a real HTTP server that impersonates an LLM.
 *
 * Runs on a random port. Tests point ContextForge at it via
 * OLLAMA_HOST / OLLAMA_PORT environment overrides.
 *
 * Supports:
 *   - Normal JSON responses
 *   - Streaming SSE responses
 *   - Tool call responses
 *   - Configurable per-test behavior via setNextResponse()
 */

import http from "node:http";

const DEFAULT_RESPONSE = {
  id: "chatcmpl-mock",
  object: "chat.completion",
  created: 1700000000,
  model: "mock-model",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "Mock response." },
    finish_reason: "stop"
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
};

export class MockProvider {
  constructor() {
    this._server = null;
    this._port = null;
    this._responseQueue = [];
    this._requests = [];   // All received request bodies — inspect in tests
    this._streamChunks = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start() {
    return new Promise((resolve) => {
      this._server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      // Port 0 = OS picks a random free port
      this._server.listen(0, "127.0.0.1", () => {
        this._port = this._server.address().port;
        resolve(this._port);
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      if (this._server) {
        this._server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  get port() { return this._port; }
  get hostname() { return "127.0.0.1"; }

  // ── Test control API ──────────────────────────────────────────────────

  /** Queue what the mock returns on the next request. */
  setNextResponse(responseBody) {
    this._responseQueue.push(responseBody);
    this._streamChunks = null;
  }

  /** Set streaming SSE chunks for the next request. */
  setNextStreamResponse(chunks) {
    this._streamChunks = chunks;
    this._nextResponse = null;
  }

  /** Returns all request bodies received so far. */
  getRequests() { return [...this._requests]; }

  /** Returns the most recent request body. */
  getLastRequest() { return this._requests[this._requests.length - 1] ?? null; }

  /** Clears the request history. */
  reset() {
    this._requests = [];
    this._responseQueue = [];
    this._streamChunks = null;
  }

  // ── Internal HTTP handler ─────────────────────────────────────────────

  _handleRequest(req, res) {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      // Record the request for test assertions
      try {
        this._requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: JSON.parse(body)
        });
      } catch {
        this._requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      }

      // Handle streaming response
      if (this._streamChunks) {
        const chunks = this._streamChunks;
        this._streamChunks = null;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        });
        let i = 0;
        const writeChunk = () => {
          if (i < chunks.length) {
            res.write(chunks[i++]);
            setImmediate(writeChunk);
          } else {
            res.end();
          }
        };
        writeChunk();
        return;
      }

      // Handle JSON response
      const responseBody = this._responseQueue.length > 0 ? this._responseQueue.shift() : DEFAULT_RESPONSE;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  }
}