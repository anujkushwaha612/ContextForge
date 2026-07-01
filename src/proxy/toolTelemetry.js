import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getWorkspaceRoot } from "../graph/graphDb.js"; // Assuming this exists or falls back

const MAX_ARG_LENGTH = 1000;

function truncateArgs(args) {
  if (!args) return args;
  const clone = { ...args };
  for (const [key, value] of Object.entries(clone)) {
    if (typeof value === "string" && value.length > MAX_ARG_LENGTH) {
      const hash = crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
      clone[key] = value.slice(0, 100) + `... [TRUNCATED, SHA256: ${hash}]`;
    } else if (typeof value === "object" && value !== null) {
      clone[key] = truncateArgs(value);
    }
  }
  return clone;
}

function determineGraphCapability(toolName, args) {
  const normalizedTool = toolName.toLowerCase();
  
  if (normalizedTool === "read") {
    const file = args?.file_path || args?.file || "";
    // Graph can't answer READMEs, config files, package.json
    if (file.toLowerCase().endsWith(".md") || file.toLowerCase().endsWith(".json") || file.toLowerCase().includes("config")) {
      return { graphCapable: false, graphReason: "config_or_doc" };
    }
    return { graphCapable: true, graphReason: "symbol_or_route" };
  }
  
  if (normalizedTool === "grep" || normalizedTool === "glob") {
    // Grep/Glob for symbols/routes is what the graph does best
    return { graphCapable: true, graphReason: "symbol_or_route" };
  }
  
  return { graphCapable: false, graphReason: "unsupported_tool" };
}

export async function logToolEvent(event) {
  try {
    const logDir = path.join(process.cwd(), ".contextforge");
    await fs.mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, "telemetry.jsonl");

    const { graphCapable, graphReason } = determineGraphCapability(event.tool, event.arguments);

    const payload = {
      timestamp: new Date().toISOString(),
      sessionId: event.sessionId || "unknown",
      conversationId: event.conversationId || "unknown",
      turn: event.turn || 0,
      provider: event.provider || "unknown",
      tool: event.tool,
      plannerIntent: event.plannerIntent || "UNKNOWN",
      arguments: truncateArgs(event.arguments),
      resultTokens: event.resultTokens || 0,
      latencyMs: event.latencyMs || 0,
      retry: event.retry || 0,
      graphCapable: graphCapable,
      graphReason: graphReason,
      usedContextForge: false
    };

    await fs.appendFile(logFile, JSON.stringify(payload) + "\n", "utf8");
  } catch (err) {
    // Passive telemetry: never crash the proxy
    console.error(`[Telemetry] Failed to log tool event: ${err.message}`);
  }
}

export function processPayloadForTelemetry(payload, headers = {}) {
  try {
    const messages = payload.messages || [];
    if (messages.length < 2) return;

    // We only want to log when the NEWEST messages are tool results
    // sent by the client.
    const recentToolMessages = [];
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role === "tool") {
      recentToolMessages.unshift(messages[i]);
      i--;
    }

    if (recentToolMessages.length === 0) return;

    const assistantMsg = messages[i];
    if (!assistantMsg || assistantMsg.role !== "assistant" || !assistantMsg.tool_calls) return;

    const sessionId = headers["x-contextforge-session"] || "unknown";
    
    for (const tm of recentToolMessages) {
      const tc = assistantMsg.tool_calls.find(c => c.id === tm.tool_call_id);
      if (!tc) continue;
      
      const toolName = tc.function.name;
      
      // Skip logging ContextForge internal tools if we only want Native tools,
      // but the spec says "Log every native tool". Let's log all for now.
      
      let argsObj = {};
      try { argsObj = JSON.parse(tc.function.arguments || "{}"); } catch(e){}
      
      // Rough token estimate (chars / 4) as requested if no exact tokenizer is handy
      const contentStr = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content || "");
      const resultTokens = Math.floor(contentStr.length / 4);

      logToolEvent({
        sessionId,
        tool: toolName,
        arguments: argsObj,
        resultTokens,
        latencyMs: 0, // Client side latency cannot be perfectly measured here
        provider: payload.model || "unknown"
      });
    }
  } catch (err) {
    console.error(`[Telemetry] Error parsing payload: ${err.message}`);
  }
}
