// tests/unit/graphTools.test.js

import { jest } from "@jest/globals";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Mock graphDb — all DB calls are pure lookups, no real DB needed
// ─────────────────────────────────────────────────────────────────────────────

jest.unstable_mockModule("../../src/graph/graphDb.js", () => ({
  queryWhoImportsThis: jest.fn(() => []),
  queryWhatDoesThisExport: jest.fn(() => []),
  queryFindSymbol: jest.fn(() => []),
  queryFindSymbolFuzzy: jest.fn(() => []),
  queryWhatDoesThisImport: jest.fn(() => []),
  queryWhoDependsOnFile: jest.fn(() => []),
  queryWhoCallsThis: jest.fn(() => []),
  queryWhatDoesThisCall: jest.fn(() => []),
  querySymbolImpact: jest.fn(() => []),
  querySymbolDependencies: jest.fn(() => []),
  queryFindRoutes: jest.fn(() => []),
  getGraphStats: jest.fn(() => ({ node_count: 42 })),
  writeFileGraph: jest.fn(),
}));

jest.unstable_mockModule("../../src/proxy/statsEmitter.js", () => ({
  statsEmitter: {
    recordAgentAction: jest.fn(),
    recordGraphQuery: jest.fn(),
    recordRequest: jest.fn(),
    getSnapshot: jest.fn(() => ({})),
    on: jest.fn(),
    off: jest.fn(),
    agentActions: { graphLookups: 0, surgicalReads: 0, astPatches: 0, rawVaultOpens: 0 },
  },
}));

const {
  queryFindSymbol,
  queryFindSymbolFuzzy,
  queryWhoImportsThis,
  queryWhatDoesThisExport,
  queryWhoCallsThis,
  queryFindRoutes,
  querySymbolImpact,
} = await import("../../src/graph/graphDb.js");

const {
  isGraphToolCall,
  isReadFileChunkTool,
  normalizeGraphToolName,
  executeGraphQuery,
  executeReadFileChunk,
  injectGraphTool,
  injectReadFileChunkTool,
  GRAPH_TOOL_NAME,
  READ_FILE_CHUNK_TOOL_NAME,
} = await import("../../src/graph/graphTools.js");

// ─────────────────────────────────────────────────────────────────────────────
// isGraphToolCall
// ─────────────────────────────────────────────────────────────────────────────

describe("isGraphToolCall", () => {
  test.each([
    "contextforge_query_graph",
    "mcp__contextforge__contextforge_query_graph",
    "contextforge__contextforge_query_graph",
  ])('"%s" → true', (name) => {
    expect(isGraphToolCall(name)).toBe(true);
  });

  test.each([
    "search_code",
    "contextforge_patch_ast",
    "read_file_chunk",
    "contextforge_retrieve",
    "",
    null,
  ])('"%s" → false', (name) => {
    expect(isGraphToolCall(name)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isReadFileChunkTool
// ─────────────────────────────────────────────────────────────────────────────

describe("isReadFileChunkTool", () => {
  test("read_file_chunk → true", () => {
    expect(isReadFileChunkTool("read_file_chunk")).toBe(true);
  });

  test("name containing read_file_chunk → true", () => {
    expect(isReadFileChunkTool("mcp__read_file_chunk")).toBe(true);
  });

  test("contextforge_query_graph → false", () => {
    expect(isReadFileChunkTool("contextforge_query_graph")).toBe(false);
  });

  test("null → false", () => {
    expect(isReadFileChunkTool(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeGraphToolName
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeGraphToolName", () => {
  test("canonical name → unchanged", () => {
    expect(normalizeGraphToolName("contextforge_query_graph")).toBe(
      "contextforge_query_graph"
    );
  });

  test("mcp__ prefix → stripped to canonical", () => {
    expect(
      normalizeGraphToolName("mcp__contextforge__contextforge_query_graph")
    ).toBe("contextforge_query_graph");
  });

  test("unknown name → returned as-is", () => {
    expect(normalizeGraphToolName("search_code")).toBe("search_code");
  });

  test("null → null", () => {
    expect(normalizeGraphToolName(null)).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeGraphQuery — find_symbol
// ─────────────────────────────────────────────────────────────────────────────

describe("executeGraphQuery — find_symbol", () => {
  beforeEach(() => jest.clearAllMocks());

  test("exact match found → returns definitions with body", () => {
    queryFindSymbol.mockReturnValueOnce([
      {
        file_path: "src/auth.js",
        kind: "function",
        start_line: 10,
        end_line: 25,
        complexity: 3,
        body_text: "function authenticate() {\n  return true;\n}",
        name: "authenticate",
      },
    ]);

    const raw = executeGraphQuery("find_symbol", "authenticate");
    const parsed = JSON.parse(raw);

    expect(parsed.symbol).toBe("authenticate");
    expect(parsed.fuzzy_match).toBe(false);
    expect(parsed.count).toBe(1);
    expect(parsed.definitions[0].file).toBe("src/auth.js");
    expect(parsed.definitions[0].start_line).toBe(10);
    expect(parsed.definitions[0].body).toContain("authenticate");
  });

  test("body capped at 1500 chars → truncation note appended", () => {
    const longBody = "x".repeat(2000);
    queryFindSymbol.mockReturnValueOnce([
      {
        file_path: "src/big.js",
        kind: "function",
        start_line: 1,
        end_line: 100,
        complexity: 10,
        body_text: longBody,
        name: "bigFn",
      },
    ]);

    const raw = executeGraphQuery("find_symbol", "bigFn");
    const parsed = JSON.parse(raw);

    expect(parsed.definitions[0].body).toContain("more lines truncated");
    expect(parsed.definitions[0].body.length).toBeLessThan(2000);
  });

  test("exact miss → falls back to fuzzy match", () => {
    queryFindSymbol.mockReturnValueOnce([]);
    queryFindSymbolFuzzy.mockReturnValueOnce([
      {
        file_path: "src/auth.js",
        kind: "function",
        start_line: 10,
        end_line: 20,
        complexity: 2,
        body_text: "function authenticateUser() {}",
        name: "authenticateUser",
      },
    ]);

    const raw = executeGraphQuery("find_symbol", "auth");
    const parsed = JSON.parse(raw);

    expect(parsed.fuzzy_match).toBe(true);
    expect(parsed.fuzzy_note).toMatch(/partial match/i);
    expect(parsed.count).toBe(1);
  });

  test("no exact or fuzzy match → not_found result", () => {
    queryFindSymbol.mockReturnValueOnce([]);
    queryFindSymbolFuzzy.mockReturnValueOnce([]);

    const raw = executeGraphQuery("find_symbol", "nonExistentSymbol");
    const parsed = JSON.parse(raw);

    expect(parsed.result).toBe("not_found");
    expect(parsed.symbol).toBe("nonExistentSymbol");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeGraphQuery — who_imports_this
// ─────────────────────────────────────────────────────────────────────────────

describe("executeGraphQuery — who_imports_this", () => {
  beforeEach(() => jest.clearAllMocks());

  test("imports found → returns imported_by list", () => {
    queryWhoImportsThis.mockReturnValueOnce([
      { source_file: "src/server.js", source_symbol: "handleRequest" },
      { source_file: "src/test.js", source_symbol: null },
    ]);

    const raw = executeGraphQuery("who_imports_this", "authenticate");
    const parsed = JSON.parse(raw);

    expect(parsed.count).toBe(2);
    expect(parsed.imported_by[0].file).toBe("src/server.js");
    expect(parsed.imported_by[1].symbol).toBe("(file-level import)");
  });

  test("no imports → not_found result", () => {
    queryWhoImportsThis.mockReturnValueOnce([]);
    const raw = executeGraphQuery("who_imports_this", "privateHelper");
    const parsed = JSON.parse(raw);
    expect(parsed.result).toBe("not_found");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeGraphQuery — find_route
// ─────────────────────────────────────────────────────────────────────────────

describe("executeGraphQuery — find_route", () => {
  beforeEach(() => jest.clearAllMocks());

  test("named handler route → includes patch_hint with find_symbol suggestion", () => {
    queryFindRoutes.mockReturnValueOnce([
      {
        route_path: "/v1/chat/completions",
        source_file: "src/server.js",
        source_line: 42,
        handler: "handleChat",
      },
    ]);

    const raw = executeGraphQuery("find_route", "/v1/chat");
    const parsed = JSON.parse(raw);

    expect(parsed.routes[0].route).toBe("/v1/chat/completions");
    expect(parsed.routes[0].start_line).toBe(42);
    expect(parsed.routes[0].patch_hint).toContain("find_symbol");
    expect(parsed.routes[0].patch_hint).toContain("handleChat");
  });

  test("inline anonymous handler with source_line → insert_at_line hint", () => {
    queryFindRoutes.mockReturnValueOnce([
      {
        route_path: "/v1/stats/stream",
        source_file: "src/server.js",
        source_line: 88,
        handler: null,
      },
    ]);

    const raw = executeGraphQuery("find_route", "/v1/stats");
    const parsed = JSON.parse(raw);

    expect(parsed.routes[0].patch_hint).toContain("insert_at_line");
    expect(parsed.routes[0].patch_hint).toContain("88");
  });

  test("no routes found → no_routes result", () => {
    queryFindRoutes.mockReturnValueOnce([]);
    const raw = executeGraphQuery("find_route", "/nonexistent");
    const parsed = JSON.parse(raw);
    expect(parsed.result).toBe("no_routes");
  });

  test("empty target → lists all routes", () => {
    queryFindRoutes.mockReturnValueOnce([
      { route_path: "/healthz", source_file: "src/server.js", source_line: 5, handler: "healthCheck" },
    ]);
    const raw = executeGraphQuery("find_route", "");
    const parsed = JSON.parse(raw);
    expect(parsed.filter).toBe("(all routes)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeGraphQuery — show_callers
// ─────────────────────────────────────────────────────────────────────────────

describe("executeGraphQuery — show_callers", () => {
  beforeEach(() => jest.clearAllMocks());

  test("callers found → returns caller list with hint", () => {
    queryWhoCallsThis.mockReturnValueOnce([
      { source_file: "src/server.js", source_symbol: "handleRequest", source_line: 55 },
    ]);

    const raw = executeGraphQuery("show_callers", "authenticate");
    const parsed = JSON.parse(raw);

    expect(parsed.count).toBe(1);
    expect(parsed.callers[0].file).toBe("src/server.js");
    expect(parsed.hint).toBeTruthy();
  });

  test("no callers → no_callers with next-step guidance", () => {
    queryWhoCallsThis.mockReturnValueOnce([]);
    const raw = executeGraphQuery("show_callers", "orphanedFn");
    const parsed = JSON.parse(raw);

    expect(parsed.result).toBe("no_callers");
    // G5 fix: guides LLM to who_imports_this instead of retrying show_callers
    expect(parsed.message).toContain("who_imports_this");
    expect(parsed.message).toContain("Do NOT retry show_callers");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeGraphQuery — unknown query type
// ─────────────────────────────────────────────────────────────────────────────

describe("executeGraphQuery — unknown query type", () => {
  test("unknown query_type → error with valid_types list", () => {
    const raw = executeGraphQuery("do_magic", "foo");
    const parsed = JSON.parse(raw);
    expect(parsed.error).toBe("unknown_query_type");
    expect(Array.isArray(parsed.valid_types)).toBe(true);
    expect(parsed.valid_types).toContain("find_symbol");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeGraphQuery — null/undefined target
// ─────────────────────────────────────────────────────────────────────────────

describe("executeGraphQuery — null target", () => {
  test("null target → error response", () => {
    const raw = executeGraphQuery("find_symbol", null);
    const parsed = JSON.parse(raw);
    expect(parsed.error).toMatch(/target is required/i);
  });

  test("undefined target → error response", () => {
    const raw = executeGraphQuery("find_symbol", undefined);
    const parsed = JSON.parse(raw);
    expect(parsed.error).toMatch(/target is required/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeReadFileChunk
// ─────────────────────────────────────────────────────────────────────────────

describe("executeReadFileChunk", () => {
  let tmpFile;

  beforeAll(() => {
    // Create a real temp file with known content for chunk reading tests
    tmpFile = path.join(os.tmpdir(), `cf_test_chunk_${Date.now()}.js`);
    fs.writeFileSync(
      tmpFile,
      [
        "line 1 - function header",
        "line 2 - body start",
        "line 3 - middle",
        "line 4 - body end",
        "line 5 - closing brace",
      ].join("\n"),
      "utf-8"
    );
  });

  afterAll(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  test("valid range → returns correct lines and content", () => {
    const raw = executeReadFileChunk(tmpFile, 2, 4);
    const parsed = JSON.parse(raw);

    expect(parsed.start_line).toBe(2);
    expect(parsed.end_line).toBe(4);
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.content).toContain("line 2 - body start");
    expect(parsed.content).toContain("line 4 - body end");
  });

  test("start_line=1 reads from beginning", () => {
    const raw = executeReadFileChunk(tmpFile, 1, 2);
    const parsed = JSON.parse(raw);
    expect(parsed.lines[0]).toBe("line 1 - function header");
  });

  test("end_line beyond file → clamped to file length", () => {
    const raw = executeReadFileChunk(tmpFile, 4, 99999);
    const parsed = JSON.parse(raw);
    expect(parsed.end_line).toBe(5);
    expect(parsed.total_lines).toBe(5);
  });

  test("start_line beyond file → error", () => {
    const raw = executeReadFileChunk(tmpFile, 100, 200);
    const parsed = JSON.parse(raw);
    expect(parsed.error).toMatch(/beyond file end/i);
  });

  test("invalid range (end < start) → error", () => {
    const raw = executeReadFileChunk(tmpFile, 5, 2);
    const parsed = JSON.parse(raw);
    expect(parsed.error).toMatch(/invalid line range/i);
  });

  test("non-existent file → File not found error", () => {
    const raw = executeReadFileChunk("/nonexistent/path/file.js", 1, 10);
    const parsed = JSON.parse(raw);
    expect(parsed.error).toMatch(/not found/i);
  });

  test("null file_path → error", () => {
    const raw = executeReadFileChunk(null, 1, 10);
    const parsed = JSON.parse(raw);
    expect(parsed.error).toMatch(/file_path is required/i);
  });

  test("CRLF normalized in returned content", () => {
    const crlfFile = path.join(os.tmpdir(), `cf_test_crlf_${Date.now()}.js`);
    fs.writeFileSync(crlfFile, "line 1\r\nline 2\r\nline 3", "utf-8");

    const raw = executeReadFileChunk(crlfFile, 1, 3);
    const parsed = JSON.parse(raw);

    // Content must not contain raw \r\n
    expect(parsed.content).not.toContain("\r\n");
    expect(parsed.lines).toHaveLength(3);

    fs.unlinkSync(crlfFile);
  });

  test("result includes hint for patching", () => {
    const raw = executeReadFileChunk(tmpFile, 1, 3);
    const parsed = JSON.parse(raw);
    expect(parsed.hint).toContain("contextforge_patch_ast");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// injectGraphTool
// ─────────────────────────────────────────────────────────────────────────────

describe("injectGraphTool", () => {
  test("null tools → returns array with graph tool", () => {
    const result = injectGraphTool(null);
    expect(Array.isArray(result)).toBe(true);
    const names = result.map((t) => t.function?.name);
    expect(names).toContain(GRAPH_TOOL_NAME);
  });

  test("empty tools → injects graph tool", () => {
    const result = injectGraphTool([]);
    expect(result.some((t) => t.function?.name === GRAPH_TOOL_NAME)).toBe(true);
  });

  test("graph tool already present → no duplicate injected", () => {
    const existing = [{ type: "function", function: { name: GRAPH_TOOL_NAME } }];
    const result = injectGraphTool(existing);
    const count = result.filter((t) => t.function?.name === GRAPH_TOOL_NAME).length;
    expect(count).toBe(1);
  });

  test("does not mutate input array", () => {
    const original = [{ type: "function", function: { name: "other_tool" } }];
    const originalLength = original.length;
    injectGraphTool(original);
    expect(original).toHaveLength(originalLength);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// injectReadFileChunkTool
// ─────────────────────────────────────────────────────────────────────────────

describe("injectReadFileChunkTool", () => {
  test("null tools → injects read_file_chunk", () => {
    const result = injectReadFileChunkTool(null);
    expect(result.some((t) => t.function?.name === READ_FILE_CHUNK_TOOL_NAME)).toBe(true);
  });

  test("tool already present → no duplicate", () => {
    const existing = [{ type: "function", function: { name: READ_FILE_CHUNK_TOOL_NAME } }];
    const result = injectReadFileChunkTool(existing);
    const count = result.filter((t) => t.function?.name === READ_FILE_CHUNK_TOOL_NAME).length;
    expect(count).toBe(1);
  });

  test("does not mutate input", () => {
    const original = [{ type: "function", function: { name: "other" } }];
    injectReadFileChunkTool(original);
    expect(original).toHaveLength(1);
  });
});