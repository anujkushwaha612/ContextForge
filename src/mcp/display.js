// src/mcp/display.js
import { RegisterStatus } from "./base.js";

export function formatResult(agent, result, {
  label         = null,
  verbose       = false,
  overwriteHint = "node src/cli/mcp.js install --force",
  restartHint   = "restart the agent if it was already running",
} = {}) {
  const l      = label || agent;
  const status = result.status;

  if (status === RegisterStatus.REGISTERED)
    return `  ${l}: ✅ registered (${restartHint})`;
  if (status === RegisterStatus.ALREADY)
    return verbose ? `  ${l}: ✓ already registered` : null;
  if (status === RegisterStatus.NOT_DETECTED)
    return `  ${l}: — not detected on this system`;
  if (status === RegisterStatus.MISMATCH)
    return `  ${l}: ⚠️  existing config differs (${result.detail}). To update: ${overwriteHint}`;
  if (status === RegisterStatus.FAILED)
    return `  ${l}: ❌ failed: ${result.detail}`;

  return `  ${l}: ${status}: ${result.detail}`;
}

export function formatResults(results, { verbose = false } = {}) {
  return Object.entries(results)
    .filter(([k]) => k !== "_health")
    .map(([agent, result]) => formatResult(agent, result, { verbose }))
    .filter(Boolean);
}

export function anySucceeded(results) {
  return Object.entries(results)
    .filter(([k]) => k !== "_health")
    .some(([, r]) => r.ok);
}