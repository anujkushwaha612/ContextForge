import assert from "node:assert/strict";
import test from "node:test";

import { injectContextForgeRule } from "../../src/proxy/systemMessages.js";
import { applyStableToolSet } from "../../src/proxy/stableTools.js";

function basePayload() {
  return {
    messages: [{ role: "user", content: "Please update a function." }],
    tools: [],
  };
}

test("bare stable-tool sessions receive bare ContextForge guidance", () => {
  const payload = basePayload();
  const withRule = injectContextForgeRule(payload, { mcpSession: false });
  const system = withRule.messages[0].content;

  assert.match(system, /`contextforge_query_graph`/);
  assert.doesNotMatch(system, /mcp__contextforge__contextforge_query_graph/);

  const { added, tools } = applyStableToolSet(withRule, { mcpSession: false });
  assert.deepEqual(added, [
    "contextforge_query_graph",
    "contextforge_patch_ast",
    "read_file_chunk",
  ]);
  assert.deepEqual(
    tools.slice(-3).map((tool) => tool.function.name),
    ["contextforge_query_graph", "contextforge_patch_ast", "read_file_chunk"]
  );
});

test("a sentinel rule is updated when a conversation changes tool namespace", () => {
  const bare = injectContextForgeRule(basePayload(), { mcpSession: false });
  const mcp = injectContextForgeRule(bare, { mcpSession: true });
  assert.match(mcp.messages[0].content, /mcp__contextforge__contextforge_query_graph/);

  const direct = injectContextForgeRule(mcp, {
    mcpSession: true,
    toolPrefix: "contextforge__",
  });
  assert.match(direct.messages[0].content, /contextforge__contextforge_query_graph/);
  assert.doesNotMatch(direct.messages[0].content, /mcp__contextforge__contextforge_query_graph/);
});

test("ContextForge-added schemas are stable, exact, and strict", () => {
  const payload = {
    messages: [
      { role: "user", content: "Please inspect this." },
      {
        role: "tool",
        name: "read_file_chunk",
        content: "[CF_VAULT:cf_vault_test] compressed result",
      },
    ],
    tools: [],
  };

  const { tools } = applyStableToolSet(payload, { mcpSession: false });
  const names = tools.map((tool) => tool.function.name);
  assert.deepEqual(names.slice(-4), [
    "contextforge_query_graph",
    "contextforge_patch_ast",
    "read_file_chunk",
    "contextforge_retrieve",
  ]);

  for (const tool of tools.slice(-4)) {
    assert.equal(tool.type, "function");
    assert.equal(tool.function.parameters.type, "object");
  }
  assert.equal(tools.at(-1).function.parameters.additionalProperties, false);
});

test("non-MCP namespaced sessions use their actual advertised prefix", () => {
  const payload = {
    messages: [{ role: "user", content: "Please update a function." }],
    tools: [
      {
        type: "function",
        function: {
          name: "contextforge__contextforge_query_graph",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };

  const withRule = injectContextForgeRule(payload, {
    mcpSession: true,
    toolPrefix: "contextforge__",
  });
  assert.match(withRule.messages[0].content, /contextforge__contextforge_query_graph/);
  assert.doesNotMatch(withRule.messages[0].content, /mcp__contextforge__contextforge_query_graph/);
});

test("MCP-owned sessions retain MCP guidance and do not receive duplicate bare schemas", () => {
  const payload = {
    messages: [{ role: "user", content: "Please update a function." }],
    tools: [
      {
        type: "function",
        function: {
          name: "mcp__contextforge__contextforge_query_graph",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };

  const withRule = injectContextForgeRule(payload, { mcpSession: true });
  assert.match(withRule.messages[0].content, /mcp__contextforge__contextforge_query_graph/);

  const { added, tools } = applyStableToolSet(withRule, { mcpSession: true });
  assert.deepEqual(added, []);
  assert.equal(tools.length, 1);
});
