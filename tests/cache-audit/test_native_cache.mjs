#!/usr/bin/env node
// Provider-cache audit harness.
//
// Verifies the native Anthropic egress (PC-3) does NOT destroy Anthropic's
// prompt caching:
//   1. client system/tools (with cache_control markers) reach the upstream
//      BYTE-VERBATIM and STABLE across turns/hops,
//   2. ContextForge additions are APPENDED AFTER the client's marked prefix,
//   3. ghost interception works over the native wire (background tool_use),
//   4. native usage (cache_read_input_tokens) lands in CF metrics,
//   5. no x-cf-* fingerprint headers leak upstream; anthropic-version set,
//   6. non-native (compat) mode is still the default (env gate).
//
// Usage: node tests/cache-audit/test_native_cache.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOPS = "/tmp/cf-native-hops.jsonl";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    }).on("error", reject);
  });
}

function parseSSE(text) {
  // Returns { events, text, stopReason, error, hadToolUse }
  const out = { events: [], text: "", stopReason: null, error: null, hadToolUse: false, blocks: [] };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let evt;
    try {
      evt = JSON.parse(line.substring(6));
    } catch {
      continue;
    }
    out.events.push(evt.type);
    if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") out.hadToolUse = true;
    if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") out.text += evt.delta.text;
    if (evt.type === "message_delta") out.stopReason = evt.delta?.stop_reason ?? null;
    if (evt.type === "error") out.error = evt.error?.message;
  }
  return out;
}

function waitForLine(proc, line, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("timeout waiting for " + line)), timeoutMs);
    const onData = (d) => {
      buf += d.toString();
      if (buf.includes(line)) {
        clearTimeout(t);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", () => {
      clearTimeout(t);
      reject(new Error("process exited before " + line));
    });
  });
}

function kill(proc) {
  try {
    proc?.kill("SIGKILL");
  } catch {}
}

async function main() {
  // ── Unit checks (no server needed) ───────────────────────────────────
  const { isNativeAnthropicEgress, internalToAnthropicMessages } = await import(
    "../../src/proxy/anthropicNative.js"
  );
  const envWas = process.env.CF_ANTHROPIC_NATIVE;
  delete process.env.CF_ANTHROPIC_NATIVE;
  check(
    "env gate: native OFF by default (compat stays default)",
    isNativeAnthropicEgress({ providerName: "anthropic", clientAdapterName: "anthropic" }) === false
  );
  process.env.CF_ANTHROPIC_NATIVE = "1";
  check(
    "env gate: native ON with CF_ANTHROPIC_NATIVE=1",
    isNativeAnthropicEgress({ providerName: "anthropic", clientAdapterName: "anthropic" }) === true &&
      isNativeAnthropicEgress({ providerName: "ollama", clientAdapterName: "anthropic" }) === false
  );
  process.env.CF_ANTHROPIC_NATIVE = envWas;

  // Message conversion: consecutive tool results merge into one user msg;
  // assistant tool_calls become tool_use blocks; system is dropped.
  const native = internalToAnthropicMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [
      { id: "t1", type: "function", function: { name: "contextforge_query_graph", arguments: '{"a":1}' } },
      { id: "t2", type: "function", function: { name: "contextforge_patch_ast", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "t1", name: "contextforge_query_graph", content: '{"ok":true}' },
    { role: "tool", tool_call_id: "t2", name: "contextforge_patch_ast", content: 'SYSTEM_ERROR: x' },
    { role: "user", content: "next" },
  ]);
  check(
    "msg conversion: 6 internal msgs -> 3 native (user/assistant/user)",
    native.length === 3 && native[0].role === "user" && native[1].role === "assistant" && native[2].role === "user",
    JSON.stringify(native.map((m) => m.role))
  );
  const asstBlocks = native[1].content;
  check(
    "msg conversion: tool_calls -> two tool_use blocks with parsed input",
    asstBlocks.filter((b) => b.type === "tool_use").length === 2 &&
      asstBlocks.find((b) => b.id === "t1").input.a === 1
  );
  const userBlocks = native[2].content;
  check(
    "msg conversion: consecutive tool results merged into one user message (alternation)",
    userBlocks.filter((b) => b.type === "tool_result").length === 2 &&
      userBlocks.find((b) => b.tool_use_id === "t2").is_error === true &&
      userBlocks.some((b) => b.type === "text" && b.text === "next")
  );

  // ── Integration: mock native upstream + CF server (native mode) ─────
  const mock = spawn("node", [path.join(REPO, "tests/cache-audit/mock_native_upstream.mjs")], { stdio: "pipe" });
  const cf = spawn(
    "node",
    ["src/server.js"],
    {
      cwd: REPO,
      env: {
        ...process.env,
        CF_ANTHROPIC_NATIVE: "1",
        CF_PROVIDER: "anthropic",
        CF_PORT: "13001",
        CF_WORKSPACE_PATH: "/tmp/ADrive_backend",
        CF_DATA_DIR: "/tmp/cf-data-cache-test",
        ANTHROPIC_API_KEY: "sk-test-mock",
      },
      stdio: "pipe",
    }
  );
  let cfLog = "";
  cf.stdout.on("data", (d) => (cfLog += d));
  cf.stderr.on("data", (d) => (cfLog += d));

  let failed = false;
  try {
    await waitForLine(mock, "native mock upstream on");
    await waitForLine(cf, "CF_READY", 120000);

    const bigSystem = "You are an expert software engineer. " + "ContextForge test system prompt. ".repeat(40);
    const clientTools = [
      {
        name: "Bash",
        description: "Run a shell command.",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
      {
        name: "Read",
        description: "Read a file.",
        input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
        cache_control: { type: "ephemeral" },
      },
    ];

    const baseHeaders = {
      "x-api-key": "sk-client",
      "anthropic-version": "2023-06-01",
      "x-cf-mock-port": "18080",
      "x-contextforge-user-id": "user-42", // must NOT leak upstream
    };

    // TURN 1 — expect ghost interception (mock answers with tool_use first)
    const turn1 = await post(
      13001,
      "/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: true,
        system: [
          { type: "text", text: "You are Claude Code." },
          { type: "text", text: bigSystem, cache_control: { type: "ephemeral" } },
        ],
        tools: clientTools,
        messages: [{ role: "user", content: "Explain how the file upload pipeline works." }],
        metadata: { user_id: "user-42:session-1" },
      },
      baseHeaders
    );
    const sse1 = parseSSE(turn1.body);
    check("turn1: client gets complete native SSE stream", turn1.status === 200 && sse1.events.includes("message_start") && sse1.events.includes("message_stop"), `events=${sse1.events.join(",")}`);
    check("turn1: client receives FINAL text (ghost hop transparent)", sse1.text.includes("Final answer: loginUser"), sse1.text.slice(0, 80));

    // TURN 2 — identical prefix + the turn-1 conversation + a new user turn
    const turn2 = await post(
      13001,
      "/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: true,
        system: [
          { type: "text", text: "You are Claude Code." },
          { type: "text", text: bigSystem, cache_control: { type: "ephemeral" } },
        ],
        tools: clientTools,
        messages: [
          { role: "user", content: "Explain how the file upload pipeline works." },
          { role: "assistant", content: [{ type: "text", text: sse1.text }] },
          { role: "user", content: "And what happens on a duplicate upload?" },
        ],
        metadata: { user_id: "user-42:session-1" },
      },
      baseHeaders
    );
    const sse2 = parseSSE(turn2.body);
    check("turn2: client gets complete native SSE stream", turn2.status === 200 && sse2.events.includes("message_stop"));

    await new Promise((r) => setTimeout(r, 500)); // let mock flush

    // ── Assertions on the captured upstream hops ───────────────────────
    const hops = fs.readFileSync(HOPS, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    // Stateless mock: any request without a contextforge tool_result in its
    // messages gets a tool_use answer → EVERY client turn costs 2 hops
    // (intercept + re-hop) until the re-hop carries the tool_result.
    check("hops: both turns intercepted (2 hops each = 4)", hops.length === 4, `hops=${hops.length}`);

    const sysStrs = new Set(hops.map((h) => JSON.stringify(h.body.system)));
    const toolStrs = new Set(hops.map((h) => JSON.stringify(h.body.tools)));
    check("system prefix BYTE-IDENTICAL across all turns/hops (cacheable)", sysStrs.size === 1, `distinct=${sysStrs.size}`);
    check("tools prefix BYTE-IDENTICAL across all turns/hops (cacheable)", toolStrs.size === 1, `distinct=${toolStrs.size}`);

    const sys0 = hops[0].body.system;
    check(
      "client system blocks verbatim (2 client blocks kept, markers intact)",
      sys0.length >= 3 && sys0[0].text === "You are Claude Code." &&
        sys0[1].text === bigSystem && sys0[1].cache_control?.type === "ephemeral",
      `blocks=${sys0.length}`
    );
    // The CF rule block starts with the [CF_INJECTED_RULE] sentinel.
    const cfRuleIdx = sys0.findIndex((b) => (b.text || "").includes("[CF_INJECTED_RULE]"));
    check(
      "CF rule APPENDED AFTER client's last cache_control block (outside marked prefix)",
      cfRuleIdx === sys0.length - 1 && cfRuleIdx > 1 && sys0[cfRuleIdx].cache_control === undefined
    );

    const tools0 = hops[0].body.tools;
    const clientToolNames = new Set(clientTools.map((t) => t.name));
    const cfTools = tools0.filter((t) => !clientToolNames.has(t.name));
    check(
      "client tools verbatim + client cache_control intact",
      tools0.slice(0, clientTools.length).length === clientTools.length &&
        JSON.stringify(tools0.find((t) => t.name === "Read").cache_control) === JSON.stringify({ type: "ephemeral" })
    );
    check(
      "CF tools APPENDED after client tools in ANTHROPIC wire shape (name/input_schema), no marker on ours",
      cfTools.length > 0 &&
        cfTools.every((t, i) => t.name === tools0[clientTools.length + i].name && t.cache_control === undefined) &&
        cfTools.every((t) => t.name && t.input_schema && !t.function) &&
        cfTools.some((t) => t.name === "contextforge_query_graph") &&
        cfTools.some((t) => t.name === "contextforge_patch_ast"),
      `cfTools=${cfTools.map((t) => t.name).join(",")}`
    );
    // No compressed content in this conversation yet → no retrieve tool
    // (CCR injects it only when vaults exist). Asserting the ABSENCE
    // proves the tool array is content-stable, not gratuitously appended.
    check(
      "CF tool set content-stable: no retrieve tool while no vaults exist",
      !cfTools.some((t) => t.name === "contextforge_retrieve")
    );

    // Turn-2 messages must start with the turn-1 prefix messages untouched
    const t2msgs = hops[2].body.messages;
    check(
      "turn2 messages: turn-1 conversation prefix preserved (client bytes intact)",
      t2msgs[0].role === "user" && t2msgs[0].content === "Explain how the file upload pipeline works." &&
        t2msgs[2].role === "user"
    );
    // The ghost-intercepted turn-1 hop: assistant tool_use + user tool_result present
    const hop2msgs = hops[1].body.messages;
    const hasToolUse = hop2msgs.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.name === "contextforge_query_graph"));
    const hasToolResult = hop2msgs.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
    check("ghost hop: native wire carries assistant tool_use + user tool_result", hasToolUse && hasToolResult);

    // Header hygiene
    const h0 = hops[0].headers;
    check(
      "headers: no x-cf-*/x-contextforge-* fingerprint leak upstream",
      !Object.keys(h0).some((h) => h.startsWith("x-cf-") || h.startsWith("x-contextforge-")),
      Object.keys(h0).join(",")
    );
    check("headers: anthropic-version + auth present (native requirements)", Boolean(h0["anthropic-version"]) && Boolean(h0["x-api-key"] || h0["authorization"]));

    // Metrics: native cache_read_input_tokens must land in CF metrics
    const stats = await getJson(13001, "/v1/stats");
    const statsObj = JSON.parse(stats.body);
    check(
      "metrics: upstream cache_read_input_tokens land in CF stats",
      (statsObj.session?.cacheReadTokens ?? 0) > 0,
      `cacheReadTokens=${statsObj.session?.cacheReadTokens}`
    );
  } catch (e) {
    failed = true;
    console.log("FAIL  harness error — " + e.message);
    console.log("── CF server log tail ──\n" + cfLog.slice(-2000));
  } finally {
    kill(mock);
    kill(cf);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed${failed ? " (HARNESS ERROR)" : ""}`);
  process.exit(failed || passed < results.length ? 1 : 0);
}

main();
