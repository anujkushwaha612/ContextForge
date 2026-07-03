/**
 * core/paths.js
 *
 * Single source of truth for every path ContextForge touches.
 * Nothing else in the codebase may hardcode a location.
 *
 * Layout:
 *   ~/.contextforge/
 *   ├── config.toml
 *   ├── models/            (onnx + tokenizer + .manifest.json)
 *   ├── data/<ws-hash>/    (per-workspace memory.db, graph, vault)
 *   ├── logs/
 *   └── run/               (proxy runfiles)
 *
 * CF_HOME overrides the root (tests, CI, portable installs).
 */

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdirSync, realpathSync, existsSync } from "node:fs";

export function cfHome() {
  if (process.env.CF_HOME) return path.resolve(process.env.CF_HOME);

  // Windows: %APPDATA%\contextforge ; Linux: $XDG_DATA_HOME if set ; else ~/.contextforge
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "contextforge");
  }
  if (process.platform === "linux" && process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "contextforge");
  }
  return path.join(os.homedir(), ".contextforge");
}

export const modelsDir  = () => path.join(cfHome(), "models");
export const logsDir    = () => path.join(cfHome(), "logs");
export const runDir     = () => path.join(cfHome(), "run");
export const globalConfigPath = () => path.join(cfHome(), "config.toml");

/** Stable short hash of an absolute workspace path (case-normalized on win32). */
export function workspaceHash(workspacePath) {
  let p = path.resolve(workspacePath);
  try { p = realpathSync(p); } catch { /* not yet existing — hash as-is */ }
  if (process.platform === "win32") p = p.toLowerCase();
  return crypto.createHash("sha256").update(p).digest("hex").slice(0, 12);
}

/** Per-workspace state dir: ~/.contextforge/data/<hash>/ */
export function workspaceDataDir(workspacePath) {
  return path.join(cfHome(), "data", workspaceHash(workspacePath));
}

/** Runfile for a proxy on a given port. */
export function runfilePath(port) {
  return path.join(runDir(), `proxy-${port}.json`);
}

/** Walk up from `startDir` to find the git root; fall back to startDir. */
export function resolveWorkspace(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

/** Project-level config file for a workspace, if any. */
export function projectConfigPath(workspacePath) {
  return path.join(workspacePath, ".contextforge.toml");
}

/** Create the full ~/.contextforge skeleton. Idempotent. */
export function ensureLayout() {
  for (const d of [cfHome(), modelsDir(), logsDir(), runDir(), path.join(cfHome(), "data")]) {
    mkdirSync(d, { recursive: true });
  }
  return cfHome();
}
