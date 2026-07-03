// src/mcp/ledger.js — FIXED VERSION
//
// Fixes (LG-1 … LG-4):
//
//   LG-1  Ledger path unified with the CLI's CF_HOME resolution
//         (~/.contextforge, or CF_HOME override, or %APPDATA%\contextforge
//         on Windows, XDG on Linux). Previously hardcoded HOME||USERPROFILE
//         — on Windows the CLI and ledger could disagree about where
//         ~/.contextforge lives, splitting state across two directories.
//
//   LG-2  os.homedir() fallback instead of "" — with HOME and USERPROFILE
//         both unset the old code wrote to "<cwd>/.contextforge" relative
//         to path.join("", ...) — effectively a relative path.
//
//   LG-3  Atomic write (tmp+rename) — a crash mid-write corrupted the
//         ledger; readLedger() then returned {} and ALL install records
//         were silently forgotten (uninstall protection gone).
//
//   LG-4  specFingerprint no longer sorts args. Argument ORDER is
//         semantically meaningful (["bridge.js","--flag"] vs
//         ["--flag","bridge.js"]) — sorting made different commands
//         fingerprint-equal. Env keys still sorted (order irrelevant).
//         NOTE: this changes fingerprints for multi-arg specs vs the old
//         version. Single-arg specs (ours) are unaffected.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// LG-1/LG-2: same resolution logic as cli/src/core/paths.js cfHome()
function contextforgeHome() {
  if (process.env.CF_HOME) return path.resolve(process.env.CF_HOME);
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "contextforge");
  }
  if (process.platform === "linux" && process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "contextforge");
  }
  return path.join(os.homedir(), ".contextforge");
}

const LEDGER_FILE = path.join(contextforgeHome(), "mcp_installs.json");

export function specFingerprint(spec) {
  const payload = JSON.stringify({
    name:    spec.name,
    command: spec.command,
    args:    [...spec.args],                                        // LG-4: order preserved
    env:     Object.fromEntries(Object.entries(spec.env).sort()),   // env order irrelevant
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function recordInstall(agent, spec) {
  const data   = readLedger();
  const agents = data.agents || (data.agents = {});
  const entry  = agents[agent] || (agents[agent] = {});
  entry[spec.name] = {
    fingerprint:  specFingerprint(spec),
    installed_at: new Date().toISOString(),
  };
  writeLedger(data);
}

export function clearInstall(agent, serverName) {
  const data  = readLedger();
  const entry = data.agents?.[agent];
  if (!entry || !(serverName in entry)) return;
  delete entry[serverName];
  if (Object.keys(entry).length === 0) delete data.agents[agent];
  writeLedger(data);
}

export function contextforgeInstalledMatching(agent, currentSpec) {
  if (!currentSpec) return false;
  const data = readLedger();
  const fp   = data.agents?.[agent]?.[currentSpec.name]?.fingerprint;
  return fp === specFingerprint(currentSpec);
}

function readLedger() {
  if (!existsSync(LEDGER_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LEDGER_FILE, "utf-8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

// LG-3: atomic — never leaves a half-written ledger behind
function writeLedger(data) {
  mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  const tmp = `${LEDGER_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, LEDGER_FILE);
}
