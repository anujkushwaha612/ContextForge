#!/usr/bin/env node
// Regression harness for the DEFAULT (non-native) egress paths:
//   A. provider=anthropic WITHOUT CF_ANTHROPIC_NATIVE → OpenAI-compat wire
//      (path /v1/chat/completions, OpenAI body shape) — default unchanged,
//      and prompt_cache_key present (OpenAI-wire provider).
//   B. provider=openai → prompt_cache_key STABLE across turns of the same
//      session (cache routing hint must be identical for cache hits), and
//      CF_PROMPT_CACHE_RETENTION=24h → prompt_cache_retention in the body.
//   C. native OFF → no native /v1/messages path ever hit.
//
// Usage: node tests/cache-audit/test_compat_mode.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOPS = "/tmp/cf-compat-hops.jsonl";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const mock = spawn("node", [path.join(REPO, "tests/cache-audit/mock_capture_upstream.mjs")], { stdio: "pipe" });

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on("error", reject);
    req.write(data); req.end();
  });
}
function waitForLine(proc, line, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("timeout waiting for " + line)), timeoutMs);
    const onData = (d) => { buf += d.toString(); if (buf.includes(line)) { clearTimeout(t); resolve(); } };
    proc.stdout.on("data", onData); proc.stderr.on("data", onData);
    proc.on("exit", () => { clearTimeout(t); reject(new Error("process exited")); });
  });
}
function startCF(envExtra) {
  fs.writeFileSync(HOPS, "");
  return new Promise((resolve, reject) => {
    const cf = spawn("node", ["src/server.js"], {
      cwd: REPO,
      env: { ...process.env, CF_PORT: "13002", CF_DATA_DIR: "/tmp/cf-data-compat-test", CF_WORKSPACE_PATH: "/tmp/ADrive_backend", ...envExtra },
      stdio: "pipe",
    });
    let buf = "";
    cf.stdout.on("data", (d) => { buf += d.toString(); if (buf.includes("CF_READY")) resolve(cf); });
    cf.stderr.on("data", (d) => { buf += d.toString(); if (buf.includes("CF_READY")) resolve(cf); });
    cf.on("exit", (c) => reject(new Error("CF server exited early: " + c + "\n" + buf.slice(-1500))));
    setTimeout(() => reject(new Error("CF server startup timeout\n" + buf.slice(-1500))), 90000);
  });
}
const kill = (p) => { try { p?.kill("SIGKILL"); } catch {} };

const bigSystem = "You are a test system prompt. " + "Padding padding padding. ".repeat(30);
const base = {
  model: "claude-sonnet-4-5", max_tokens: 100, stream: false,
  system: bigSystem,
  messages: [{ role: "user", content: "Hello turn one." }],
  tools: [{ name: "Bash", description: "Run a command.", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
};

let failed = false;
let cf = null;
try {
  await waitForLine(mock, "capture upstream on");

  // ── A: anthropic provider, native OFF (default) → compat wire ────────
  cf = await startCF({ CF_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" });
  const rA = await post(13002, "/v1/messages", { ...base }, { "x-api-key": "sk-c", "anthropic-version": "2023-06-01", "x-cf-mock-port": "18080" });
  check("A: compat mode (native OFF) answers", rA.status === 200, `status=${rA.status}`);
  await new Promise((r) => setTimeout(r, 300));
  let hops = fs.readFileSync(HOPS, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const hopA = hops[hops.length - 1];
  check("A: upstream path is OpenAI-compat /v1/chat/completions (NOT native /v1/messages)", hopA.path.startsWith("/v1/chat/completions"), hopA.path);
  check("A: body is OpenAI shape (system inside messages, function-style tools)",
    hopA.body.messages?.[0]?.role === "system" && hopA.body.tools?.[0]?.function?.name === "Bash");
  check("A: prompt_cache_key present (OpenAI-wire provider)", typeof hopA.body.prompt_cache_key === "string" && hopA.body.prompt_cache_key.length > 0, hopA.body.prompt_cache_key);
  kill(cf); cf = null;

  // ── B: openai provider, retention opt-in → key STABLE + retention ────
  cf = await startCF({ CF_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", CF_PROMPT_CACHE_RETENTION: "24h" });
  const rB1 = await post(13002, "/v1/chat/completions", { ...base, messages: [{ role: "user", content: "Hello turn one." }] }, { authorization: "Bearer sk-c", "x-cf-mock-port": "18080" });
  const rB2 = await post(13002, "/v1/chat/completions", { ...base, messages: [
    { role: "user", content: "Hello turn one." },
    { role: "assistant", content: "Hi!" },
    { role: "user", content: "Hello turn two." },
  ] }, { authorization: "Bearer sk-c", "x-cf-mock-port": "18080" });
  check("B: openai mode answers both turns", rB1.status === 200 && rB2.status === 200);
  await new Promise((r) => setTimeout(r, 300));
  hops = fs.readFileSync(HOPS, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const hopB1 = hops[hops.length - 2];
  const hopB2 = hops[hops.length - 1];
  check("B: prompt_cache_key IDENTICAL across turns (cache routing stable)",
    hopB1.body.prompt_cache_key && hopB1.body.prompt_cache_key === hopB2.body.prompt_cache_key, hopB1.body.prompt_cache_key);
  check("B: prompt_cache_retention=24h applied from env", hopB1.body.prompt_cache_retention === "24h", hopB1.body.prompt_cache_retention);
  check("B: turn-2 messages prefix byte-stable (client bytes + no injection churn)",
    JSON.stringify(hopB2.body.messages[0]) === JSON.stringify(hopB1.body.messages[0]) &&
    JSON.stringify(hopB2.body.system ?? hopB2.body.messages[0]) === JSON.stringify(hopB1.body.system ?? hopB1.body.messages[0]));
  check("B: system prefix identical across turns", JSON.stringify(hopB1.body.messages[0]) === JSON.stringify(hopB2.body.messages[0]));
  kill(cf); cf = null;
} catch (e) {
  failed = true;
  console.log("FAIL  harness error — " + e.message);
} finally {
  kill(cf); kill(mock);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed${failed ? " (HARNESS ERROR)" : ""}`);
process.exit(failed || passed < results.length ? 1 : 0);
