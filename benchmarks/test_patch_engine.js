/**
 * test_patch_engine.js
 *
 * Direct unit test for patchEngine.executePatch.
 * No server, no LLM, no HTTP — pure function test.
 *
 * Tests:
 *   1. replace_body on a known function
 *   2. insert_after
 *   3. delete
 *   4. Error: symbol not found
 *   5. Error: wrong file path
 *   6. Indentation preservation
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexWorkspace } from "../src/graph/workspaceMapper.js";
import { executePatch, PATCH_OPERATIONS } from "../src/graph/patchEngine.js";
import { queryFindSymbol } from "../src/graph/graphDb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "patch_fixtures");

// ─────────────────────────────────────────────
// Test fixture — a real JS file we will patch
// ─────────────────────────────────────────────

const FIXTURE_SOURCE = `
// patch_fixtures/calculator.js
// Test fixture for patchEngine unit tests

export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}

export class Calculator {
  constructor() {
    this.history = [];
  }

  compute(op, a, b) {
    const result = op(a, b);
    this.history.push(result);
    return result;
  }
}
`.trimStart();

// ─────────────────────────────────────────────
// Test runner
// ─────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log("=".repeat(60));
  console.log("  PATCH ENGINE UNIT TESTS");
  console.log("=".repeat(60));

  // ── Setup: create fixture directory and file ──
  if (!fs.existsSync(FIXTURE_DIR)) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  }

  const fixturePath = path.join(FIXTURE_DIR, "calculator.js");

  // Write fresh fixture
  fs.writeFileSync(fixturePath, FIXTURE_SOURCE, "utf-8");
  console.log(`\n[Setup] Fixture written: ${fixturePath}`);

  // Index the fixture directory so graphDb knows about it
  console.log("[Setup] Indexing fixture...");
  await indexWorkspace(FIXTURE_DIR, { force: true });

  // Verify indexing worked
  const symbols = queryFindSymbol("add");
  console.log(`[Setup] Found ${symbols.length} definition(s) of 'add'`);

  if (symbols.length === 0) {
    console.error("\n❌ FATAL: Indexing failed — no symbols found. Cannot proceed.");
    process.exit(1);
  }

  // ─────────────────────────────────────────────
  // Test 1: replace_body
  // ─────────────────────────────────────────────
  console.log("\n── Test 1: replace_body ──────────────────────────");

  // Reset fixture
  fs.writeFileSync(fixturePath, FIXTURE_SOURCE, "utf-8");
  await indexWorkspace(FIXTURE_DIR, { force: true });

  const result1 = await executePatch({
    file_path:     fixturePath,
    target_symbol: "add",
    new_body:      "export function add(a, b) {\n  // patched\n  return a + b + 0;\n}",
    operation:     PATCH_OPERATIONS.REPLACE_BODY,
  });

  assert(result1.success === true, `replace_body succeeded`);
  assert(result1.symbol === "add", `result.symbol is 'add'`);
  assert(result1.diff_summary !== undefined, `diff_summary present`);

  const after1 = fs.readFileSync(fixturePath, "utf-8");
  assert(after1.includes("return a + b + 0"), `patched content written to disk`);
  assert(after1.includes("subtract"), `other functions untouched`);
  assert(after1.includes("multiply"), `multiply still present`);

  console.log(`  diff: ${result1.diff_summary}`);

  // Verify graph re-indexed
  const reindexed1 = queryFindSymbol("add");
  assert(reindexed1.length > 0, `graph re-indexed after patch`);

  // ─────────────────────────────────────────────
  // Test 2: insert_after
  // ─────────────────────────────────────────────
  console.log("\n── Test 2: insert_after ──────────────────────────");

  fs.writeFileSync(fixturePath, FIXTURE_SOURCE, "utf-8");
  await indexWorkspace(FIXTURE_DIR, { force: true });

  const result2 = await executePatch({
    file_path:     fixturePath,
    target_symbol: "add",
    new_body:      "export function addSafe(a, b) {\n  if (typeof a !== 'number') throw new Error('not a number');\n  return a + b;\n}",
    operation:     PATCH_OPERATIONS.INSERT_AFTER,
  });

  assert(result2.success === true, `insert_after succeeded`);

  const after2 = fs.readFileSync(fixturePath, "utf-8");
  assert(after2.includes("addSafe"), `inserted function present`);
  assert(after2.includes("add(a, b)"), `original add still present`);

  // addSafe must appear after add in the file
  const addPos    = after2.indexOf("function add(");
  const safePos   = after2.indexOf("function addSafe(");
  assert(safePos > addPos, `addSafe appears after add`);

  // ─────────────────────────────────────────────
  // Test 3: delete
  // ─────────────────────────────────────────────
  console.log("\n── Test 3: delete ────────────────────────────────");

  fs.writeFileSync(fixturePath, FIXTURE_SOURCE, "utf-8");
  await indexWorkspace(FIXTURE_DIR, { force: true });

  const result3 = await executePatch({
    file_path:     fixturePath,
    target_symbol: "multiply",
    new_body:      "",
    operation:     PATCH_OPERATIONS.DELETE,
  });

  assert(result3.success === true, `delete succeeded`);

  const after3 = fs.readFileSync(fixturePath, "utf-8");
  assert(!after3.includes("function multiply"), `multiply removed from file`);
  assert(after3.includes("function add"), `add still present after delete`);
  assert(after3.includes("function subtract"), `subtract still present after delete`);

  // ─────────────────────────────────────────────
  // Test 4: Error — symbol not found
  // ─────────────────────────────────────────────
  console.log("\n── Test 4: Error — symbol not found ─────────────");

  const result4 = await executePatch({
    file_path:     fixturePath,
    target_symbol: "nonExistentFunction",
    new_body:      "export function nonExistentFunction() {}",
    operation:     PATCH_OPERATIONS.REPLACE_BODY,
  });

  assert(result4.success === false, `returns failure for unknown symbol`);
  assert(typeof result4.error === "string", `error message is a string`);
  assert(result4.error.includes("not found"), `error mentions 'not found'`);
  console.log(`  error: ${result4.error}`);

  // File must be untouched
  const after4 = fs.readFileSync(fixturePath, "utf-8");
  assert(!after4.includes("nonExistentFunction"), `file not modified on error`);

  // ─────────────────────────────────────────────
  // Test 5: Error — wrong file path
  // ─────────────────────────────────────────────
  console.log("\n── Test 5: Error — wrong file path ──────────────");

  fs.writeFileSync(fixturePath, FIXTURE_SOURCE, "utf-8");
  await indexWorkspace(FIXTURE_DIR, { force: true });

  const result5 = await executePatch({
    file_path:     "src/completely/wrong/path.js",
    target_symbol: "add",
    new_body:      "export function add() {}",
    operation:     PATCH_OPERATIONS.REPLACE_BODY,
  });

  assert(result5.success === false, `returns failure for wrong file path`);
  assert(result5.error.includes("not in"), `error mentions path mismatch`);
  console.log(`  error: ${result5.error}`);

  // ─────────────────────────────────────────────
  // Test 6: Indentation preservation
  // ─────────────────────────────────────────────
  console.log("\n── Test 6: Indentation preservation ─────────────");

  fs.writeFileSync(fixturePath, FIXTURE_SOURCE, "utf-8");
  await indexWorkspace(FIXTURE_DIR, { force: true });

  // compute() is a method inside Calculator class — it is indented 2 spaces
  const result6 = await executePatch({
    file_path:     fixturePath,
    target_symbol: "compute",
    // Intentionally flat (no indent) — engine should re-indent to match file
    new_body:      "compute(op, a, b) {\nconst result = op(a, b);\nthis.history.push({ op: op.name, result });\nreturn result;\n}",
    operation:     PATCH_OPERATIONS.REPLACE_BODY,
  });

  assert(result6.success === true, `indented method patch succeeded`);

  const after6 = fs.readFileSync(fixturePath, "utf-8");
  const computeLines = after6
    .split("\n")
    .filter(l => l.includes("this.history.push"));

  assert(computeLines.length > 0, `patched line present in file`);

  if (computeLines.length > 0) {
    const leadingSpaces = computeLines[0].match(/^(\s+)/)?.[1]?.length ?? 0;
    assert(leadingSpaces > 0, `patched line has indentation (${leadingSpaces} spaces)`);
    console.log(`  indentation: ${leadingSpaces} spaces on patched line`);
  }

  // ─────────────────────────────────────────────
  // Test 7: Stale index detection
  // ─────────────────────────────────────────────
  console.log("\n── Test 7: Stale index detection ────────────────");

  fs.writeFileSync(fixturePath, FIXTURE_SOURCE, "utf-8");
  await indexWorkspace(FIXTURE_DIR, { force: true });

  // Manually edit the file without re-indexing — simulates external editor
  const manuallyEdited = FIXTURE_SOURCE.replace(
    "return a + b;",
    "return a + b; // manually edited",
  );
  fs.writeFileSync(fixturePath, manuallyEdited, "utf-8");
  // Do NOT re-index — graph is now stale

  // Patch should detect staleness, re-index, then apply cleanly
  const result7 = await executePatch({
    file_path:     fixturePath,
    target_symbol: "subtract",
    new_body:      "export function subtract(a, b) {\n  return a - b; // patched after stale detect\n}",
    operation:     PATCH_OPERATIONS.REPLACE_BODY,
  });

  // Should succeed even with stale index — engine re-indexes first
  assert(result7.success === true, `patch succeeds despite stale index`);

  const after7 = fs.readFileSync(fixturePath, "utf-8");
  assert(after7.includes("patched after stale detect"), `patch content written`);
  assert(after7.includes("manually edited"), `manual edit preserved`);

  // ─────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────
  console.log("\n── Cleanup ───────────────────────────────────────");
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  console.log("  Fixture directory removed");

  // ─────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("\n[Fatal]", err);
  process.exit(1);
});