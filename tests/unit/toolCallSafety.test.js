import assert from "node:assert/strict";
import test from "node:test";

import {
  StreamToolCallAssembler,
  isExactToolAlias,
  repairMergedToolCalls,
  validateActiveToolCall,
} from "../../src/proxy/toolCallSafety.js";
import { prepareGhostToolCalls } from "../../src/proxy/upstreamRequest.js";

const GRAPH_NAME = "contextforge_query_graph";
const GRAPH_SCHEMA = {
  type: "object",
  properties: {
    query_type: { type: "string", enum: ["find_symbol", "what_does_this_export"] },
    target: { type: "string" },
  },
  required: ["query_type", "target"],
  additionalProperties: false,
};

function graphCall({ id = "call_graph", name = GRAPH_NAME, argumentsText } = {}) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments:
        argumentsText ?? JSON.stringify({ query_type: "find_symbol", target: "inviteWithEmail" }),
    },
  };
}

function payloadWithGraph() {
  return {
    tools: [{ type: "function", function: { name: GRAPH_NAME, parameters: GRAPH_SCHEMA } }],
  };
}

const graphInterceptor = {
  isBackgroundTool(name) {
    return name === GRAPH_NAME;
  },
};

test("tool aliases require exact namespace boundaries", () => {
  assert.equal(isExactToolAlias(GRAPH_NAME, GRAPH_NAME), true);
  assert.equal(isExactToolAlias(`mcp__contextforge__${GRAPH_NAME}`, GRAPH_NAME), true);
  assert.equal(isExactToolAlias(GRAPH_NAME + GRAPH_NAME, GRAPH_NAME), false);
  assert.equal(isExactToolAlias(`wrong_${GRAPH_NAME}`, GRAPH_NAME), false);
});

test("anonymous parallel names are rejected rather than concatenated", () => {
  const assembler = new StreamToolCallAssembler({ knownToolNames: [GRAPH_NAME] });
  const first = JSON.stringify({ query_type: "find_symbol", target: "inviteWithEmail" });
  const second = JSON.stringify({
    query_type: "what_does_this_export",
    target: "models/file.model.js",
  });

  // This is the observed unsafe ordering: two names arrive before either
  // anonymous call can be identified by arguments.
  assembler.add({ function: { name: GRAPH_NAME } });
  assembler.add({ function: { name: GRAPH_NAME } });
  assembler.add({ function: { arguments: first } });
  assembler.add({ function: { arguments: second } });

  assert.equal(assembler.isAmbiguous, true);
  assert.equal(
    assembler.calls.some((call) => call.name === GRAPH_NAME + GRAPH_NAME),
    false
  );
  assert.ok(assembler.issues.some((issue) => issue.code === "ambiguous_arguments"));
});

test("explicit IDs override a reused index and preserve separate calls", () => {
  const assembler = new StreamToolCallAssembler({ knownToolNames: [GRAPH_NAME] });
  assembler.add({
    id: "first",
    index: 0,
    function: {
      name: GRAPH_NAME,
      arguments: JSON.stringify({ query_type: "find_symbol", target: "File" }),
    },
  });
  assembler.add({
    id: "second",
    index: 0,
    function: {
      name: GRAPH_NAME,
      arguments: JSON.stringify({ query_type: "find_symbol", target: "inviteWithEmail" }),
    },
  });

  assert.deepEqual(
    assembler.calls.map((call) => call.id),
    ["first", "second"]
  );
  assert.equal(assembler.calls[0].name, GRAPH_NAME);
  assert.equal(assembler.calls[1].name, GRAPH_NAME);
  assert.ok(assembler.issues.some((issue) => issue.code === "reused_index"));

  const prepared = prepareGhostToolCalls(assembler.calls, payloadWithGraph(), graphInterceptor, {
    assemblyIssues: assembler.issues,
  });
  assert.equal(prepared.kind, "ready");
  assert.equal(prepared.calls.length, 2);
});

test("a reused index becomes fatal when a later fragment has no ID", () => {
  const assembler = new StreamToolCallAssembler({ knownToolNames: [GRAPH_NAME] });
  assembler.add({
    id: "first",
    index: 0,
    function: { name: GRAPH_NAME, arguments: '{"query_type"' },
  });
  assembler.add({
    id: "second",
    index: 0,
    function: { name: GRAPH_NAME, arguments: '{"query_type"' },
  });
  assembler.add({ index: 0, function: { arguments: ':"find_symbol"}' } });

  assert.ok(assembler.issues.some((issue) => issue.code === "ambiguous_index_fragment"));
  const prepared = prepareGhostToolCalls(assembler.calls, payloadWithGraph(), graphInterceptor, {
    assemblyIssues: assembler.issues,
  });
  assert.equal(prepared.kind, "rejected");
});

test("a repeated full name on an in-progress ID is idempotent", () => {
  const assembler = new StreamToolCallAssembler({ knownToolNames: [GRAPH_NAME] });
  assembler.add({
    id: "call_1",
    index: 0,
    function: { name: GRAPH_NAME, arguments: '{"query_type"' },
  });
  assembler.add({
    id: "call_1",
    index: 0,
    function: { name: GRAPH_NAME, arguments: ':"find_symbol"' },
  });
  assembler.add({ id: "call_1", index: 0, function: { arguments: ',"target":"File"}' } });

  assert.equal(assembler.isAmbiguous, false);
  assert.equal(assembler.calls.length, 1);
  assert.equal(assembler.calls[0].name, GRAPH_NAME);
  assert.deepEqual(JSON.parse(assembler.calls[0].arguments), {
    query_type: "find_symbol",
    target: "File",
  });
});

test("complete concatenated JSON objects repair only to an active exact tool name", () => {
  const first = JSON.stringify({ query_type: "find_symbol", target: "inviteWithEmail" });
  const second = JSON.stringify({
    query_type: "what_does_this_export",
    target: "models/file.model.js",
  });
  const merged = graphCall({
    id: "merged",
    name: GRAPH_NAME + GRAPH_NAME,
    argumentsText: first + second,
  });

  const repaired = repairMergedToolCalls([merged], {
    isKnownToolName: (name) => name === GRAPH_NAME,
  });
  assert.equal(repaired.issues.length, 0);
  assert.equal(repaired.calls.length, 2);
  assert.deepEqual(
    repaired.calls.map((call) => call.id),
    ["merged_1", "merged_2"]
  );
  assert.deepEqual(JSON.parse(repaired.calls[0].function.arguments), JSON.parse(first));
  assert.deepEqual(JSON.parse(repaired.calls[1].function.arguments), JSON.parse(second));

  const prepared = prepareGhostToolCalls([merged], payloadWithGraph(), graphInterceptor);
  assert.equal(prepared.kind, "ready");
  assert.equal(prepared.calls.length, 2);
});

test("preflight rejects malformed, unadvertised, and schema-invalid background calls", () => {
  const payload = payloadWithGraph();

  const malformed = prepareGhostToolCalls(
    [graphCall({ argumentsText: '{"query_type":' })],
    payload,
    graphInterceptor
  );
  assert.equal(malformed.kind, "rejected");
  assert.equal(malformed.reason, "invalid_tool_call");

  const duplicateName = prepareGhostToolCalls(
    [graphCall({ name: GRAPH_NAME + GRAPH_NAME })],
    payload,
    graphInterceptor
  );
  assert.equal(duplicateName.kind, "rejected");

  const invalidSchema = prepareGhostToolCalls(
    [
      graphCall({
        argumentsText: JSON.stringify({
          query_type: "not_a_query",
          target: "File",
          surprise: true,
        }),
      }),
    ],
    payload,
    graphInterceptor
  );
  assert.equal(invalidSchema.kind, "rejected");
  assert.match(invalidSchema.message, /schema validation failed/);
});

test("preflight normalizes object-form provider arguments before schema validation", () => {
  const call = graphCall();
  call.function.arguments = { query_type: "find_symbol", target: "File" };
  const prepared = prepareGhostToolCalls([call], payloadWithGraph(), graphInterceptor);
  assert.equal(prepared.kind, "ready");
  assert.equal(
    prepared.calls[0].function.arguments,
    '{"query_type":"find_symbol","target":"File"}'
  );
});

test("preflight preserves mixed client/background batches instead of dropping client tools", () => {
  const prepared = prepareGhostToolCalls(
    [
      graphCall(),
      {
        id: "client_write",
        type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: "a.js", content: "x" }) },
      },
    ],
    payloadWithGraph(),
    graphInterceptor
  );

  assert.equal(prepared.kind, "passthrough");
  assert.equal(prepared.calls.length, 2);
});

test("schema validation canonicalizes empty no-argument calls but rejects scalar JSON", () => {
  const schemas = new Map([
    ["memory_list", { type: "object", properties: {}, required: [], additionalProperties: false }],
  ]);
  const empty = validateActiveToolCall(
    { id: "m1", function: { name: "memory_list", arguments: "" } },
    schemas
  );
  assert.equal(empty.ok, true);
  assert.equal(empty.normalizedArguments, "{}");

  const scalar = validateActiveToolCall(
    { id: "m2", function: { name: "memory_list", arguments: "[]" } },
    schemas
  );
  assert.equal(scalar.ok, false);
});
