// src/mcp/server.js
// MCP stdio bridge — this is what Claude Code launches
// It speaks MCP protocol over stdin/stdout
// and forwards tool calls to the ContextForge HTTP proxy on port 3000

import { createServer } from "node:net";
import http from "node:http";
import readline from "node:readline";

const PROXY_URL = process.env.CONTEXTFORGE_PROXY_URL || "http://127.0.0.1:3000";
const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 3000;

// ── MCP protocol over stdio ──
const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
  terminal: false,
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

// ── Forward a tool call to the HTTP proxy ──
async function forwardToProxy(toolName, toolArgs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      // Wrap as an Anthropic-style tool result request
      // so the proxy pipeline processes it
      _mcp_tool: toolName,
      _mcp_args: toolArgs,
    });

    const req = http.request(
      {
        hostname: PROXY_HOST,
        port:     PROXY_PORT,
        path:     "/v1/mcp/tool",
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch {
            resolve({ content: Buffer.concat(chunks).toString("utf-8") });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── MCP message handler ──
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    return; // ignore malformed lines
  }

  const { id, method, params } = msg;

  // ── Handshake ──
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name:    "contextforge",
          version: "1.0.0",
        },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    // No response needed for notifications
    return;
  }

  // ── Tool list ──
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name:        "contextforge_status",
            description: "Check ContextForge proxy status and compression stats",
            inputSchema: {
              type:       "object",
              properties: {},
              required:   [],
            },
          },
          {
            name:        "contextforge_reset_cache",
            description: "Reset the ContextForge semantic cache",
            inputSchema: {
              type:       "object",
              properties: {},
              required:   [],
            },
          },
        ],
      },
    });
    return;
  }

  // ── Tool call ──
  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    try {
      if (toolName === "contextforge_status") {
        // Hit the proxy health endpoint
        const result = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: PROXY_HOST,
              port:     PROXY_PORT,
              path:     "/v1/cache/reset",
              method:   "POST",
              headers:  { "Content-Length": "0" },
            },
            (res) => {
              resolve({ statusCode: res.statusCode });
            },
          );
          req.on("error", reject);
          req.end();
        });

        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: result.statusCode < 500
                  ? `✅ ContextForge proxy is healthy (port ${PROXY_PORT})`
                  : `⚠️ Proxy returned status ${result.statusCode}`,
              },
            ],
          },
        });
        return;
      }

      if (toolName === "contextforge_reset_cache") {
        const result = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: PROXY_HOST,
              port:     PROXY_PORT,
              path:     "/v1/cache/reset",
              method:   "POST",
              headers:  { "Content-Length": "0" },
            },
            (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => resolve(
                JSON.parse(Buffer.concat(chunks).toString("utf-8"))
              ));
            },
          );
          req.on("error", reject);
          req.end();
        });

        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: `✅ Cache reset: ${JSON.stringify(result)}`,
              },
            ],
          },
        });
        return;
      }

      sendError(id, -32601, `Unknown tool: ${toolName}`);
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `❌ Error: ${err.message}. Is ContextForge running on port ${PROXY_PORT}?`,
            },
          ],
          isError: true,
        },
      });
    }
    return;
  }

  // ── Unknown method ──
  sendError(id, -32601, `Method not found: ${method}`);
});

rl.on("close", () => process.exit(0));
process.on("SIGINT",  () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// Announce to stderr (not stdout — MCP uses stdout for protocol)
process.stderr.write("[ContextForge MCP Bridge] Ready\n");