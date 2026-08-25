import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  ToolInterceptor,
  computeNextRetry,
  createUpstreamHandler,
} from "../../src/proxy/upstreamRequest.js";
import { OpenAIAdapter } from "../../src/adapters/openai.js";
import { AnthropicAdapter } from "../../src/adapters/anthropic.js";

const GRAPH_CALL = {
  id: "call_graph",
  type: "function",
  function: {
    name: "contextforge_query_graph",
    arguments: JSON.stringify({ query_type: "find_symbol", target: "File" }),
  },
};

function emptyAccumulator(hopCount = 0) {
  return {
    accumulatedInputTokens: 0,
    accumulatedBaselineTokens: 0,
    accumulatedCacheReadTokens: 0,
    ghostRetries: Math.max(0, hopCount - 1),
    hopCount,
  };
}

function graphToolSchema() {
  return {
    type: "function",
    function: {
      name: "contextforge_query_graph",
      parameters: {
        type: "object",
        properties: {
          query_type: { type: "string" },
          target: { type: "string" },
        },
        required: ["query_type", "target"],
        additionalProperties: false,
      },
    },
  };
}

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  );
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function requestJson({ port, path = "/v1/chat/completions", body }) {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(encoded),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.end(encoded);
  });
}

function openAiToolResponse(toolCalls) {
  return {
    id: "upstream-tool-call",
    object: "chat.completion",
    model: "test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: toolCalls },
        finish_reason: "tool_calls",
      },
    ],
  };
}

async function startProxyForUpstream(
  t,
  upstreamPort,
  { accumulator = emptyAccumulator(), clientAdapter = new OpenAIAdapter(), stream = false } = {}
) {
  const proxy = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const handler = createUpstreamHandler({
        req,
        res,
        isAnthropic: clientAdapter.name === "anthropic",
        clientAdapter,
        provider: {
          name: "test",
          hostname: "127.0.0.1",
          port: upstreamPort,
          protocol: "http",
          transformHeaders: () => ({}),
          transformPath: () => "/v1/chat/completions",
        },
        semanticCache: null,
        hybridRetriever: null,
        onnxEmbedder: null,
        memoryHandler: null,
        maxRetries: 10,
        mockUpstreamPort: upstreamPort,
      });
      handler(
        {
          model: "test",
          stream,
          messages: [{ role: "user", content: "inspect File" }],
          tools: [graphToolSchema()],
        },
        0,
        accumulator
      ).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));
  return proxyPort;
}

test("failure and hop circuit breakers are terminal outcomes", async () => {
  const interceptor = new ToolInterceptor({ maxRetries: 3 });

  const failure = await interceptor.process([GRAPH_CALL], { tools: [] }, 3, 1);
  assert.equal(failure.terminal, true);
  assert.equal(failure.terminalReason, "failure_budget");

  const hop = await interceptor.process([GRAPH_CALL], { tools: [] }, 0, 15);
  assert.equal(hop.terminal, true);
  assert.equal(hop.terminalReason, "hop_budget");
});

test("read-only budget is novelty-aware and terminal after its hard limit", async () => {
  const interceptor = new ToolInterceptor({});
  // Set the state immediately before the hard novel-read cap so process()
  // exits before executing a graph query or touching disk.
  interceptor._readOnlyRounds = 8;

  const result = await interceptor.process([GRAPH_CALL], { tools: [] }, 0, 1);
  assert.equal(result.terminal, true);
  assert.equal(result.terminalReason, "exploration_budget");
});

test("distinct read-only exploration does not trip at the old three-round threshold", () => {
  const interceptor = new ToolInterceptor({});
  for (const target of ["File", "inviteWithEmail", "shareFile", "validateInvite"]) {
    const stop = interceptor._checkReadOnlyBudget([
      {
        ...GRAPH_CALL,
        function: {
          ...GRAPH_CALL.function,
          arguments: JSON.stringify({ query_type: "find_symbol", target }),
        },
      },
    ]);
    assert.equal(stop, null);
  }
  assert.equal(interceptor._readOnlyRounds, 4);
});

test("identical-call stall is checked before a cache result can be replayed", async () => {
  const interceptor = new ToolInterceptor({});
  const args = GRAPH_CALL.function.arguments;
  interceptor._checkAndRecordCall(GRAPH_CALL.function.name, args);
  interceptor._checkAndRecordCall(GRAPH_CALL.function.name, args);

  const result = await interceptor.process([GRAPH_CALL], { tools: [] }, 0, 1);
  assert.equal(result.terminal, true);
  assert.equal(result.terminalReason, "identical_call_stall");
});

test("a hop-breaker response performs no sixteenth upstream request", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(openAiToolResponse([GRAPH_CALL])));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxyPort = await startProxyForUpstream(t, upstreamPort, {
    accumulator: emptyAccumulator(14),
  });

  const response = await requestJson({
    port: proxyPort,
    body: { model: "test", messages: [{ role: "user", content: "inspect File" }] },
  });

  assert.equal(upstreamRequests, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-cf-ghost-stop"], "hop_budget");
  const parsed = JSON.parse(response.body);
  assert.match(parsed.choices[0].message.content, /hop_budget/);
});

test("malformed background arguments never trigger a recovery hop", async (t) => {
  let upstreamRequests = 0;
  const malformed = {
    ...GRAPH_CALL,
    function: { ...GRAPH_CALL.function, arguments: '{"query_type":' },
  };
  const upstream = http.createServer((req, res) => {
    upstreamRequests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(openAiToolResponse([malformed])));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxyPort = await startProxyForUpstream(t, upstreamPort);

  const response = await requestJson({
    port: proxyPort,
    body: { model: "test", messages: [{ role: "user", content: "inspect File" }] },
  });

  assert.equal(upstreamRequests, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-cf-ghost-stop"], "invalid_tool_call");
  assert.match(JSON.parse(response.body).choices[0].message.content, /malformed JSON/);
});

test("streaming malformed background arguments end as a valid Anthropic safety response", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"bad_stream","index":0,"function":{"name":"contextforge_query_graph","arguments":"{\\\"query_type\\\":"}}]},"finish_reason":null}]}',
          "",
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n")
      );
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxyPort = await startProxyForUpstream(t, upstreamPort, {
    clientAdapter: new AnthropicAdapter(),
    stream: true,
  });

  const response = await requestJson({
    port: proxyPort,
    path: "/v1/messages",
    body: { model: "test", messages: [{ role: "user", content: "inspect File" }] },
  });

  assert.equal(upstreamRequests, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-cf-ghost-stop"], "invalid_tool_call");
  assert.match(response.body, /event: message_start/);
  assert.match(response.body, /event: message_stop/);
  assert.doesNotMatch(response.body, /tool_use/);
});

test("successful action resets failure count while failed calls advance it", () => {
  assert.equal(computeNextRetry({ madeForwardProgress: true, hadFailure: false }, 4, 10), 0);
  assert.equal(computeNextRetry({ madeForwardProgress: false, hadFailure: true }, 4, 10), 5);
});
