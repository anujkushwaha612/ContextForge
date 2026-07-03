#!/usr/bin/env node
/**
 * mcp/bridge.js — ContextForge MCP stdio bridge (v1 rewrite of mcp/server.js)
 *
 * This is what Claude Code launches. Speaks MCP over stdin/stdout and
 * forwards tool calls to the ContextForge HTTP proxy.
 *
 * Design change vs mcp/server.js:
 *   ZERO project imports. The old bridge imported graphTools.js /
 *   patchTools.js / ccr/toolInjection.js just for tool *definitions* —
 *   transitively loading tree-sitter, graphDb, statsEmitter (and their
 *   native deps) into a process that only shuttles JSON. The bridge now
 *   fetches definitions from GET /v1/mcp/tools at startup, with a static
 *   fallback so tools/list works even if the proxy is momentarily down.
 *
 * Also fixed from the uploaded mcp/server.js:
 *   - Syntax error: process.stderr.write`...`) tagged-template typo crashed
 *     the bridge at parse time.
 *   - Hardcoded port assumption: CF_PORT is injected by `cf wrap` (which may
 *     have auto-picked a port); default remains 3000 for manual setups.
 *   - contextforge_status now reports the rich /healthz payload (indexing
 *     progress, indexed files, uptime) instead of just the HTTP status code.
 *   - initialize echoes the client's requested protocolVersion when provided.
 */

import http from "node:http";
import readline from "node:readline";

const PROXY_HOST = process.env.CF_PROXY_HOST || "127.0.0.1";
const PROXY_PORT = parseInt(process.env.CF_PORT || process.env.PORT || "3000", 10);
const BRIDGE_VERSION = "1.0.0";

// ─────────────────────────────────────────────
// Static tool definitions (fallback + always-on tools)
// ─────────────────────────────────────────────

const RETRIEVE_TOOL_DEF = {
  name: "contextforge_retrieve",
  description:
    "Retrieve full content from a ContextForge vault by vault_id. " +
    "Use this when you see [CF_VAULT:cf_vault_xxx] or " +
    '[CF_COMPRESSED_FILE vault_id:"cf_vault_xxx"] stubs in file content. ' +
    "Pass the exact vault_id from the stub.",
  inputSchema: {
    type: "object",
    properties: {
      vault_id: {
        type: "string",
        description: "The vault ID from the CF_VAULT stub, e.g. 'cf_vault_abc123'",
      },
      search_query: {
        type: "string",
        description: "Optional search query to retrieve relevant sections only",
      },
    },
    required: ["vault_id"],
  },
};

const STATUS_TOOL_DEF = {
  name: "contextforge_status",
  description: "Check ContextForge proxy status, indexing progress, and compression stats",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const RESET_CACHE_TOOL_DEF = {
  name: "contextforge_reset_cache",
  description: "Reset the ContextForge semantic cache",
  inputSchema: { type: "object", properties: {}, required: [] },
};

// Proxy-provided tools (graph/patch/read_file_chunk) land here at startup.
let proxyTools = [];
let toolsLoaded = false;

// Tools whose calls are forwarded to POST /v1/mcp/tool.
const FORWARDED_TOOLS = new Set([
  "contextforge_query_graph",
  "contextforge_patch_ast",
  "read_file_chunk",
  "contextforge_retrieve",
]);

// ─────────────────────────────────────────────
// Tiny HTTP helper (all proxy I/O goes through this)
// ─────────────────────────────────────────────

function proxyRequest({ method = "GET", path, body = null, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: PROXY_HOST,
        port: PROXY_PORT,
        path,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, json: null, text });
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Proxy request timed out after ${timeoutMs / 1000}s`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadProxyTools() {
  try {
    const { status, json } = await proxyRequest({ path: "/v1/mcp/tools", timeoutMs: 5_000 });
    if (status === 200 && Array.isArray(json?.tools)) {
      proxyTools = json.tools;
      toolsLoaded = true;
      process.stderr.write(`[ContextForge MCP] Loaded ${proxyTools.length} tool defs from proxy\n`);
    }
  } catch {
    // Proxy not up yet (or still indexing) — tools/list will retry lazily.
  }
}

function currentToolsList() {
  return [STATUS_TOOL_DEF, RESET_CACHE_TOOL_DEF, ...proxyTools, RETRIEVE_TOOL_DEF];
}

// ─────────────────────────────────────────────
// MCP protocol over stdio
// ─────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// Guard stdout writes — Claude Code may close the pipe at any time;
// an unguarded write throws synchronously and crashes the bridge.
function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {
    process.exit(0);
  }
}

const sendResult = (id, result) => send({ jsonrpc: "2.0", id, result });
const sendError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id, text, isError = false) =>
  sendResult(id, { content: [{ type: "text", text }], isError });

// Track in-flight handlers so stdin close doesn't kill pending replies.
// Claude Code closes the pipe only on shutdown, but a fast dispatch loop can
// close stdin while a 30s tool call is mid-flight — previously those replies
// were silently dropped (process.exit inside rl "close").
let pending = 0;
let stdinClosed = false;
function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    return; // ignore malformed lines
  }

  pending++;
  try {
    await handleMessage(msg);
  } finally {
    pending--;
    maybeExit();
  }
});

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // ── Handshake ──
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "contextforge", version: BRIDGE_VERSION },
    });
    return;
  }

  if (method === "notifications/initialized") return; // notification — no response

  // ── Tool list ──
  if (method === "tools/list") {
    if (!toolsLoaded) await loadProxyTools(); // lazy retry if startup fetch missed
    sendResult(id, { tools: currentToolsList() });
    return;
  }

  // ── Tool call ──
  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    try {
      if (toolName === "contextforge_status") {
        const [{ json: health }, stats] = [
          await proxyRequest({ path: "/healthz", timeoutMs: 5_000 }),
          await proxyRequest({ path: "/v1/stats", timeoutMs: 5_000 }).catch(() => null),
        ];
        const lines = [];
        if (health?.status === "ok") {
          lines.push(`✅ ContextForge proxy healthy on port ${PROXY_PORT}`);
          lines.push(`   workspace: ${health.workspace ?? "?"}`);
          lines.push(`   indexed:   ${health.indexedFiles ?? "?"} files`);
          lines.push(`   uptime:    ${Math.round((health.uptimeMs ?? 0) / 60000)}m`);
        } else if (health) {
          const p = health.progress ?? {};
          lines.push(`⏳ Proxy is ${health.status} (${p.current ?? 0}/${p.total ?? "?"} files)`);
        } else {
          lines.push(`⚠️ Proxy on port ${PROXY_PORT} did not return health data`);
        }
        if (stats?.json && !stats.json.error) {
          lines.push(`   stats: ${JSON.stringify(stats.json)}`);
        }
        textResult(id, lines.join("\n"));
        return;
      }

      if (toolName === "contextforge_reset_cache") {
        const { json } = await proxyRequest({
          method: "POST",
          path: "/v1/cache/reset",
          body: {},
          timeoutMs: 10_000,
        });
        textResult(id, `✅ Cache reset: ${JSON.stringify(json ?? { message: "Cache reset" })}`);
        return;
      }

      if (FORWARDED_TOOLS.has(toolName)) {
        const { json, text } = await proxyRequest({
          method: "POST",
          path: "/v1/mcp/tool",
          body: { _mcp_tool: toolName, _mcp_args: toolArgs },
        });
        const result = json ?? { content: text };
        textResult(id, result.content || JSON.stringify(result), !!result.error);
        return;
      }

      sendError(id, -32601, `Unknown tool: ${toolName}`);
    } catch (err) {
      textResult(
        id,
        `❌ Error: ${err.message}. Is ContextForge running on port ${PROXY_PORT}?`,
        true
      );
    }
    return;
  }

  // ── Unknown method ──
  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

rl.on("close", () => {
  stdinClosed = true;
  maybeExit();
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

loadProxyTools(); // fire-and-forget warm fetch
process.stderr.write(`[ContextForge MCP Bridge] Ready (proxy ${PROXY_HOST}:${PROXY_PORT})\n`);
