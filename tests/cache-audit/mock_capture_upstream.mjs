#!/usr/bin/env node
// Capture-only upstream mock: records every request (path/headers/body) to
// HOPS_FILE and answers with a minimal OpenAI-compat completion. Used by
// the compat-mode regression harness.
import http from "node:http";
import fs from "node:fs";

const PORT = 18080;
const OUT = process.env.HOPS_FILE || "/tmp/cf-compat-hops.jsonl";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    fs.appendFileSync(OUT, JSON.stringify({ path: req.url, headers: req.headers, body: parsed, at: Date.now() }) + "\n");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "cmpl_capture", object: "chat.completion", model: parsed?.model || "mock",
      choices: [{ index: 0, message: { role: "assistant", content: "Capture-mock answer." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
    }));
  });
});
server.listen(PORT, "127.0.0.1", () => console.log("capture upstream on " + PORT));
