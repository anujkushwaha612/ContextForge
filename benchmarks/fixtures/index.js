// benchmarks/fixtures/index.js
//
// Fixture registry for all ContextForge benchmarks.
//
// Every benchmark imports from here — never constructs paths itself.
// This is the single source of truth for where fixtures live.
//
// Exports:
//   REPO_FIXTURES       — { small, medium, large } → absolute paths
//   PAYLOAD_FIXTURES    — { "40-tools", "large-tool-result" } → absolute paths
//   PROMPT_FIXTURES     — { "labeled-100" } → absolute paths
//   SESSION_FIXTURES    — { "rename-function", ... } → absolute paths
//   requireFixture()    — throws with a clear message if a path is missing
//   loadJsonFixture()   — reads + parses JSON, throws if missing or malformed

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Root directories
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES_ROOT   = __dirname;
const REPOS_ROOT      = path.join(FIXTURES_ROOT, "repositories");
const PAYLOADS_ROOT   = path.join(FIXTURES_ROOT, "payloads");
const PROMPTS_ROOT    = path.join(FIXTURES_ROOT, "prompts");
const SESSIONS_ROOT   = path.join(FIXTURES_ROOT, "sessions");

// ─────────────────────────────────────────────────────────────────────────────
// Repository fixtures
//
// Keys match the size strings used in benchmark files ("small", "medium", "large").
// Values are absolute paths to the generated repository directories.
// ─────────────────────────────────────────────────────────────────────────────

export const REPO_FIXTURES = {
  small:  path.join(REPOS_ROOT, "small-repo"),
  medium: path.join(REPOS_ROOT, "medium-repo"),
  large:  path.join(REPOS_ROOT, "large-repo"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Payload fixtures
//
// Keys match the fixture file names without extension.
// ─────────────────────────────────────────────────────────────────────────────

export const PAYLOAD_FIXTURES = {
  "40-tools":          path.join(PAYLOADS_ROOT, "40-tools.json"),
  "large-tool-result": path.join(PAYLOADS_ROOT, "large-tool-result.json"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompt fixtures
// ─────────────────────────────────────────────────────────────────────────────

export const PROMPT_FIXTURES = {
  "labeled-100": path.join(PROMPTS_ROOT, "labeled-100.json"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Session fixtures
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_FIXTURES = {
  "rename-function": path.join(SESSIONS_ROOT, "rename-function.json"),
  "remove-import":   path.join(SESSIONS_ROOT, "remove-import.json"),
  "add-logging":     path.join(SESSIONS_ROOT, "add-logging.json"),
  "find-route":      path.join(SESSIONS_ROOT, "find-route.json"),
  "explain-code":    path.join(SESSIONS_ROOT, "explain-code.json"),
};

// ─────────────────────────────────────────────────────────────────────────────
// requireFixture
//
// Throws a clear, actionable error when a fixture path does not exist.
// Every benchmark calls this before touching a fixture so the error
// message tells the developer exactly what to run to fix it.
// ─────────────────────────────────────────────────────────────────────────────

export function requireFixture(absPath, label) {
  if (!fs.existsSync(absPath)) {
    throw new Error(
      [
        ``,
        `Missing fixture: ${label}`,
        `Expected at:    ${absPath}`,
        ``,
        `Fix: node benchmarks/fixtures/generate.js`,
        ``,
      ].join("\n")
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// loadJsonFixture
//
// Reads and JSON-parses a fixture file.
// Throws with context if the file is missing or contains invalid JSON.
// ─────────────────────────────────────────────────────────────────────────────

export function loadJsonFixture(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(
      [
        ``,
        `Fixture file not found: ${absPath}`,
        ``,
        `Fix: node benchmarks/fixtures/generate.js`,
        ``,
      ].join("\n")
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf-8");
  } catch (err) {
    throw new Error(`Could not read fixture file: ${absPath}\n${err.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      [
        `Fixture file contains invalid JSON: ${absPath}`,
        `Parse error: ${err.message}`,
        ``,
        `Fix: delete the file and re-run node benchmarks/fixtures/generate.js`,
        ``,
      ].join("\n")
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture health check
//
// Called by runAll.js before any benchmark runs.
// Prints a table of which fixtures exist and which are missing.
// Does not throw — callers decide whether missing fixtures are fatal.
// ─────────────────────────────────────────────────────────────────────────────

export function checkFixtureHealth() {
  const checks = [
    // Repositories
    ...Object.entries(REPO_FIXTURES).map(([key, p]) => ({
      category: "repo",
      label: `${key}-repo`,
      path: p,
    })),
    // Payloads
    ...Object.entries(PAYLOAD_FIXTURES).map(([key, p]) => ({
      category: "payload",
      label: key,
      path: p,
    })),
    // Prompts
    ...Object.entries(PROMPT_FIXTURES).map(([key, p]) => ({
      category: "prompt",
      label: key,
      path: p,
    })),
    // Sessions
    ...Object.entries(SESSION_FIXTURES).map(([key, p]) => ({
      category: "session",
      label: key,
      path: p,
    })),
  ];

  const results = checks.map((c) => ({
    ...c,
    exists: fs.existsSync(c.path),
  }));

  const missing = results.filter((r) => !r.exists);
  const present = results.filter((r) => r.exists);

  console.log("\nFixture Health Check");
  console.log("─".repeat(60));

  for (const r of results) {
    const icon = r.exists ? "✅" : "❌";
    const label = `[${r.category}] ${r.label}`.padEnd(36);
    console.log(`  ${icon}  ${label} ${r.exists ? "found" : "MISSING"}`);
  }

  if (missing.length > 0) {
    console.log(
      `\n  ${missing.length} fixture(s) missing. Run:\n` +
        `    node benchmarks/fixtures/generate.js\n`
    );
  } else {
    console.log(`\n  All ${present.length} fixtures present.\n`);
  }

  return { present, missing, healthy: missing.length === 0 };
}