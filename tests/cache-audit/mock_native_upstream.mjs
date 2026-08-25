#!/usr/bin/env node
// Mock ANTHROPIC-NATIVE upstream for the provider-cache audit harness.
// Speaks the native /v1/messages wire format (SSE streaming) and records
// every request (headers + body) to /tmp/cf-native-hops.jsonl so the test
// can assert prefix byte-stability, cache_control preservation, and
// header hygiene across turns/hops.
import http from "node:http";
import fs from "node:fs";

const PORT = 18080;
const OUT = "/tmp/cf-native-hops.jsonl";
fs.writeFileSync(OUT, "");

function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function streamResponse(res, { toolUse }) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const id = "msg_mock_" + Math.random().toString(36).slice(2, 10);
  const usageStart = {
    input_tokens: 2000,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 5000,
  };
  let s = sseLine({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-mock-1",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: usageStart,
    },
  });
  s += sseLine({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  s += sseLine({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: toolUse ? "Let me check the graph. " : "Final answer: " },
  });
  s += sseLine({ type: "content_block_stop", index: 0 });
  if (toolUse) {
    s += sseLine({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_mock_1", name: "contextforge_query_graph", input: {} },
    });
    s += sseLine({
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json:
          '{"query_type":"find_symbol","target":"loginUser"}',
      },
    });
    s += sseLine({ type: "content_block_stop", index: 1 });
    s += sseLine({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 50 },
    });
  } else {
    s += sseLine({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "loginUser validates credentials and signs a JWT." },
    });
    s += sseLine({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 50 },
    });
  }
  s += sseLine({ type: "message_stop" });
  res.end(s);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    fs.appendFileSync(
      OUT,
      JSON.stringify({
        path: req.url,
        headers: req.headers,
        body: parsed,
        at: Date.now(),
      }) + "\n"
    );

    if (!parsed || req.url !== "/v1/messages") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found", message: "not found" } }));
      return;
    }

    const hasCfToolResult = (parsed.messages ?? []).some((m) => {
      if (m.role !== "user" || !Array.isArray(m.content)) return false;
      return m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "toolu_mock_1");
    });

    streamResponse(res, { toolUse: !hasCfToolResult });
  });
});

server.listen(PORT, "127.0.0.1", () => console.log("native mock upstream on " + PORT));
