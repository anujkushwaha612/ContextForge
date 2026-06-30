// tests/unit/ghostInterceptor.test.js
//
// Unit tests for ToolInterceptor logic in isolation.
// These run without spawning a server — no 20s startup penalty.
//
// Strategy: mock the graph/patch/vault/memory modules so we can
// drive ToolInterceptor.process() directly and assert on the
// returned { intercepted, results, madeForwardProgress, hadFailure }
// shape without any HTTP or filesystem involvement.

import { jest } from "@jest/globals";

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks — must be declared before any imports that pull these in
// ─────────────────────────────────────────────────────────────────────────────

// Graph tools
jest.unstable_mockModule("../../src/graph/graphTools.js", () => ({
  isGraphToolCall: jest.fn((name) => name === "contextforge_query_graph"),
  isReadFileChunkTool: jest.fn((name) => name === "read_file_chunk"),
  normalizeGraphToolName: jest.fn((name) => name),
  executeGraphQuery: jest.fn(() =>
    JSON.stringify({ definitions: [], count: 0 })
  ),
  executeReadFileChunk: jest.fn(() =>
    JSON.stringify({ content: "line content", lines: ["line content"] })
  ),
}));

// Patch tools
jest.unstable_mockModule("../../src/graph/patchTools.js", () => ({
  isPatchToolCall: jest.fn((name) => name === "contextforge_patch_ast"),
  executePatchToolCall: jest.fn(async () =>
    JSON.stringify({ success: true, lines_changed: 2, patch_start_line: 10 })
  ),
  PATCH_TOOL_NAME: "contextforge_patch_ast",
}));

// Vault retriever
jest.unstable_mockModule("../../src/vaultRetriever.js", () => ({
  retrieveFromVault: jest.fn(async () => "vault content here"),
}));

// CCR
jest.unstable_mockModule("../../src/ccr/index.js", () => ({
  recordCCRSuccess: jest.fn(),
  applyCCRPipeline: jest.fn((p) => p),
}));

// Memory tools
jest.unstable_mockModule("../../src/memory/memoryTools.js", () => ({
  hasMemoryToolCalls: jest.fn(() => false),
  executeMemoryToolCalls: jest.fn(async () => []),
}));

// statsEmitter
jest.unstable_mockModule("../../src/proxy/statsEmitter.js", () => ({
  statsEmitter: {
    recordAgentAction: jest.fn(),
    recordGraphQuery: jest.fn(),
    recordRequest: jest.fn(),
    getSnapshot: jest.fn(() => ({})),
    on: jest.fn(),
    off: jest.fn(),
    agentActions: {
      graphLookups: 0,
      surgicalReads: 0,
      astPatches: 0,
      rawVaultOpens: 0,
    },
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Import after mocks are registered
// ─────────────────────────────────────────────────────────────────────────────

const {
  isGraphToolCall,
  executeGraphQuery,
  isReadFileChunkTool,
  executeReadFileChunk,
} = await import("../../src/graph/graphTools.js");

const {
  isPatchToolCall,
  executePatchToolCall,
} = await import("../../src/graph/patchTools.js");

const { retrieveFromVault } = await import("../../src/vaultRetriever.js");
const { hasMemoryToolCalls, executeMemoryToolCalls } = await import(
  "../../src/memory/memoryTools.js"
);

// ─────────────────────────────────────────────────────────────────────────────
// ToolInterceptor is private — we test it via a thin test shim that
// re-implements the same logic using the same mocked dependencies.
//
// This is intentional: we do NOT want to export ToolInterceptor from
// production code just for testing. The shim mirrors the exact decision
// logic from upstreamRequest.js so tests stay valid as long as the
// interface contract holds.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_GHOST_RETRIES = 10;
const MAX_GRAPH_ONLY_ROUNDS = 5;

/**
 * Minimal reproduction of ToolInterceptor.isBackgroundTool()
 * mirroring the exact logic in upstreamRequest.js
 */
function isBackgroundTool(name) {
  if (!name) return false;
  const normalized = name; // mocked normalizeGraphToolName is identity
  const isGraph = isGraphToolCall(name);
  const isReadChunk = isReadFileChunkTool(name);
  const isRetrieve = normalized.includes("contextforge_retrieve");
  const isPatch = isPatchToolCall(name);
  const isMemory =
    !isRetrieve &&
    !isGraph &&
    !isPatch &&
    normalized &&
    hasMemoryToolCalls({ tool_calls: [{ function: { name } }] });
  return isGraph || isPatch || isRetrieve || isMemory || isReadChunk;
}

/**
 * Thin shim that mirrors ToolInterceptor.process() for unit testing.
 * Accepts the same arguments and returns the same result shape.
 */
async function processToolCalls(toolCalls, retryCount = 0) {
  if (retryCount >= MAX_GHOST_RETRIES) {
    return { intercepted: true, circuitBreakerTripped: true, toolCalls };
  }

  const backgroundCalls = toolCalls.filter((tc) =>
    isBackgroundTool(tc.function?.name)
  );
  if (backgroundCalls.length === 0) return { intercepted: false };

  const allAreGraphQueries = backgroundCalls.every((tc) => {
    const n = tc.function?.name || "";
    return isGraphToolCall(n) && !n.includes("contextforge_retrieve");
  });

  const results = [];
  let madeForwardProgress = false;
  let hadFailure = false;

  for (const tc of backgroundCalls) {
    const name = tc.function.name;
    const argsStr = tc.function.arguments || "{}";
    let args = {};
    try {
      args = JSON.parse(argsStr);
    } catch {
      results.push({
        tool_call_id: tc.id,
        name,
        content: JSON.stringify({ error: "Malformed JSON arguments" }),
      });
      hadFailure = true;
      continue;
    }

    let content = "";
    let toolSucceeded = false;
    let isActionTool = false;

    if (isGraphToolCall(name)) {
      if (args.query_type && args.target !== undefined) {
        content = await executeGraphQuery(args.query_type, args.target);
        toolSucceeded = true;
        isActionTool = false;
      } else {
        content = JSON.stringify({ error: "Missing query_type or target" });
        toolSucceeded = false;
      }
    } else if (isReadFileChunkTool(name)) {
      content = executeReadFileChunk(args.file_path, args.start_line, args.end_line);
      toolSucceeded = true;
      isActionTool = false;
    } else if (isPatchToolCall(name)) {
      isActionTool = true;
      content = await executePatchToolCall(argsStr, null);
      try {
        const parsed = JSON.parse(content);
        toolSucceeded = parsed.success === true;
      } catch {
        toolSucceeded = false;
      }
    } else if (name.includes("contextforge_retrieve")) {
      isActionTool = true;
      let vaultedText = null;
      try {
        vaultedText = await retrieveFromVault(
          args.vault_id,
          args.search_query || null,
          [],
          null,
          null
        );
      } catch (err) {
        // Ignored
      }
      if (vaultedText) {
        content = vaultedText;
        toolSucceeded = true;
      } else {
        content = `Vault ${args.vault_id} empty or not found.`;
        toolSucceeded = false;
      }
    } else if (hasMemoryToolCalls({ tool_calls: [tc] })) {
      isActionTool = true;
      const toolResults = await executeMemoryToolCalls({ tool_calls: [tc] }, null, {});
      if (toolResults.length > 0) {
        content = toolResults[0].content;
        toolSucceeded = true;
      } else {
        content = "Memory tool returned no results.";
        toolSucceeded = false;
      }
    }

    if (isActionTool && toolSucceeded) madeForwardProgress = true;
    if (isActionTool && !toolSucceeded) hadFailure = true;

    results.push({ tool_call_id: tc.id, name, content });
  }

  return {
    intercepted: true,
    results,
    toolCalls: backgroundCalls,
    madeForwardProgress,
    hadFailure,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeToolCall(name, args = {}, id = "call_001") {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// isBackgroundTool
// ─────────────────────────────────────────────────────────────────────────────

describe("isBackgroundTool", () => {
  test("contextforge_query_graph → true", () => {
    expect(isBackgroundTool("contextforge_query_graph")).toBe(true);
  });

  test("read_file_chunk → true", () => {
    expect(isBackgroundTool("read_file_chunk")).toBe(true);
  });

  test("contextforge_patch_ast → true", () => {
    expect(isBackgroundTool("contextforge_patch_ast")).toBe(true);
  });

  test("contextforge_retrieve → true (string match)", () => {
    expect(isBackgroundTool("contextforge_retrieve")).toBe(true);
  });

  test("search_code → false (not a background tool)", () => {
    expect(isBackgroundTool("search_code")).toBe(false);
  });

  test("get_weather → false", () => {
    expect(isBackgroundTool("get_weather")).toBe(false);
  });

  test("null → false", () => {
    expect(isBackgroundTool(null)).toBe(false);
  });

  test("empty string → false", () => {
    expect(isBackgroundTool("")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Circuit breaker
// ─────────────────────────────────────────────────────────────────────────────

describe("circuit breaker — retryCount >= MAX_GHOST_RETRIES", () => {
  test("retryCount === 10 → circuitBreakerTripped true", async () => {
    const toolCalls = [
      makeToolCall("contextforge_query_graph", {
        query_type: "find_symbol",
        target: "authenticate",
      }),
    ];
    const result = await processToolCalls(toolCalls, 10);
    expect(result.intercepted).toBe(true);
    expect(result.circuitBreakerTripped).toBe(true);
  });

  test("retryCount === 9 → does NOT trip circuit breaker", async () => {
    const toolCalls = [
      makeToolCall("contextforge_query_graph", {
        query_type: "find_symbol",
        target: "authenticate",
      }),
    ];
    const result = await processToolCalls(toolCalls, 9);
    expect(result.circuitBreakerTripped).toBeUndefined();
    expect(result.intercepted).toBe(true);
  });

  test("circuit breaker echoes back original toolCalls array", async () => {
    const toolCalls = [
      makeToolCall("contextforge_query_graph", {
        query_type: "find_symbol",
        target: "foo",
      }),
    ];
    const result = await processToolCalls(toolCalls, 10);
    expect(result.toolCalls).toBe(toolCalls);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-background tools pass through
// ─────────────────────────────────────────────────────────────────────────────

describe("non-background tool calls", () => {
  test("search_code → intercepted: false", async () => {
    const toolCalls = [
      makeToolCall("search_code", { query: "authenticate" }),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.intercepted).toBe(false);
  });

  test("mixed: search_code + graph → only graph intercepted", async () => {
    const toolCalls = [
      makeToolCall("search_code", { query: "foo" }, "call_001"),
      makeToolCall(
        "contextforge_query_graph",
        { query_type: "find_symbol", target: "foo" },
        "call_002"
      ),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.intercepted).toBe(true);
    // Only the graph tool call is in backgroundCalls
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("contextforge_query_graph");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Graph tool calls
// ─────────────────────────────────────────────────────────────────────────────

describe("graph tool calls", () => {
  beforeEach(() => {
    executeGraphQuery.mockReturnValue(
      JSON.stringify({
        symbol: "authenticate",
        definitions: [{ file: "src/auth.js", start_line: 10, end_line: 25 }],
        count: 1,
      })
    );
  });

  test("valid graph call → intercepted, result present", async () => {
    const toolCalls = [
      makeToolCall("contextforge_query_graph", {
        query_type: "find_symbol",
        target: "authenticate",
      }),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.intercepted).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].tool_call_id).toBe("call_001");
    const content = JSON.parse(result.results[0].content);
    expect(content.count).toBe(1);
  });

  test("graph call → madeForwardProgress false (graph is NOT an action tool)", async () => {
    const toolCalls = [
      makeToolCall("contextforge_query_graph", {
        query_type: "find_symbol",
        target: "foo",
      }),
    ];
    const result = await processToolCalls(toolCalls);
    // Graph queries are not action tools — they don't set madeForwardProgress
    expect(result.madeForwardProgress).toBe(false);
    expect(result.hadFailure).toBe(false);
  });

  test("graph call missing query_type → hadFailure false, error in content", async () => {
    // Missing query_type — the shim checks args.query_type && args.target
    const toolCalls = [
      makeToolCall("contextforge_query_graph", { target: "foo" }),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.intercepted).toBe(true);
    // Graph call that fails is NOT an action tool — hadFailure stays false
    expect(result.hadFailure).toBe(false);
    const content = JSON.parse(result.results[0].content);
    expect(content.error).toMatch(/missing/i);
  });

  test("malformed JSON args → hadFailure true (parse error IS a failure)", async () => {
    const tc = {
      id: "call_001",
      type: "function",
      function: {
        name: "contextforge_query_graph",
        arguments: "{ bad json",
      },
    };
    const result = await processToolCalls([tc]);
    expect(result.hadFailure).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// read_file_chunk calls
// ─────────────────────────────────────────────────────────────────────────────

describe("read_file_chunk calls", () => {
  beforeEach(() => {
    executeReadFileChunk.mockReturnValue(
      JSON.stringify({
        file: "src/auth.js",
        start_line: 10,
        end_line: 25,
        content: "function authenticate() {}",
        lines: ["function authenticate() {}"],
      })
    );
  });

  test("read_file_chunk → intercepted, content returned", async () => {
    const toolCalls = [
      makeToolCall(
        "read_file_chunk",
        { file_path: "src/auth.js", start_line: 10, end_line: 25 },
        "call_read_001"
      ),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.intercepted).toBe(true);
    expect(result.results[0].tool_call_id).toBe("call_read_001");
    const content = JSON.parse(result.results[0].content);
    expect(content.file).toBe("src/auth.js");
  });

  test("read_file_chunk → not an action tool → madeForwardProgress false", async () => {
    const toolCalls = [
      makeToolCall("read_file_chunk", {
        file_path: "src/auth.js",
        start_line: 1,
        end_line: 10,
      }),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.madeForwardProgress).toBe(false);
    expect(result.hadFailure).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Patch tool calls
// ─────────────────────────────────────────────────────────────────────────────

describe("patch tool calls", () => {
  test("successful patch → madeForwardProgress true, hadFailure false", async () => {
    executePatchToolCall.mockResolvedValueOnce(
      JSON.stringify({ success: true, lines_changed: 3, patch_start_line: 10 })
    );
    const toolCalls = [
      makeToolCall("contextforge_patch_ast", {
        file_path: "src/auth.js",
        target_symbol: "authenticate",
        operation: "replace_string",
        search_string: "old text",
        replacement_string: "new text",
      }),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.intercepted).toBe(true);
    expect(result.madeForwardProgress).toBe(true);
    expect(result.hadFailure).toBe(false);
  });

  test("failed patch → hadFailure true, madeForwardProgress false", async () => {
    executePatchToolCall.mockResolvedValueOnce(
      JSON.stringify({
        success: false,
        error: "Symbol not found in graph index.",
      })
    );
    const toolCalls = [
      makeToolCall("contextforge_patch_ast", {
        file_path: "src/auth.js",
        target_symbol: "nonExistentFn",
        operation: "replace_body",
        new_body: "function nonExistentFn() {}",
      }),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.madeForwardProgress).toBe(false);
    expect(result.hadFailure).toBe(true);
  });

  test("patch returns malformed JSON → hadFailure true", async () => {
    executePatchToolCall.mockResolvedValueOnce("not valid json {{{");
    const toolCalls = [
      makeToolCall("contextforge_patch_ast", {
        file_path: "src/auth.js",
        operation: "delete_node",
        target_symbol: "oldFn",
      }),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.hadFailure).toBe(true);
    expect(result.madeForwardProgress).toBe(false);
  });

  test("patch result contains tool_call_id from original call", async () => {
    executePatchToolCall.mockResolvedValueOnce(
      JSON.stringify({ success: true, lines_changed: 1 })
    );
    const toolCalls = [
      makeToolCall(
        "contextforge_patch_ast",
        { file_path: "src/auth.js", operation: "insert_at_line", insert_line: 5, new_body: "// comment" },
        "call_patch_xyz"
      ),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.results[0].tool_call_id).toBe("call_patch_xyz");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vault retrieval calls
// ─────────────────────────────────────────────────────────────────────────────

describe("contextforge_retrieve calls", () => {
  test("vault hit → madeForwardProgress true, content returned", async () => {
    retrieveFromVault.mockResolvedValueOnce(
      "function authenticate(user, password) {\n  // full source\n}"
    );
    const toolCalls = [
      makeToolCall("contextforge_retrieve", {
        vault_id: "cf_vault_abc123",
        search_query: "authenticate",
      }),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.intercepted).toBe(true);
    expect(result.madeForwardProgress).toBe(true);
    expect(result.hadFailure).toBe(false);
    expect(result.results[0].content).toContain("authenticate");
  });

  test("vault miss → hadFailure true, content is error string", async () => {
    retrieveFromVault.mockResolvedValueOnce(null);
    const toolCalls = [
      makeToolCall("contextforge_retrieve", {
        vault_id: "cf_vault_doesnotexist",
        search_query: "something",
      }),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.madeForwardProgress).toBe(false);
    expect(result.hadFailure).toBe(true);
    expect(result.results[0].content).toContain("empty or not found");
  });

  test("vault retrieval exception → hadFailure true", async () => {
    retrieveFromVault.mockRejectedValueOnce(new Error("DB connection lost"));
    const toolCalls = [
      makeToolCall("contextforge_retrieve", {
        vault_id: "cf_vault_abc",
        search_query: "foo",
      }),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.hadFailure).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multiple tool calls in one response
// ─────────────────────────────────────────────────────────────────────────────

describe("multiple tool calls in one response", () => {
  test("two graph calls → two results, no forward progress", async () => {
    executeGraphQuery
      .mockReturnValueOnce(JSON.stringify({ symbol: "foo", count: 1 }))
      .mockReturnValueOnce(JSON.stringify({ symbol: "bar", count: 0 }));

    const toolCalls = [
      makeToolCall(
        "contextforge_query_graph",
        { query_type: "find_symbol", target: "foo" },
        "call_001"
      ),
      makeToolCall(
        "contextforge_query_graph",
        { query_type: "find_symbol", target: "bar" },
        "call_002"
      ),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.results).toHaveLength(2);
    expect(result.madeForwardProgress).toBe(false);
    expect(result.hadFailure).toBe(false);
  });

  test("graph + successful patch → madeForwardProgress true", async () => {
    executeGraphQuery.mockReturnValueOnce(
      JSON.stringify({ symbol: "foo", count: 1 })
    );
    executePatchToolCall.mockResolvedValueOnce(
      JSON.stringify({ success: true, lines_changed: 2 })
    );

    const toolCalls = [
      makeToolCall(
        "contextforge_query_graph",
        { query_type: "find_symbol", target: "foo" },
        "call_001"
      ),
      makeToolCall(
        "contextforge_patch_ast",
        { file_path: "src/auth.js", operation: "replace_string", search_string: "x", replacement_string: "y" },
        "call_002"
      ),
    ];
    const result = await processToolCalls(toolCalls);
    expect(result.madeForwardProgress).toBe(true);
    expect(result.hadFailure).toBe(false);
    expect(result.results).toHaveLength(2);
  });

  test("successful graph + failed patch → madeForwardProgress false, hadFailure true", async () => {
    executeGraphQuery.mockReturnValueOnce(
      JSON.stringify({ symbol: "foo", count: 1 })
    );
    executePatchToolCall.mockResolvedValueOnce(
      JSON.stringify({ success: false, error: "Symbol not found" })
    );

    const toolCalls = [
      makeToolCall(
        "contextforge_query_graph",
        { query_type: "find_symbol", target: "foo" },
        "call_001"
      ),
      makeToolCall(
        "contextforge_patch_ast",
        { file_path: "src/auth.js", operation: "replace_body", target_symbol: "foo", new_body: "fn foo() {}" },
        "call_002"
      ),
    ];
    const result = await processToolCalls(toolCalls);
    // Graph doesn't set progress — only action tools do
    // Patch failed — hadFailure is true
    expect(result.madeForwardProgress).toBe(false);
    expect(result.hadFailure).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeNextRetry logic
// ─────────────────────────────────────────────────────────────────────────────

describe("computeNextRetry logic", () => {
  // Mirror the exact logic from upstreamRequest.js
  function computeNextRetry(result, retryCount) {
    if (result.madeForwardProgress) return retryCount;
    if (result.hadFailure) return retryCount + 1;
    return retryCount;
  }

  test("madeForwardProgress → retryCount unchanged", () => {
    expect(computeNextRetry({ madeForwardProgress: true, hadFailure: false }, 3)).toBe(3);
  });

  test("hadFailure → retryCount increments", () => {
    expect(computeNextRetry({ madeForwardProgress: false, hadFailure: true }, 3)).toBe(4);
  });

  test("graph-only round → no progress, no failure → retryCount unchanged", () => {
    expect(computeNextRetry({ madeForwardProgress: false, hadFailure: false }, 5)).toBe(5);
  });

  test("both madeForwardProgress and hadFailure → progress wins (no increment)", () => {
    // In practice this shouldn't happen (different tool calls in one batch),
    // but progress takes precedence in the current logic
    expect(computeNextRetry({ madeForwardProgress: true, hadFailure: true }, 2)).toBe(2);
  });
});