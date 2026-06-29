// tests/regression/issue-002-double-patch.test.js
//
// Regression: LLM attempted to patch the same symbol twice in one session.
//
// Root cause: after a successful patch, the LLM had no visibility into
// the current file state. It would call find_symbol again, get the stale
// cached result (or the pre-patch body from the vault), then issue an
// identical patch — which either succeeded spuriously or failed with a
// confusing "search_string not found" error.
//
// Fix: executePatchToolCall now injects verified_state into every success
// response. The verified_state includes:
//   1. The patched region read back from disk (lines N-M of the file).
//   2. A WARNING: "Do NOT retry this patch."
//   3. Proof the search_string no longer exists in this form.
//
// This regression test verifies the verified_state is present and correctly
// structured so any LLM that reads it cannot accidentally double-patch.

import { executePatchToolCall, isPatchToolCall } from "../../src/graph/patchTools.js";
import { jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Mock the graph DB — patchEngine calls resolveSymbol which queries graphDb
// ─────────────────────────────────────────────────────────────────────────────

jest.unstable_mockModule("../../src/graph/graphDb.js", () => ({
  queryFindSymbol: jest.fn(),
  writeFileGraph: jest.fn(),
}));

jest.unstable_mockModule("../../src/proxy/statsEmitter.js", () => ({
  statsEmitter: {
    recordPatchOperation: jest.fn(),
    recordAgentAction: jest.fn(),
  },
}));

jest.unstable_mockModule("../../src/logging/cacheDb.js", () => ({
  invalidateByFile: jest.fn(),
}));

jest.unstable_mockModule("../../src/compression/semanticDedup.js", () => ({
  invalidateRegistryEntry: jest.fn(),
}));

// Mock graphTools for the verified_state read-back
jest.unstable_mockModule("../../src/graph/graphTools.js", () => ({
  executeReadFileChunk: jest.fn(() =>
    JSON.stringify({
      content: "// patched content",
      lines: ["// patched content"],
    })
  ),
  isGraphToolCall: jest.fn(() => false),
  isReadFileChunkTool: jest.fn(() => false),
  normalizeGraphToolName: jest.fn((n) => n),
}));

const { queryFindSymbol } = await import("../../src/graph/graphDb.js");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTmpFile(content) {
  const p = path.join(os.tmpdir(), `cf_reg002_${Date.now()}_${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

function makeSymbolRow(filePath, startLine, endLine, bodyText) {
  return {
    file_path: filePath.replace(/\\/g, "/"),
    name: "targetFn",
    kind: "function",
    start_line: startLine,
    end_line: endLine,
    body_text: bodyText,
    body_start_line: startLine,
    body_end_line: endLine,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #002a — verified_state present in every successful patch response
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #002a — verified_state injected on success", () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  test("replace_string success → verified_state with WARNING present", async () => {
    const original = [
      "function targetFn() {",
      "  const x = oldValue;",
      "  return x;",
      "}",
    ].join("\n");

    tmpFile = makeTmpFile(original);
    const relativePath = path.relative(process.cwd(), tmpFile).replace(/\\/g, "/");

    const argsJson = JSON.stringify({
      file_path: relativePath,
      operation: "replace_string",
      search_string: "oldValue",
      replacement_string: "newValue",
    });

    const raw = await executePatchToolCall(argsJson, null);
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    // verified_state must be present
    expect(result.verified_state).toBeDefined();
    // WARNING must explicitly say not to retry
    expect(result.verified_state.WARNING).toMatch(/do not retry/i);
  });

  test("verified_state message confirms patch was applied", async () => {
    const original = "function helper() {\n  return 'before';\n}\n";
    tmpFile = makeTmpFile(original);
    const relativePath = path.relative(process.cwd(), tmpFile).replace(/\\/g, "/");

    const argsJson = JSON.stringify({
      file_path: relativePath,
      operation: "replace_string",
      search_string: "'before'",
      replacement_string: "'after'",
    });

    const raw = await executePatchToolCall(argsJson, null);
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.verified_state.message).toMatch(/applied/i);
  });

  test("insert_at_line success → verified_state present", async () => {
    const original = ["line 1", "line 2", "line 3"].join("\n");
    tmpFile = makeTmpFile(original);
    const relativePath = path.relative(process.cwd(), tmpFile).replace(/\\/g, "/");

    const argsJson = JSON.stringify({
      file_path: relativePath,
      operation: "insert_at_line",
      insert_line: 2,
      new_body: "// inserted line",
    });

    const raw = await executePatchToolCall(argsJson, null);
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.verified_state).toBeDefined();
    expect(result.verified_state.WARNING).toMatch(/do not retry/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #002b — failure responses do NOT include verified_state
//
// If a patch fails, there is nothing to verify. The LLM should not see
// a verified_state that could be confused with a success confirmation.
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #002b — verified_state absent on failure", () => {
  test("missing file → no verified_state in error response", async () => {
    const argsJson = JSON.stringify({
      file_path: "src/nonexistent_file_xyz.js",
      operation: "replace_string",
      search_string: "anything",
      replacement_string: "something",
    });

    const raw = await executePatchToolCall(argsJson, null);
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.verified_state).toBeUndefined();
  });

  test("invalid JSON args → no verified_state", async () => {
    const raw = await executePatchToolCall("{ not valid json", null);
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.verified_state).toBeUndefined();
  });

  test("missing required fields → no verified_state", async () => {
    const argsJson = JSON.stringify({ operation: "replace_string" }); // missing file_path
    const raw = await executePatchToolCall(argsJson, null);
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.verified_state).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #002c — search_string no longer present after successful patch
//
// This is the core of the double-patch bug: after a replace_string,
// the original search_string must not exist in the file anymore.
// If it does, the second patch attempt would succeed silently,
// creating duplicate content.
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #002c — search_string removed after replace_string", () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  test("search_string not in file after successful patch", async () => {
    const original = "const VALUE = 'old';\nconst OTHER = 'stays';\n";
    tmpFile = makeTmpFile(original);
    const relativePath = path.relative(process.cwd(), tmpFile).replace(/\\/g, "/");

    const argsJson = JSON.stringify({
      file_path: relativePath,
      operation: "replace_string",
      search_string: "'old'",
      replacement_string: "'new'",
    });

    const raw = await executePatchToolCall(argsJson, null);
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);

    // File on disk must no longer contain the original search_string
    const updatedContent = fs.readFileSync(tmpFile, "utf-8");
    expect(updatedContent).not.toContain("'old'");
    expect(updatedContent).toContain("'new'");
    expect(updatedContent).toContain("'stays'");
  });

  test("second patch attempt with same search_string → fails (search_string gone)", async () => {
    const original = "const X = 'target';\n";
    tmpFile = makeTmpFile(original);
    const relativePath = path.relative(process.cwd(), tmpFile).replace(/\\/g, "/");

    const argsJson = JSON.stringify({
      file_path: relativePath,
      operation: "replace_string",
      search_string: "'target'",
      replacement_string: "'replaced'",
    });

    // First patch — should succeed
    const first = JSON.parse(await executePatchToolCall(argsJson, null));
    expect(first.success).toBe(true);

    // Second patch with same args — search_string no longer in file
    const second = JSON.parse(await executePatchToolCall(argsJson, null));
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #002d — isPatchToolCall recognizes all aliases
//
// The ghost interceptor uses isPatchToolCall to decide whether to intercept.
// If an alias isn't recognized, the LLM's patch call passes through to
// the client instead of being executed — the session hangs waiting for
// a tool result that never comes.
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #002d — isPatchToolCall alias coverage", () => {

  test.each([
    "contextforge_patch_ast",
    "mcp__contextforge__contextforge_patch_ast",
    "contextforge__contextforge_patch_ast",
  ])('"%s" → recognized as patch tool', (name) => {
    expect(isPatchToolCall(name)).toBe(true);
  });

  test.each([
    "contextforge_query_graph",
    "read_file_chunk",
    "search_code",
    null,
    "",
  ])('"%s" → NOT a patch tool', (name) => {
    expect(isPatchToolCall(name)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #002e — insert_at_line response shape correct for WorkspaceState
//
// WorkspaceState.recordPatch() reads lines_changed ?? lines_inserted from
// the patch result. If these fields are missing, the session state tracking
// breaks and WorkspaceState summary doesn't show the correct diff.
// ─────────────────────────────────────────────────────────────────────────────

describe("Regression #002e — insert_at_line response fields for WorkspaceState", () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  test("insert_at_line success → lines_inserted and insert_line fields present", async () => {
    const original = ["alpha", "beta", "gamma"].join("\n");
    tmpFile = makeTmpFile(original);
    const relativePath = path.relative(process.cwd(), tmpFile).replace(/\\/g, "/");

    const argsJson = JSON.stringify({
      file_path: relativePath,
      operation: "insert_at_line",
      insert_line: 2,
      new_body: "// new line A\n// new line B",
    });

    const raw = await executePatchToolCall(argsJson, null);
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(typeof result.lines_inserted).toBe("number");
    expect(result.lines_inserted).toBe(2); // two lines in new_body
    expect(result.insert_line).toBe(2);
  });
});