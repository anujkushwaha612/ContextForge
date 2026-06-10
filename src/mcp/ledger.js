// src/mcp/ledger.js
// Tracks which MCP entries ContextForge installed
// Prevents uninstall from removing user-managed entries

import { createHash }   from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path             from "node:path";

const LEDGER_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".contextforge",
  "mcp_installs.json",
);

export function specFingerprint(spec) {
  const payload = JSON.stringify({
    name:    spec.name,
    command: spec.command,
    args:    [...spec.args].sort(),
    env:     Object.fromEntries(Object.entries(spec.env).sort()),
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function recordInstall(agent, spec) {
  const data  = readLedger();
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
    return JSON.parse(readFileSync(LEDGER_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeLedger(data) {
  mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  writeFileSync(LEDGER_FILE, JSON.stringify(data, null, 2) + "\n");
}