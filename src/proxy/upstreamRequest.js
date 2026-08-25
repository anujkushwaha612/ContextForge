/**
 * upstreamRequest.js
 *
 * Fixes applied (this pass):
 *
 *   UR-1: invalidateCacheForPatch symbol branch — `continue` was unconditional
 *         inside `if (symbol)`, skipping the basename fallback for all non-
 *         find_symbol entries (chunk cache, what_does_this_export, etc.).
 *         Moved `continue` inside the inner `if` so only matched entries skip
 *         the basename check; everything else falls through to it.
 *
 *   UR-2: chunkCacheSet changed from insertion-order to LRU eviction using
 *         a parallel access-time map. Prevents evicting the most-consulted
 *         file chunks (typically the main file being edited).
 *
 *   UR-3: executeReadFileChunk error responses no longer cached. Error JSON
 *         is parsed and checked before caching — only successful reads are
 *         stored. toolSucceeded set to false on error reads.
 *
 *   UR-7: Concept cache check updated from `parsed.found === true` to
 *         `(parsed.count ?? parsed.results?.length ?? 0) > 0`. The `find`
 *         query response format never included a `found` field — the concept
 *         cache was a permanent no-op for all `find` queries.
 *
 *   UR-8: computeNextRetry now accepts and applies maxRetries as a third
 *         parameter. The streaming path was already passing maxRetries but
 *         the function silently ignored it. The per-request retry budget
 *         override (x-cf-max-retries header) now actually applies.
 *
 *   UR-9: proxyReq.destroy() called before reject() in proxyRes end handler
 *         to prevent socket leak when the async handler throws.
 *
 *   UR-10: RAG indexing only runs on final responses (no tool calls seen),
 *          not on intermediate ghost interceptor hops. Prevents intermediate
 *          navigation steps from being indexed as retrievable content.
 *
 *   UR-11: Workspace summary uses relative time ("3m ago") instead of ISO
 *          timestamps. ISO timestamps in user messages prevent prefix cache
 *          hits in the translation layer since every hop produces a unique
 *          message content.
 */

import http from "node:http";
import https from "node:https";
import path from "node:path";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { statsEmitter } from "./statsEmitter.js";

import { countTokens } from "../compression/compressionHelper.js";
import { interceptAndVaultMassiveToolResults } from "../compression/fatCatch.js";
import { retrieveFromVault } from "../vaultRetriever.js";
import { recordCCRSuccess, SessionRegistry } from "../ccr/index.js";
import {
  isGraphToolCall,
  executeGraphQuery,
  normalizeGraphToolName,
  isReadFileChunkTool,
  executeReadFileChunk,
} from "../graph/graphTools.js";
import { getWorkspaceRoot } from "../graph/graphDb.js";
import { isPatchToolCall, executePatchToolCall, PATCH_TOOL_NAME } from "../graph/patchTools.js";
import { hasMemoryToolCalls, executeMemoryToolCalls } from "../memory/memoryTools.js";
import { normalizeConceptKey } from "../graph/semanticResolver.js";
import { DEFAULT_MEMORY_USER_ID } from "./memoryDecision.js";
import { applyStableToolSet, isMcpToolSession } from "./stableTools.js";
import {
  StreamToolCallAssembler,
  activeToolSchemas,
  hasFatalAssemblyIssues,
  repairMergedToolCalls,
  validateActiveToolCall,
} from "./toolCallSafety.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizePathForCache(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath ?? "";

  const p = filePath.replace(/\\/g, "/");

  if (path.isAbsolute(filePath) || /^[A-Za-z]:\//.test(p)) {
    return p.toLowerCase();
  }

  try {
    const workspaceRoot = getWorkspaceRoot();
    return path.resolve(workspaceRoot, filePath).replace(/\\/g, "/").toLowerCase();
  } catch {
    return p.toLowerCase();
  }
}

const MAX_GHOST_RETRIES = 10;
// A broad multi-file task legitimately needs several distinct reads. Stop
// repeated navigation quickly, while still giving a bounded budget to novel
// read-only exploration.
const MAX_REPEATED_READ_ONLY_ROUNDS = 3;
const MAX_NOVEL_READ_ONLY_ROUNDS = 8;
const MAX_HOP_COUNT = 15;

// ─────────────────────────────────────────────────────────────────────────────
// Chunk cache — LRU eviction
//
// UR-2 FIX: Changed from insertion-order (Map.keys().next()) to LRU
// (least recently accessed by wall-clock time). The oldest-inserted entry
// is typically the most-consulted file in the session (the main file being
// edited). Evicting it forces a disk re-read on the next access.
//
// Implementation: parallel Map for access timestamps avoids per-entry
// object allocation overhead.
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_CACHE_DATA = new Map(); // key → content string
const CHUNK_CACHE_TIME = new Map(); // key → last access timestamp (ms)
const CHUNK_CACHE_MAX = 100;

function chunkCacheKey(filePath, startLine, endLine) {
  return `${normalizePathForCache(filePath)}:${startLine}:${endLine}`;
}

function chunkCacheGet(filePath, startLine, endLine) {
  const key = chunkCacheKey(filePath, startLine, endLine);
  const content = CHUNK_CACHE_DATA.get(key) ?? null;
  if (content !== null) {
    // Update access time for LRU
    CHUNK_CACHE_TIME.set(key, Date.now());
  }
  return content;
}

function chunkCacheSet(filePath, startLine, endLine, content) {
  const key = chunkCacheKey(filePath, startLine, endLine);

  if (CHUNK_CACHE_DATA.size >= CHUNK_CACHE_MAX && !CHUNK_CACHE_DATA.has(key)) {
    // UR-2 FIX: Evict LRU entry — find entry with oldest access time
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, t] of CHUNK_CACHE_TIME) {
      if (t < oldestTime) {
        oldestTime = t;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      CHUNK_CACHE_DATA.delete(oldestKey);
      CHUNK_CACHE_TIME.delete(oldestKey);
    }
  }

  CHUNK_CACHE_DATA.set(key, content);
  CHUNK_CACHE_TIME.set(key, Date.now());
}

function chunkCacheInvalidateFile(filePath) {
  const normalized = normalizePathForCache(filePath);
  for (const key of CHUNK_CACHE_DATA.keys()) {
    if (key.startsWith(`${normalized}:`)) {
      CHUNK_CACHE_DATA.delete(key);
      CHUNK_CACHE_TIME.delete(key);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceState
//
// UR-4 NOTE: Module-level singleton — shared across all concurrent requests.
// Intentional for single-user deployments where the ghost interceptor
// multi-hop chain spans a single request. Known limitation: in multi-user
// deployments, patch history from one session pollutes another.
// ─────────────────────────────────────────────────────────────────────────────

const workspaceState = {
  modifiedFiles: new Map(),
  verifiedSymbols: new Set(),
  recentPatches: [],
};

function recordPatch(filePath, symbol, linesChanged) {
  workspaceState.modifiedFiles.set(filePath, {
    linesChanged,
    lastPatchedAt: new Date().toISOString(), // stored as ISO for precision
    symbol: symbol || "GLOBAL",
  });
  workspaceState.recentPatches.unshift({
    file: filePath,
    symbol: symbol || "GLOBAL",
    linesChanged,
    at: new Date().toISOString(),
  });
  if (workspaceState.recentPatches.length > 5) {
    workspaceState.recentPatches.pop();
  }
}

// UR-11 FIX: Relative time display prevents unique timestamps in user
// messages that break the translation prefix cache.
function relativeTime(isoStr) {
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

function buildWorkspaceSummary() {
  if (workspaceState.modifiedFiles.size === 0) return null;

  const lines = ["[ContextForge WorkspaceState]"];
  lines.push(`Modified files this session: ${workspaceState.modifiedFiles.size}`);
  for (const [file, info] of workspaceState.modifiedFiles.entries()) {
    lines.push(`  • ${file} — symbol: ${info.symbol}, ${info.linesChanged} line(s) changed`);
  }
  if (workspaceState.recentPatches.length > 0) {
    lines.push("Recent patches (newest first):");
    for (const p of workspaceState.recentPatches) {
      // UR-11 FIX: relative time instead of ISO string
      lines.push(`  • [${relativeTime(p.at)}] ${p.file}::${p.symbol} — ${p.linesChanged} lines`);
    }
  }
  lines.push(
    "NOTE: These files have already been patched. " +
      "Do not re-patch unless you have verified the current state with read_file_chunk."
  );
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Session-scoped tool result cache
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_TOOL_CACHE = new Map();
const SESSION_CACHE_MAX = 200;

function _sessionCacheKey(name, argsStr) {
  try {
    const parsed = JSON.parse(argsStr || "{}");

    if (name === "contextforge_retrieve" || name?.includes("contextforge_retrieve")) {
      const canonical = { vault_id: parsed.vault_id ?? "" };
      const sq = (parsed.search_query ?? "").trim();
      if (sq) canonical.search_query = sq;
      return `${name}:${JSON.stringify(canonical)}`;
    }

    if (isReadFileChunkTool(name) && parsed.file_path) {
      const canonical = {
        file_path: normalizePathForCache(parsed.file_path),
        start_line: parsed.start_line,
        end_line: parsed.end_line,
      };
      return `${name}:${JSON.stringify(canonical)}`;
    }

    const sorted = JSON.stringify(Object.fromEntries(Object.entries(parsed).sort()));
    return `${name}:${sorted}`;
  } catch {
    return `${name}:${argsStr}`;
  }
}

function sessionCacheGet(name, argsStr) {
  return SESSION_TOOL_CACHE.get(_sessionCacheKey(name, argsStr)) ?? null;
}

function sessionCacheSet(name, argsStr, result) {
  const key = _sessionCacheKey(name, argsStr);
  if (SESSION_TOOL_CACHE.size >= SESSION_CACHE_MAX) {
    SESSION_TOOL_CACHE.delete(SESSION_TOOL_CACHE.keys().next().value);
  }
  SESSION_TOOL_CACHE.set(key, result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache invalidation
// ─────────────────────────────────────────────────────────────────────────────

export function invalidateCacheForPatch(filePath, symbol) {
  const normalizedPath = normalizePathForCache(filePath);
  const fileBasename = normalizedPath.split("/").pop().replace(".js", "").toLowerCase();

  let cleared = 0;

  for (const key of SESSION_TOOL_CACHE.keys()) {
    const keyLower = key.toLowerCase();

    if (keyLower.includes('"find_route"') && keyLower.includes(fileBasename)) {
      SESSION_TOOL_CACHE.delete(key);
      cleared++;
      continue;
    }

    if (symbol) {
      const symbolLower = symbol.toLowerCase();
      if (keyLower.includes('"find_symbol"') && keyLower.includes(`"${symbolLower}"`)) {
        SESSION_TOOL_CACHE.delete(key);
        cleared++;
        continue; // UR-1 FIX: continue INSIDE the match block, not after it
        // Previously: continue was after the if block — it fired
        // even when find_symbol didn't match, preventing the
        // basename fallback from running for any non-find_symbol
        // entry when symbol was provided.
      }
      // Fall through to basename check for all other entry types
      // (read_file_chunk, what_does_this_export, show_callers, etc.)
    }

    if (keyLower.includes(fileBasename)) {
      SESSION_TOOL_CACHE.delete(key);
      cleared++;
    }
  }

  chunkCacheInvalidateFile(filePath);
}

export function invalidateCacheForFile(filePath) {
  const normalizedPath = normalizePathForCache(filePath);
  const fileBasename = normalizedPath.split("/").pop().replace(".js", "").toLowerCase();

  for (const key of SESSION_TOOL_CACHE.keys()) {
    if (key.toLowerCase().includes(fileBasename)) {
      SESSION_TOOL_CACHE.delete(key);
    }
  }

  chunkCacheInvalidateFile(filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolInterceptor
// ─────────────────────────────────────────────────────────────────────────────

export class ToolInterceptor {
  constructor(ctx) {
    this.semanticCache = ctx.semanticCache;
    this.hybridRetriever = ctx.hybridRetriever;
    this.memoryHandler = ctx.memoryHandler;
    this.req = ctx.req;

    this._readOnlyRounds = 0;
    this._repeatedReadOnlyRounds = 0;
    this._seenReadOnlyCalls = new Set();
    this._retrievedVaultIds = new Set();
    this._resolvedConcepts = new Map();
    this._consecutivePatchFailures = 0;
    this._callFrequency = new Map();
    this._MAX_IDENTICAL_CALLS = 3;
    this._maxFailureRetries =
      Number.isInteger(ctx.maxRetries) && ctx.maxRetries >= 0 ? ctx.maxRetries : MAX_GHOST_RETRIES;
  }

  _checkAndRecordCall(name, argsStr) {
    const key = _sessionCacheKey(name, argsStr);
    const count = (this._callFrequency.get(key) ?? 0) + 1;
    this._callFrequency.set(key, count);

    if (count >= this._MAX_IDENTICAL_CALLS) {
      const hintMessage = JSON.stringify({
        error: "STALL_DETECTED",
        tool: name,
        call_count: count,
        hint:
          `You have called ${name} with these exact arguments ${count} times. ` +
          `The result will not change. ` +
          `Stop calling this tool and proceed with what you already know, ` +
          `or try a different approach (different query, different file, or different tool).`,
      });
      return { isStall: true, count, hintMessage };
    }

    return { isStall: false, count, hintMessage: null };
  }

  _terminal(reason, message, toolCalls = []) {
    return {
      intercepted: true,
      terminal: true,
      terminalReason: reason,
      terminalMessage: message,
      toolCalls,
      madeForwardProgress: false,
      hadFailure: false,
    };
  }

  _isReadOnlyTool(name) {
    return (
      (isGraphToolCall(name) && !String(name).includes("contextforge_retrieve")) ||
      isReadFileChunkTool(name)
    );
  }

  _checkReadOnlyBudget(backgroundCalls) {
    const allAreReadOnly = backgroundCalls.every((tc) => this._isReadOnlyTool(tc.function?.name));
    if (!allAreReadOnly) {
      this._readOnlyRounds = 0;
      this._repeatedReadOnlyRounds = 0;
      // A patch/retrieve/memory action changes the task state. A targeted
      // verification read after that action is new navigation, not a repeat
      // of the pre-action exploration phase.
      this._seenReadOnlyCalls.clear();
      return null;
    }

    this._readOnlyRounds++;
    const keys = backgroundCalls.map((tc) =>
      _sessionCacheKey(tc.function?.name, tc.function?.arguments)
    );
    const hasNovelCall = keys.some((key) => !this._seenReadOnlyCalls.has(key));
    for (const key of keys) this._seenReadOnlyCalls.add(key);

    if (hasNovelCall) this._repeatedReadOnlyRounds = 0;
    else this._repeatedReadOnlyRounds++;

    if (
      this._repeatedReadOnlyRounds > MAX_REPEATED_READ_ONLY_ROUNDS ||
      this._readOnlyRounds > MAX_NOVEL_READ_ONLY_ROUNDS
    ) {
      const repeated = this._repeatedReadOnlyRounds > MAX_REPEATED_READ_ONLY_ROUNDS;
      const limit = repeated ? MAX_REPEATED_READ_ONLY_ROUNDS : MAX_NOVEL_READ_ONLY_ROUNDS;
      const observed = repeated ? this._repeatedReadOnlyRounds : this._readOnlyRounds;
      const kind = repeated ? "repeated" : "read-only";
      console.warn(
        `[Ghost Interceptor] ⛔ Exploration budget exhausted ` +
          `(${observed} ${kind} rounds > ${limit} max) — terminating ghost loop`
      );
      return this._terminal(
        "exploration_budget",
        `ContextForge stopped an internal exploration loop after ${this._readOnlyRounds} read-only ` +
          `round(s), including ${this._repeatedReadOnlyRounds} repeated round(s). ` +
          `No additional upstream request was sent. Retry with a narrower task or use an explicit action.`,
        backgroundCalls
      );
    }

    return null;
  }

  isBackgroundTool(name) {
    if (!name) return false;
    if (name.startsWith("mcp__")) return false;

    const normalized = normalizeGraphToolName(name);
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

  async process(toolCalls, currentPayload, retryCount, hopCount = 0) {
    if (this._maxFailureRetries > 0 && retryCount >= this._maxFailureRetries) {
      console.warn(
        `[Ghost Interceptor] ⛔ Failure circuit breaker tripped ` +
          `(${retryCount} failures >= ${this._maxFailureRetries} max)`
      );
      return this._terminal(
        "failure_budget",
        `ContextForge stopped after ${retryCount} failed background recovery attempt(s). ` +
          `No additional upstream request was sent.`,
        toolCalls
      );
    }

    if (hopCount >= MAX_HOP_COUNT) {
      console.warn(
        `[Ghost Interceptor] ⛔ Hop circuit breaker tripped ` +
          `(${hopCount} hops >= ${MAX_HOP_COUNT} max)`
      );
      return this._terminal(
        "hop_budget",
        `ContextForge stopped after ${hopCount} total internal hops. ` +
          `No additional upstream request was sent.`,
        toolCalls
      );
    }

    const backgroundCalls = toolCalls.filter((tc) => this.isBackgroundTool(tc.function?.name));
    if (backgroundCalls.length === 0) return { intercepted: false };

    const readOnlyStop = this._checkReadOnlyBudget(backgroundCalls);
    if (readOnlyStop) return readOnlyStop;

    console.log(
      `\n[Ghost Interceptor] 🔍 Intercepted ${backgroundCalls.length} background tool(s) ` +
        `(retry ${retryCount}/${this._maxFailureRetries})`
    );

    const results = [];
    let madeForwardProgress = false;
    let hadFailure = false;

    for (const tc of backgroundCalls) {
      const name = tc.function.name;
      const argsStr = tc.function.arguments || "{}";

      // ── Stall detection ────────────────────────────────────────────────────
      // Count BEFORE consulting the cache. Previously cached reads skipped this
      // check forever, so the proxy replayed the same result and paid another
      // LLM hop on every repeat.
      const stallCheck = this._checkAndRecordCall(name, argsStr);
      if (stallCheck.isStall) {
        console.warn(
          `[Ghost Interceptor] ⛔ Stall detected: ${name} called ${stallCheck.count}x ` +
            `with identical args — terminating ghost loop`
        );
        return this._terminal(
          "identical_call_stall",
          `ContextForge stopped because ${name} was requested ${stallCheck.count} times with ` +
            `identical arguments. The result cannot change, so no additional upstream request was sent.`,
          backgroundCalls
        );
      }

      // ── Session cache ──────────────────────────────────────────────────────
      const cachedResult = sessionCacheGet(name, argsStr);
      if (cachedResult !== null) {
        results.push({ tool_call_id: tc.id, name, content: cachedResult });
        continue;
      }

      let args = {};
      try {
        args = JSON.parse(argsStr);
      } catch (err) {
        // This is defense in depth. All public call sites preflight arguments
        // before invoking process(), but a malformed call must still never be
        // appended to assistant history if a new path bypasses that boundary.
        console.error(
          `[Ghost Interceptor] ⛔ Args JSON malformed for ${name}: "${argsStr.slice(0, 120)}"`
        );
        return this._terminal(
          "malformed_arguments",
          `ContextForge rejected malformed arguments for ${name} before replaying the tool call upstream. ` +
            `No additional upstream request was sent.`,
          backgroundCalls
        );
      }

      let content = "";
      const normalized = normalizeGraphToolName(name);
      let toolSucceeded = false;
      let isActionTool = false;

      // ── Graph tool ────────────────────────────────────────────────────────
      if (isGraphToolCall(name)) {
        if (args.query_type && args.target !== undefined) {
          if (args.query_type === "find") {
            const conceptKey = normalizeConceptKey(args.target);
            const resolvedResult = this._resolvedConcepts.get(conceptKey);
            if (resolvedResult !== undefined) {
              content = resolvedResult;
              toolSucceeded = true;
              isActionTool = false;
            }
          }

          if (!content) {
            content = await executeGraphQuery(args.query_type, args.target, args);
            console.log(
              `[Ghost Interceptor] ✅ Graph: ${args.query_type}("${args.target}") → ${content.length} chars`
            );
            statsEmitter.recordAgentAction("graphLookups");
            toolSucceeded = true;
            isActionTool = false;

            // UR-7 FIX: Cache concept on `count > 0`, not `found === true`.
            // The `find` query response never included a `found` field —
            // checking `parsed.found === true` was always false, making the
            // concept cache a permanent no-op for all `find` queries.
            if (args.query_type === "find") {
              try {
                const parsed = JSON.parse(content);
                const resultCount = parsed.count ?? parsed.results?.length ?? 0;
                if (resultCount > 0) {
                  const conceptKey = normalizeConceptKey(args.target);
                  this._resolvedConcepts.set(conceptKey, content);
                  if (process.env.CF_DEBUG_GRAPH === "1") {
                    console.log(
                      `[Ghost Interceptor] 📌 Concept resolved: "${args.target}" → key "${conceptKey}"`
                    );
                  }
                }
              } catch {
                // JSON parse failed — don't cache, safe to retry
              }
            }
          }
        } else {
          content = JSON.stringify({ error: "Missing query_type or target" });
          toolSucceeded = false;
          isActionTool = false;
        }

        // ── read_file_chunk ───────────────────────────────────────────────────
      } else if (isReadFileChunkTool(name)) {
        const cachedChunk = chunkCacheGet(args.file_path, args.start_line, args.end_line);
        if (cachedChunk !== null) {
          content = cachedChunk;
          toolSucceeded = true;
        } else {
          content = executeReadFileChunk(args.file_path, args.start_line, args.end_line);

          // UR-3 FIX: Only cache successful reads. Error responses are transient
          // (file may have just been created, graph not yet re-indexed).
          // Caching an error means subsequent reads return the stale error
          // until cache invalidation runs — which may never happen for read errors.
          let isReadError = false;
          try {
            const parsed = JSON.parse(content);
            isReadError = !!parsed.error;
          } catch {
            // Not JSON — treat as successful content
          }

          if (!isReadError) {
            chunkCacheSet(args.file_path, args.start_line, args.end_line, content);
            toolSucceeded = true;
          } else {
            // Don't cache, don't mark as success
            // isActionTool stays false so hadFailure is not set —
            // read errors are non-blocking (LLM can try a different path)
            toolSucceeded = false;
          }

          console.log(
            `[Ghost Interceptor] 📖 Read chunk: ${args.file_path}` +
              ` L${args.start_line}-${args.end_line} → ${content.length} chars` +
              (isReadError ? " [ERROR - not cached]" : "")
          );
        }
        isActionTool = false;

        // ── Patch tool ────────────────────────────────────────────────────────
      } else if (isPatchToolCall(name)) {
        isActionTool = true;
        content = await executePatchToolCall(argsStr, this.semanticCache);
        console.log(`[Ghost Interceptor] 🩹 Patch tool executed`);
        statsEmitter.recordAgentAction("astPatches");

        try {
          const parsed = JSON.parse(content);
          toolSucceeded = parsed.success === true;
          if (toolSucceeded) {
            console.log(`[Ghost Interceptor] ✅ Patch succeeded`);
            invalidateCacheForPatch(args.file_path, args.target_symbol || null);
            recordPatch(
              args.file_path,
              args.target_symbol || null,
              parsed.lines_changed ?? parsed.lines_inserted ?? 0
            );
            this._consecutivePatchFailures = 0;
            // BUG-4 FIX: Removed redundant invalidateRegistryEntry() call.
            // patchEngine.js's postPatchInvalidate() already handles semantic
            // dedup registry invalidation for the patched file.
          } else {
            console.log(`[Ghost Interceptor] ❌ Patch failed: ${parsed.error?.slice(0, 100)}`);
            chunkCacheInvalidateFile(args.file_path);
            invalidateCacheForFile(args.file_path);

            this._consecutivePatchFailures = (this._consecutivePatchFailures ?? 0) + 1;

            if (this._consecutivePatchFailures >= 3) {
              console.warn(
                `[Ghost Interceptor] ⚠️ ${this._consecutivePatchFailures} consecutive patch failures — forcing read hint`
              );
              content = JSON.stringify({
                success: false,
                error: parsed.error,
                hint:
                  `STOP retrying. Use read_file_chunk(file_path: "${args.file_path}", ` +
                  `start_line: 1, end_line: 99999) to get the exact current file content ` +
                  `before attempting another patch.`,
              });
            }
          }
        } catch {
          toolSucceeded = false;
          this._consecutivePatchFailures = (this._consecutivePatchFailures ?? 0) + 1;
        }

        // ── Vault retrieve ────────────────────────────────────────────────────
      } else if (normalized.includes("contextforge_retrieve")) {
        isActionTool = true;
        let vaultedText = null;
        const sq = (args.search_query ?? "").trim();

        if (sq && /^[\w$]+$/.test(sq)) {
          try {
            const graphHits = await executeGraphQuery("find_symbol", sq);
            const parsed = JSON.parse(graphHits);
            if (parsed.definitions?.length > 0 && parsed.definitions[0].body) {
              const hit = parsed.definitions[0];
              vaultedText =
                `[Graph result for '${sq}' from ${hit.file} lines ${hit.start_line}–${hit.end_line}]\n\n` +
                hit.body;
              console.log(`[Ghost Interceptor] 🗺️ Graph shortcut hit for '${sq}'`);
            }
          } catch {}
        }

        if (!vaultedText) {
          try {
            vaultedText = await retrieveFromVault(
              args.vault_id,
              sq || null,
              currentPayload.messages,
              this.semanticCache,
              this.hybridRetriever
            );
          } catch (err) {
            console.error(`[Ghost Interceptor] ⚠️ Vault retrieval failed: ${err.message}`);
          }
        }

        if (vaultedText) {
          this._retrievedVaultIds.add(args.vault_id);
          recordCCRSuccess(currentPayload, args.vault_id);
          statsEmitter.recordAgentAction("rawVaultOpens");
          console.log(
            `[Ghost Interceptor] ✅ Vault ${args.vault_id} opened (${vaultedText.length} chars)`
          );
          content = vaultedText;
          toolSucceeded = true;
          sessionCacheSet(name, argsStr, content);
        } else {
          content = `Vault ${args.vault_id} empty or not found.`;
          toolSucceeded = false;
        }

        // ── Memory tool ───────────────────────────────────────────────────────
      } else if (hasMemoryToolCalls({ tool_calls: [tc] })) {
        isActionTool = true;
        const userId = this.req.headers["x-contextforge-user-id"] ?? DEFAULT_MEMORY_USER_ID;
        const workspace = this.req.headers["x-contextforge-workspace"] ?? "";
        const toolResults = await executeMemoryToolCalls({ tool_calls: [tc] }, this.memoryHandler, {
          userId,
          workspace,
        });
        if (toolResults.length > 0) {
          content = toolResults[0].content;
          toolSucceeded = true;
          console.log("[Ghost Interceptor] 🧠 Memory tool executed successfully");
          sessionCacheSet(name, argsStr, content);
        } else {
          content = "Memory tool returned no results.";
          toolSucceeded = false;
        }
      }

      // Cache read-only results
      if (!isActionTool && toolSucceeded) {
        sessionCacheSet(name, argsStr, content);
      }

      if (isActionTool && toolSucceeded) madeForwardProgress = true;
      if (isActionTool && !toolSucceeded) hadFailure = true;

      results.push({
        tool_call_id: tc.id,
        name,
        content,
        __cf_raw: isReadFileChunkTool(name),
        _source_file: args.file_path || null,
      });
    }

    return {
      intercepted: true,
      results,
      toolCalls: backgroundCalls,
      madeForwardProgress,
      hadFailure,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry counter
//
// UR-8 FIX: maxRetries parameter now accepted and applied.
// Previously the streaming path passed maxRetries as a third argument
// but the function signature only had two parameters — it was silently
// ignored, making the per-request x-cf-max-retries header a no-op.
// ─────────────────────────────────────────────────────────────────────────────

export function computeNextRetry(result, retryCount, maxRetries = MAX_GHOST_RETRIES) {
  const limit = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : MAX_GHOST_RETRIES;
  // A successful action is a real state transition, so prior transient
  // failures must not poison the rest of the request's failure budget.
  if (result.madeForwardProgress) return 0;
  if (result.hadFailure) return Math.min(retryCount + 1, limit);
  return retryCount;
}

function failureBudgetWouldBeExhausted(result, retryCount, maxRetries = MAX_GHOST_RETRIES) {
  const limit = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : MAX_GHOST_RETRIES;
  // A completed action is the same forward-progress reset used by
  // computeNextRetry(). Do not terminate a mixed batch that actually made a
  // durable change merely because another action in that batch failed.
  return !result.madeForwardProgress && Boolean(result.hadFailure) && retryCount + 1 >= limit;
}

import {
  isNativeAnthropicEgress,
  buildNativeBody,
  buildNativeHeaders,
  NATIVE_PATH,
  NativeSSEAssembler,
  nativeMessageToInternal,
} from "./anthropicNative.js";

// ─────────────────────────────────────────────────────────────────────────────
// A2.3 (headroom analysis): prompt_cache_key for OpenAI-wire upstreams
//
// OpenAI's automatic prompt caching is keyed per (route, prompt_cache_key):
// a stable key per session lets consecutive turns of the same session hit
// the same cache bucket instead of a rolling best-effort match. We derive
// the key from SessionRegistry.deriveSessionId — the same stable-text hash
// (first real user message, system-reminders stripped) that scopes the CCR
// session, so it is constant for the whole session and changes only when
// the conversation truly starts over.
//
// Injected only for providers that speak the OpenAI wire format (openai,
// and the anthropic provider's OpenAI-compat endpoint). Ollama/Gemini don't
// consume the field; leaving it out keeps their payloads minimal.
//
// The field is stable across ghost hops (same payload object, same key) and
// is invisible to countTokens (which counts system/messages/tools only), so
// it adds ~25 stable bytes to the wire without skewing the savings math.
// ─────────────────────────────────────────────────────────────────────────────

const PROMPT_CACHE_KEY_PROVIDERS = new Set(["openai", "anthropic"]);

function derivePromptCacheKey(payload) {
  const messages = payload?.messages;
  // deriveSessionId falls back to a RANDOM id when no user message exists —
  // a per-request random key would defeat the cache, so skip in that case.
  if (!Array.isArray(messages) || !messages.some((m) => m.role === "user")) {
    return null;
  }
  return `cf-${SessionRegistry.deriveSessionId(payload)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage normalizer
// ─────────────────────────────────────────────────────────────────────────────

function normalizeUsage(rawUsage) {
  if (!rawUsage) return { input: 0, cacheRead: 0, output: 0 };

  if (rawUsage.cache_read_input_tokens !== undefined) {
    return {
      input: (rawUsage.input_tokens || 0) + (rawUsage.cache_creation_input_tokens || 0),
      cacheRead: rawUsage.cache_read_input_tokens || 0,
      output: rawUsage.output_tokens || 0,
    };
  }

  if (rawUsage.prompt_tokens !== undefined) {
    const totalPrompt = rawUsage.prompt_tokens || 0;
    const cacheRead = rawUsage.prompt_tokens_details?.cached_tokens || 0;
    return {
      input: Math.max(0, totalPrompt - cacheRead),
      cacheRead: cacheRead,
      output: rawUsage.completion_tokens || 0,
    };
  }

  return { input: 0, cacheRead: 0, output: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call safety boundary
//
// A background call is only allowed into ghost history after all of these are
// true: stream assembly had a stable identity, its name exactly matches an
// active ContextForge schema, and its decoded arguments satisfy that schema.
// This is intentionally stricter than `JSON.parse()` alone.
// ─────────────────────────────────────────────────────────────────────────────

function toInternalToolCalls(calls) {
  return (calls || [])
    .filter((call) => call && (call.function?.name || call.name))
    .map((call) => {
      const rawArguments = call.function?.arguments ?? call.arguments ?? "";
      const argumentsText =
        typeof rawArguments === "string"
          ? rawArguments
          : rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
            ? JSON.stringify(rawArguments)
            : "";
      return {
        id: call.id,
        type: call.type || "function",
        function: {
          name: call.function?.name || call.name,
          arguments: argumentsText,
        },
        ...(call.extra_content !== undefined ? { extra_content: call.extra_content } : {}),
      };
    });
}

function looksLikeContextForgeTool(name) {
  if (typeof name !== "string") return false;
  return (
    name.includes("contextforge_") || name.includes("read_file_chunk") || name.includes("memory_")
  );
}

/**
 * Normalize, repair, and validate a provider response before interception.
 * `passthrough` means no proxy history mutation; `rejected` is a terminal
 * safety response and likewise never appends the offending tool call.
 */
export function prepareGhostToolCalls(
  rawCalls,
  currentPayload,
  interceptor,
  { assemblyIssues = [] } = {}
) {
  const activeSchemas = activeToolSchemas(currentPayload);
  const originalCalls = toInternalToolCalls(rawCalls);
  const isKnownActiveBackgroundTool = (name) =>
    activeSchemas.has(name) && interceptor.isBackgroundTool(name);

  const repair = repairMergedToolCalls(originalCalls, {
    isKnownToolName: isKnownActiveBackgroundTool,
  });
  const hasFatalAssemblyIssue = hasFatalAssemblyIssues(assemblyIssues);
  const calls = repair.calls;
  const backgroundCalls = calls.filter((call) => interceptor.isBackgroundTool(call.function?.name));
  const hasPotentialContextForgeCall = calls.some((call) =>
    looksLikeContextForgeTool(call.function?.name)
  );
  const hasInactiveBareContextForgeCall = calls.some((call) => {
    const name = call.function?.name;
    return (
      looksLikeContextForgeTool(name) &&
      !String(name).startsWith("mcp__") &&
      !activeSchemas.has(name)
    );
  });

  if (backgroundCalls.length === 0) {
    // This includes genuine client-owned calls. Do not consume or rewrite a
    // mixed/client response in the proxy.
    if (
      hasInactiveBareContextForgeCall ||
      ((hasFatalAssemblyIssue || repair.issues.length > 0) && hasPotentialContextForgeCall)
    ) {
      return {
        kind: "rejected",
        reason: "ambiguous_tool_stream",
        message:
          "ContextForge rejected an ambiguous or malformed background tool stream before it could be replayed upstream.",
        calls,
      };
    }
    return { kind: "passthrough", calls };
  }

  // Never drop client-owned tool calls from a mixed batch. The old behavior
  // intercepted only the CF subset, silently losing the client-owned calls.
  if (backgroundCalls.length !== calls.length) {
    console.warn(
      "[Ghost Interceptor] ↪ Mixed background/client tool batch — passing through without ghost interception"
    );
    return { kind: "passthrough", calls };
  }

  if (hasFatalAssemblyIssue || repair.issues.length > 0) {
    return {
      kind: "rejected",
      reason: "ambiguous_tool_stream",
      message:
        "ContextForge rejected an ambiguous background tool stream before it could be replayed upstream.",
      calls,
    };
  }

  for (const call of backgroundCalls) {
    const validation = validateActiveToolCall(call, activeSchemas);
    if (!validation.ok) {
      console.warn(`[Ghost Interceptor] ⛔ Tool preflight rejected: ${validation.error}`);
      return {
        kind: "rejected",
        reason: "invalid_tool_call",
        message:
          `ContextForge rejected an invalid background tool call: ${validation.error}. ` +
          "The call was not appended to history and no recovery hop was sent.",
        calls,
      };
    }
    call.function.arguments = validation.normalizedArguments;
  }

  if (calls.length !== originalCalls.length) {
    console.warn(
      `[Ghost Interceptor] 🔧 Repaired merged tool call into ${calls.length} independently validated call(s)`
    );
  }

  return { kind: "ready", calls };
}

function reconcileStableToolsForGhostHop(payload) {
  const { added } = applyStableToolSet(payload, {
    mcpSession: isMcpToolSession(payload.tools),
  });
  if (added.length > 0) {
    console.log(`[StableTools] ✅ Ghost-hop +${added.join(", ")}`);
  }
}

function appendGhostHistory(currentPayload, { assistantContent = null, toolCalls, results }) {
  currentPayload.messages.push({
    role: "assistant",
    content: assistantContent,
    tool_calls: toolCalls,
  });

  for (const result of results) {
    let cfType = "text";
    if (result.__cf_raw) cfType = "code";
    else if (String(result.name || "").endsWith("contextforge_retrieve")) cfType = "code";
    else if (typeof result.content === "string" && result.content.trimStart().startsWith("{")) {
      cfType = "json";
    }

    currentPayload.messages.push({
      role: "tool",
      tool_call_id: result.tool_call_id,
      name: result.name,
      content: result.content,
      _cf_type: cfType,
      ...(result._source_file ? { _args: { file_path: result._source_file } } : {}),
      ...(result.__cf_raw ? { __cf_raw: true } : {}),
    });
  }

  // Fresh tool results are the one ghost-hop mutation that can introduce a
  // vault marker. Reconcile monotonically so a needed retrieve schema exists
  // before the next outbound request; existing schemas are never removed.
  interceptAndVaultMassiveToolResults(currentPayload);
  reconcileStableToolsForGhostHop(currentPayload);
}

function makeTerminalAssistantText(reason, detail) {
  return (
    `ContextForge stopped its internal background-tool loop (${reason}). ` +
    `${detail} No additional upstream request was sent.`
  );
}

function writeTerminalAssistantResponse({ res, clientAdapter, isStreamRequest, messageId, text }) {
  const response = {
    id: `msg_forge_safety_${Date.now()}`,
    object: "chat.completion",
    model: "contextforge",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  if (!isStreamRequest) {
    const { body, statusCode } = clientAdapter.fromInternal(response, 200);
    if (!res.headersSent) res.writeHead(statusCode, clientAdapter.responseHeaders(false));
    res.end(body);
    return;
  }

  if (!res.headersSent) res.writeHead(200, clientAdapter.responseHeaders(true));

  const terminalState = {
    inToolCall: false,
    inTextBlock: false,
    toolIndex: 0,
    nextBlockIndex: undefined,
    textBlockIndex: -1,
    currentToolIndex: -1,
  };
  const chunks = [
    JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "[DONE]",
  ];
  let first = true;
  for (const chunk of chunks) {
    const events = clientAdapter.fromInternalSSE(chunk, messageId, first, terminalState);
    first = false;
    for (const event of events) res.write(event);
  }
  res.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Upstream Handler Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createUpstreamHandler(ctx) {
  const {
    req,
    res,
    isAnthropic,
    clientAdapter,
    provider,
    semanticCache,
    hybridRetriever,
    onnxEmbedder,
    memoryHandler,
    maxRetries,
    mockUpstreamPort,
  } = ctx;

  const interceptor = new ToolInterceptor(ctx);

  return function executeUpstreamRequest(currentPayload, retryCount = 0, _acc = null) {
    const acc = _acc ?? {
      accumulatedInputTokens: 0,
      accumulatedBaselineTokens: 0,
      accumulatedCacheReadTokens: 0,
      ghostRetries: 0,
      hopCount: 0,
    };

    return new Promise((resolve, reject) => {
      const modelOverride = process.env.CF_MODEL_OVERRIDE;
      if (modelOverride) {
        currentPayload = { ...currentPayload, model: modelOverride };
      }

      // ── WorkspaceState injection ─────────────────────────────────────────
      const workspaceSummary =
        process.env.CF_MODE === "passthrough" ? null : buildWorkspaceSummary();

      if (workspaceSummary && currentPayload.messages?.length > 0) {
        const msgs = currentPayload.messages;

        const lastUserIdx = msgs.reduce((acc, m, i) => {
          if (m.role !== "user") return acc;
          if (
            Array.isArray(m.content) &&
            m.content.length > 0 &&
            m.content.every((b) => b.type === "tool_result")
          )
            return acc;
          return i;
        }, -1);

        if (lastUserIdx !== -1) {
          const lastUser = msgs[lastUserIdx];

          let alreadyInjected = false;
          if (typeof lastUser.content === "string") {
            alreadyInjected = lastUser.content.includes("[ContextForge WorkspaceState]");
          } else if (Array.isArray(lastUser.content)) {
            alreadyInjected = lastUser.content.some(
              (b) =>
                b.type === "text" &&
                typeof b.text === "string" &&
                b.text.includes("[ContextForge WorkspaceState]")
            );
          }

          if (!alreadyInjected) {
            if (typeof lastUser.content === "string") {
              msgs[lastUserIdx] = {
                ...lastUser,
                content: `${workspaceSummary}\n\n---\n\n${lastUser.content}`,
              };
            } else if (Array.isArray(lastUser.content)) {
              msgs[lastUserIdx] = {
                ...lastUser,
                content: [
                  { type: "text", text: `${workspaceSummary}\n\n---` },
                  ...lastUser.content,
                ],
              };
            }
          }
        }
      }

      if (process.env.CF_DEBUG_PAYLOAD === "1") {
        writeFileSync(
          path.join(__dirname, "../../debug_payload.json"),
          JSON.stringify(currentPayload, null, 2),
          "utf-8"
        );
        console.log("[Debug] Payload dumped to debug_payload.json");
      }

      let hopTokens = 0;
      try {
        hopTokens = countTokens(currentPayload);
        acc.accumulatedInputTokens += hopTokens;
        acc.hopCount++;
        acc.ghostRetries = acc.hopCount - 1;
        console.log(
          `\n[Wire Inspector] Transmitting ${hopTokens} tokens to LLM (Retry: ${retryCount})`
        );
      } catch {
        console.log("\n[Wire Inspector] Transmitting payload...");
      }

      // PC-3: native Anthropic egress — the client's original system/tools
      // (with their cache_control markers) are forwarded verbatim and our
      // additions are appended after them, so Anthropic's prompt caching is
      // preserved instead of destroyed. Off by default (CF_ANTHROPIC_NATIVE=1).
      // Requires: the client's original body captured by the caller (ctx).
      const nativeMode =
        Boolean(ctx.clientOriginalBody) &&
        isNativeAnthropicEgress({
          providerName: provider.name,
          clientAdapterName: clientAdapter.name,
        });

      // A2.3: stable per-session prompt_cache_key (OpenAI-wire providers).
      // Idempotent — ghost hops reuse the same payload object and key.
      // A client-sent key is always preserved (the !check above); we only
      // fill in when absent.
      //
      // PC-2 (provider-cache audit): prompt_cache_retention. OpenAI's
      // default cache retention is ~5-10 min idle; "24h" (long retention)
      // is available for workloads with long gaps between turns. A
      // client-sent value is preserved; otherwise CF_PROMPT_CACHE_RETENTION
      // opts in for the whole proxy ("5m" | "24h").
      // OpenAI-wire only — the native Anthropic body carries none of these
      // (it keys caching on cache_control markers, not prompt_cache_key).
      if (PROMPT_CACHE_KEY_PROVIDERS.has(provider.name) && !nativeMode) {
        if (!currentPayload.prompt_cache_key) {
          const key = derivePromptCacheKey(currentPayload);
          if (key) currentPayload.prompt_cache_key = key;
        }
        if (
          !currentPayload.prompt_cache_retention &&
          (process.env.CF_PROMPT_CACHE_RETENTION === "5m" ||
            process.env.CF_PROMPT_CACHE_RETENTION === "24h")
        ) {
          currentPayload.prompt_cache_retention = process.env.CF_PROMPT_CACHE_RETENTION;
        }
      }

      // PC-3: native vs OpenAI-wire request construction (nativeMode is
      // declared above, before the prompt_cache_key block that reads it).
      let outboundBody;
      let outboundHeaders;
      let outboundPath;
      if (nativeMode) {
        outboundBody = JSON.stringify(
          buildNativeBody({
            clientOriginal: ctx.clientOriginalBody,
            internalPayload: currentPayload,
          })
        );
        outboundHeaders = buildNativeHeaders(req.headers);
        outboundPath = NATIVE_PATH;
      } else {
        outboundBody = JSON.stringify(currentPayload);
        outboundHeaders = provider.transformHeaders(req.headers);
        outboundPath =
          typeof provider.transformPath === "function" ? provider.transformPath(req.url) : req.url;
      }
      outboundHeaders["content-length"] = Buffer.byteLength(outboundBody);

      const targetPort = ctx.mockUpstreamPort || provider.port;
      const targetHost = ctx.mockUpstreamPort ? "127.0.0.1" : provider.hostname;

      const requestOptions = {
        hostname: targetHost,
        port: targetPort,
        path: outboundPath,
        method: "POST",
        headers: outboundHeaders,
      };

      const isHttp =
        ctx.mockUpstreamPort ||
        provider.protocol === "http" ||
        provider.port === 11434 ||
        provider.port === 80;
      const requestModule = isHttp ? http : https;

      const isStreamRequest = currentPayload.stream === true;

      const proxyReq = requestModule.request(requestOptions, (proxyRes) => {
        let sseBuffer = "";
        const responseChunks = [];

        // Native egress holds a complete response until classification. A text
        // block can be followed by a background tool_use later in the same
        // message, so forwarding early is not actually safe: it prevents a
        // clean terminal response when a tool stream is malformed or budgeted.
        // Raw chunks are still forwarded verbatim after a safe classification.
        const nativeAssembler = nativeMode ? new NativeSSEAssembler() : null;
        if (nativeAssembler) {
          nativeAssembler.backgroundChecker = (name) => interceptor.isBackgroundTool(name);
        }
        const nativeHeld = nativeMode ? [] : null;

        let toolState = {
          inToolCall: false,
          inTextBlock: false,
          toolIndex: 0,
          nextBlockIndex: undefined,
          textBlockIndex: -1,
          currentToolIndex: -1,
        };

        let messageId = "msg_forge_" + Math.random().toString(36).substring(2, 15);
        let isFirstChunk = true;
        let fullStreamedText = "";
        let toolCalls = [];
        const streamToolCallAssembler = new StreamToolCallAssembler({
          knownToolNames: [...activeToolSchemas(currentPayload).keys()],
          idPrefix: `call_cf_${Date.now()}`,
        });
        let hasSeenToolCall = false;
        let heldEvents = [];
        let isStandardToolStream = false;
        let sseLineBuffer = "";

        // S-1: stateful UTF-8 decoder for the SSE byte stream. The old
        // chunk.toString("utf-8") decoded each TCP chunk independently: a
        // multi-byte character (CJK, emoji) split across a chunk boundary
        // became U+FFFD, the affected data line's JSON.parse failed, and
        // that delta was silently dropped. StringDecoder carries partial
        // sequences across chunks.
        const sseDecoder = new StringDecoder("utf-8");

        const processSSELine = (line) => {
          if (!line.startsWith("data: ")) return;
          let openAiData = line.substring(6).trim();
          if (!openAiData) return;

          try {
            if (openAiData !== "[DONE]") {
              const parsed = JSON.parse(openAiData);
              const delta = parsed.choices?.[0]?.delta;

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  delete tc.extra_content;
                }
                openAiData = JSON.stringify(parsed);
              }

              if (delta?.reasoning || delta?.content) {
                fullStreamedText += (delta.reasoning || "") + (delta.content || "");
              }

              if (delta?.tool_calls) {
                hasSeenToolCall = true;
                // IDs are primary identities; ambiguous anonymous parallel
                // streams are marked unsafe instead of being concatenated.
                streamToolCallAssembler.addAll(delta.tool_calls);
                toolCalls = streamToolCallAssembler.calls;
              }
            }
          } catch {
            /* ignore malformed partial chunks */
          }

          const translatedEvents = clientAdapter.fromInternalSSE(
            openAiData,
            messageId,
            isFirstChunk,
            toolState
          );

          if (clientAdapter.name === "anthropic" || clientAdapter.name === "gemini") {
            if (hasSeenToolCall && process.env.CF_MODE !== "passthrough") {
              if (!isStandardToolStream) {
                const allNamesComplete =
                  toolCalls.length > 0 &&
                  toolCalls.every((tc) => tc.arguments && tc.arguments.length > 0);
                if (allNamesComplete && !hasFatalAssemblyIssues(streamToolCallAssembler.issues)) {
                  const hasBackgroundTool = toolCalls.some((tc) =>
                    interceptor.isBackgroundTool(tc.name)
                  );
                  if (!hasBackgroundTool) {
                    isStandardToolStream = true;
                    if (!res.headersSent) {
                      res.writeHead(proxyRes.statusCode, clientAdapter.responseHeaders(true));
                    }
                    if (heldEvents.length > 0) {
                      for (const event of heldEvents) res.write(event);
                      heldEvents = [];
                    }
                  }
                }
              }

              if (!isStandardToolStream) {
                if (translatedEvents.length > 0) {
                  isFirstChunk = false;
                  heldEvents.push(...translatedEvents);
                }
                return;
              }
            }
          }

          if (!res.headersSent) {
            res.writeHead(proxyRes.statusCode, clientAdapter.responseHeaders(true));
          }
          if (translatedEvents.length > 0) {
            isFirstChunk = false;
            for (const event of translatedEvents) res.write(event);
          }
        };

        proxyRes.on("data", (chunk) => {
          responseChunks.push(chunk);

          if (proxyRes.statusCode >= 400) {
            console.error(`\n[Upstream Error ${proxyRes.statusCode}] ->`, chunk.toString("utf-8"));
          }

          if (!isStreamRequest) return;

          const rawSseText = sseDecoder.write(chunk);
          sseBuffer += rawSseText;

          // Native Anthropic streaming — keep raw bytes until message_stop so
          // tool classification and terminal safety handling remain possible.
          if (nativeMode) {
            sseLineBuffer += rawSseText;
            const nativeLines = sseLineBuffer.split("\n");
            sseLineBuffer = nativeLines.pop() ?? "";
            for (const line of nativeLines) nativeAssembler.processLine(line);
            nativeHeld.push(chunk);
            return;
          }

          if (clientAdapter.name === "openai") {
            if (!res.headersSent) res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.write(chunk);
            return;
          }

          sseLineBuffer += rawSseText;
          const lines = sseLineBuffer.split("\n");
          sseLineBuffer = lines.pop() ?? "";

          for (const line of lines) processSSELine(line);
        });

        proxyRes.on("end", async () => {
          const hopEndTime = performance.now();

          const finishTerminalGhostStop = (outcome) => {
            const text = makeTerminalAssistantText(
              outcome.terminalReason || outcome.reason || "safety_stop",
              outcome.terminalMessage ||
                outcome.message ||
                "ContextForge stopped the background tool operation."
            );
            if (!res.headersSent) {
              res.setHeader(
                "x-cf-ghost-stop",
                outcome.terminalReason || outcome.reason || "safety_stop"
              );
            }
            writeTerminalAssistantResponse({
              res,
              clientAdapter,
              isStreamRequest,
              messageId,
              text,
            });
            resolve({ hopEndTime, ...acc });
          };

          // S-2: end of stream — flush bytes still held by the UTF-8
          // decoder and process the final SSE line even when it arrived
          // without a trailing newline. Previously that line stayed in
          // sseLineBuffer and was silently dropped (a truncated final
          // tool-call argument delta loses its tail). A malformed tail
          // must never break the end path — G-3 guards history.
          try {
            const tail = sseDecoder.end();
            if (tail) {
              sseBuffer += tail;
              sseLineBuffer += tail;
            }
            if (sseLineBuffer) {
              const finalLines = sseLineBuffer.split("\n");
              sseLineBuffer = "";
              if (nativeMode) {
                for (const line of finalLines) nativeAssembler.processLine(line);
              } else {
                for (const line of finalLines) processSSELine(line);
              }
            }
          } catch {
            /* ignored — see comment above */
          }

          try {
            if (proxyRes.statusCode >= 400) {
              const fullResponseBuf = Buffer.concat(responseChunks);
              console.error(
                `\n[Upstream Error] Upstream rejected request (HTTP ${proxyRes.statusCode}):`
              );
              console.error(fullResponseBuf.toString("utf-8"));

              // PC-3: native egress — the error body is already in native
              // Anthropic error format ({"type":"error","error":{...}}),
              // which the Anthropic client speaks natively. Forward it
              // verbatim with its status; no reformatting.
              if (nativeMode) {
                if (!res.headersSent) {
                  res.writeHead(proxyRes.statusCode, {
                    "Content-Type": "application/json",
                  });
                }
                res.end(fullResponseBuf);
                resolve({ hopEndTime, ...acc });
                return;
              }

              // G-4 FIX: a STREAMING client (Claude Code) expects an SSE
              // stream. Forwarding the raw JSON error body made Claude Code
              // report "Streaming response ended before any complete data
              // was received. Retrying without streaming." — and the
              // non-streaming retry can hit the same 400. Emit a
              // well-formed Anthropic SSE error sequence instead so the
              // client surfaces a clean, retryable error. Only when nothing
              // was flushed to the client yet (otherwise the stream format
              // is already in flight and raw passthrough is the best option).
              if (isStreamRequest && !res.headersSent && clientAdapter.name === "anthropic") {
                let errMsg = `Upstream error ${proxyRes.statusCode}`;
                try {
                  const errObj = JSON.parse(fullResponseBuf.toString("utf-8"));
                  errMsg = errObj?.error?.message || errObj?.message || errMsg;
                } catch {
                  /* keep generic message */
                }
                res.writeHead(proxyRes.statusCode, clientAdapter.responseHeaders(true));
                res.write(
                  `event: message_start\ndata: ${JSON.stringify({
                    type: "message_start",
                    message: {
                      id: messageId,
                      type: "message",
                      role: "assistant",
                      content: [],
                      model: "contextforge",
                      stop_reason: null,
                      stop_sequence: null,
                      usage: { input_tokens: 0, output_tokens: 0 },
                    },
                  })}\n\n`
                );
                res.write(
                  `event: error\ndata: ${JSON.stringify({
                    type: "error",
                    error: { type: "upstream_error", message: String(errMsg).slice(0, 500) },
                  })}\n\n`
                );
                res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
                res.end();
                resolve({ hopEndTime, ...acc });
                return;
              }

              if (!res.headersSent) {
                res.writeHead(proxyRes.statusCode, {
                  "Content-Type": "application/json",
                });
              }
              res.end(fullResponseBuf);
              resolve({ hopEndTime, ...acc });
              return;
            }

            if (isStreamRequest && sseBuffer.length === 0) {
              const resetSeconds = parseFloat(proxyRes.headers["x-ratelimit-reset-tokens"]) || 60;
              if (!res.headersSent) res.writeHead(200, clientAdapter.responseHeaders(true));
              res.write(clientAdapter.rateLimitSSE(resetSeconds));
              res.end();
              resolve({ hopEndTime, ...acc });
              return;
            }

            // ═══════════════════════════════════════════════════════════════
            // STREAMING: GHOST INTERCEPTOR
            // ═══════════════════════════════════════════════════════════════
            if (isStreamRequest) {
              // PC-3: native egress — flush verbatim, or ghost-intercept
              // background tool_use calls (then re-hop natively).
              if (nativeMode) {
                const assembled = nativeAssembler.result();
                if (assembled.usage.input || assembled.usage.cacheRead || assembled.usage.output) {
                  acc.accumulatedInputTokens -= hopTokens;
                  acc.accumulatedInputTokens += assembled.usage.input + assembled.usage.cacheRead;
                  acc.accumulatedCacheReadTokens += assembled.usage.cacheRead;
                }
                if (assembled.error) {
                  if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                  }
                  res.end(
                    JSON.stringify({
                      type: "error",
                      error: { type: "api_error", message: String(assembled.error).slice(0, 500) },
                    })
                  );
                  resolve({ hopEndTime, ...acc });
                  return;
                }
                if (assembled.toolCalls.length > 0 && process.env.CF_MODE !== "passthrough") {
                  const prepared = prepareGhostToolCalls(
                    assembled.toolCalls.map((tc) => ({
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: tc.arguments },
                    })),
                    currentPayload,
                    interceptor
                  );

                  if (prepared.kind === "rejected") {
                    finishTerminalGhostStop(prepared);
                    return;
                  }

                  if (prepared.kind === "ready") {
                    const result = await interceptor.process(
                      prepared.calls,
                      currentPayload,
                      retryCount,
                      acc.hopCount
                    );
                    if (result.terminal) {
                      finishTerminalGhostStop(result);
                      return;
                    }
                    if (result.intercepted) {
                      if (failureBudgetWouldBeExhausted(result, retryCount, maxRetries)) {
                        finishTerminalGhostStop({
                          reason: "failure_budget",
                          message:
                            "ContextForge reached its failed-background-call budget before retrying the request.",
                        });
                        return;
                      }

                      appendGhostHistory(currentPayload, {
                        assistantContent: assembled.text || null,
                        toolCalls: result.toolCalls,
                        results: result.results,
                      });
                      const nextRetry = computeNextRetry(result, retryCount, maxRetries);
                      executeUpstreamRequest(currentPayload, nextRetry, acc)
                        .then(resolve)
                        .catch(reject);
                      return;
                    }
                  }
                }

                // Passthrough: flush any remaining held bytes verbatim
                // (when live forwarding unlocked earlier, nativeHeld is
                // already drained and bytes were streamed as they arrived).
                if (!res.headersSent) {
                  res.writeHead(proxyRes.statusCode, proxyRes.headers);
                }
                for (const b of nativeHeld) res.write(b);
                res.end();

                // UR-10: index final answers (no tool calls) into RAG.
                if (!assembled.toolCalls.length && assembled.text.trim().length > 0) {
                  (async () => {
                    try {
                      const tokenCount = Math.floor(assembled.text.length / 4);
                      if (tokenCount >= 50) {
                        const embedding = await onnxEmbedder.embed(assembled.text);
                        hybridRetriever.addDocumentWithEmbedding(
                          "IDX_" + crypto.randomUUID(),
                          assembled.text,
                          embedding
                        );
                      }
                    } catch (e) {
                      console.error("[RAG Index] Indexing failed:", e.message);
                    }
                  })();
                }
                resolve({ hopEndTime, ...acc });
                return;
              }

              if (hasSeenToolCall && process.env.CF_MODE !== "passthrough") {
                const prepared = prepareGhostToolCalls(toolCalls, currentPayload, interceptor, {
                  assemblyIssues: streamToolCallAssembler.issues,
                });

                if (prepared.kind === "rejected") {
                  finishTerminalGhostStop(prepared);
                  return;
                }

                if (prepared.kind === "ready") {
                  const result = await interceptor.process(
                    prepared.calls,
                    currentPayload,
                    retryCount,
                    acc.hopCount
                  );

                  if (result.terminal) {
                    finishTerminalGhostStop(result);
                    return;
                  }

                  if (result.intercepted) {
                    if (failureBudgetWouldBeExhausted(result, retryCount, maxRetries)) {
                      finishTerminalGhostStop({
                        reason: "failure_budget",
                        message:
                          "ContextForge reached its failed-background-call budget before retrying the request.",
                      });
                      return;
                    }

                    appendGhostHistory(currentPayload, {
                      assistantContent: fullStreamedText.length > 0 ? fullStreamedText : null,
                      toolCalls: result.toolCalls,
                      results: result.results,
                    });
                    const nextRetry = computeNextRetry(result, retryCount, maxRetries);
                    executeUpstreamRequest(currentPayload, nextRetry, acc)
                      .then(resolve)
                      .catch(reject);
                    return;
                  }
                }
              }

              return _replayAndEnd();

              function _replayAndEnd() {
                if (heldEvents.length > 0) {
                  if (!res.headersSent) {
                    res.writeHead(proxyRes.statusCode, clientAdapter.responseHeaders(true));
                  }
                  for (const event of heldEvents) res.write(event);
                }

                // UR-10 FIX: Only index final responses — not intermediate hops.
                // hasSeenToolCall is false on the final response (no more tool calls).
                // Indexing intermediate steps pollutes the retriever with navigation noise.
                if (!hasSeenToolCall && fullStreamedText.trim().length > 0) {
                  (async () => {
                    try {
                      const tokenCount = Math.floor(fullStreamedText.length / 4);
                      if (tokenCount >= 50) {
                        const embedding = await onnxEmbedder.embed(fullStreamedText);
                        hybridRetriever.addDocumentWithEmbedding(
                          "IDX_" + crypto.randomUUID(),
                          fullStreamedText,
                          embedding
                        );
                      }
                    } catch (err) {
                      console.error("[RAG Index] Indexing failed:", err.message);
                    }
                  })();
                }

                res.end();
                resolve({ hopEndTime, ...acc });
              }
            }

            // ═══════════════════════════════════════════════════════════════
            // NON-STREAMING
            // ═══════════════════════════════════════════════════════════════
            const fullResponseBuf = Buffer.concat(responseChunks);

            // PC-3: native egress — passthrough verbatim, or ghost-intercept
            // background tool_use blocks (then re-hop natively).
            if (nativeMode) {
              let nativeJson;
              try {
                nativeJson = JSON.parse(fullResponseBuf.toString("utf-8"));
              } catch {
                // Unparseable body — forward verbatim.
                if (!res.headersSent) {
                  res.writeHead(proxyRes.statusCode, {
                    ...proxyRes.headers,
                    "Access-Control-Allow-Origin": "*",
                  });
                }
                res.write(fullResponseBuf);
                res.end();
                resolve({ hopEndTime, ...acc });
                return;
              }

              if (nativeJson.type === "error" || nativeJson.error) {
                if (!res.headersSent) {
                  res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
                }
                res.end(fullResponseBuf);
                resolve({ hopEndTime, ...acc });
                return;
              }

              const internal = nativeMessageToInternal(nativeJson.message);
              if (internal.usage.input || internal.usage.cacheRead || internal.usage.output) {
                acc.accumulatedInputTokens -= hopTokens;
                acc.accumulatedInputTokens += internal.usage.input + internal.usage.cacheRead;
                acc.accumulatedCacheReadTokens += internal.usage.cacheRead;
              }

              if (internal.toolCalls.length > 0 && process.env.CF_MODE !== "passthrough") {
                const prepared = prepareGhostToolCalls(
                  internal.toolCalls,
                  currentPayload,
                  interceptor
                );

                if (prepared.kind === "rejected") {
                  finishTerminalGhostStop(prepared);
                  return;
                }

                if (prepared.kind === "ready") {
                  const result = await interceptor.process(
                    prepared.calls,
                    currentPayload,
                    retryCount,
                    acc.hopCount
                  );
                  if (result.terminal) {
                    finishTerminalGhostStop(result);
                    return;
                  }
                  if (result.intercepted) {
                    if (failureBudgetWouldBeExhausted(result, retryCount, maxRetries)) {
                      finishTerminalGhostStop({
                        reason: "failure_budget",
                        message:
                          "ContextForge reached its failed-background-call budget before retrying the request.",
                      });
                      return;
                    }

                    appendGhostHistory(currentPayload, {
                      assistantContent: internal.content ?? null,
                      toolCalls: result.toolCalls,
                      results: result.results,
                    });
                    const nextRetry = computeNextRetry(result, retryCount, maxRetries);
                    executeUpstreamRequest(currentPayload, nextRetry, acc)
                      .then(resolve)
                      .catch(reject);
                    return;
                  }
                }
              }

              // Passthrough: forward the native JSON verbatim.
              if (!res.headersSent) {
                res.writeHead(proxyRes.statusCode, {
                  ...proxyRes.headers,
                  "Access-Control-Allow-Origin": "*",
                });
              }
              res.write(fullResponseBuf);
              res.end();

              // UR-10: index final answers (no tool calls) into RAG.
              if (!internal.toolCalls.length && internal.content?.trim().length > 0) {
                (async () => {
                  try {
                    const tokenCount = Math.floor(internal.content.length / 4);
                    if (tokenCount >= 50) {
                      const embedding = await onnxEmbedder.embed(internal.content);
                      hybridRetriever.addDocumentWithEmbedding(
                        "IDX_" + crypto.randomUUID(),
                        internal.content,
                        embedding
                      );
                    }
                  } catch (e) {
                    console.error("[RAG Index] Indexing failed:", e.message);
                  }
                })();
              }
              resolve({ hopEndTime, ...acc });
              return;
            }

            let jsonResponse;

            try {
              jsonResponse = JSON.parse(fullResponseBuf.toString("utf-8"));
            } catch {
              if (!res.headersSent) {
                res.writeHead(proxyRes.statusCode, {
                  ...proxyRes.headers,
                  "Access-Control-Allow-Origin": "*",
                });
              }
              res.write(fullResponseBuf);
              res.end();
              resolve({ hopEndTime, ...acc });
              return;
            }

            const message = jsonResponse.choices?.[0]?.message;

            if (message?.tool_calls?.length > 0 && process.env.CF_MODE !== "passthrough") {
              const prepared = prepareGhostToolCalls(
                message.tool_calls,
                currentPayload,
                interceptor
              );

              if (prepared.kind === "rejected") {
                finishTerminalGhostStop(prepared);
                return;
              }

              if (prepared.kind === "ready") {
                const result = await interceptor.process(
                  prepared.calls,
                  currentPayload,
                  retryCount,
                  acc.hopCount
                );

                if (result.terminal) {
                  finishTerminalGhostStop(result);
                  return;
                }

                if (result.intercepted) {
                  if (failureBudgetWouldBeExhausted(result, retryCount, maxRetries)) {
                    finishTerminalGhostStop({
                      reason: "failure_budget",
                      message:
                        "ContextForge reached its failed-background-call budget before retrying the request.",
                    });
                    return;
                  }

                  const toolCallsWithMeta = result.toolCalls.map((tc) => {
                    const original = message.tool_calls.find((orig) => orig.id === tc.id);
                    return original?.extra_content
                      ? { ...tc, extra_content: original.extra_content }
                      : tc;
                  });

                  appendGhostHistory(currentPayload, {
                    assistantContent: message.content ?? null,
                    toolCalls: toolCallsWithMeta,
                    results: result.results,
                  });
                  const nextRetry = computeNextRetry(result, retryCount, maxRetries);
                  executeUpstreamRequest(currentPayload, nextRetry, acc)
                    .then(resolve)
                    .catch(reject);
                  return;
                }
              }
            }

            const { body, statusCode: outStatus } = clientAdapter.fromInternal(
              jsonResponse,
              proxyRes.statusCode
            );

            if (!res.headersSent) {
              res.writeHead(outStatus, clientAdapter.responseHeaders(false));
            }
            res.write(body);
            res.end();

            // UR-10 FIX: Only index when no tool calls — this is the final response
            if (
              proxyRes.statusCode === 200 &&
              !message?.tool_calls?.length &&
              message?.content?.trim().length > 0
            ) {
              (async () => {
                try {
                  const tokenCount = Math.floor(message.content.length / 4);
                  if (tokenCount >= 50) {
                    const embedding = await onnxEmbedder.embed(message.content);
                    hybridRetriever.addDocumentWithEmbedding(
                      "IDX_" + crypto.randomUUID(),
                      message.content,
                      embedding
                    );
                  }
                } catch (e) {
                  console.error("[RAG Index] Indexing failed:", e.message);
                }
              })();
            }

            if (jsonResponse.usage) {
              const normalizedUsage = normalizeUsage(jsonResponse.usage);
              acc.accumulatedInputTokens -= hopTokens;
              acc.accumulatedInputTokens += normalizedUsage.input + normalizedUsage.cacheRead;
              acc.accumulatedCacheReadTokens += normalizedUsage.cacheRead;
            }

            resolve({ hopEndTime, ...acc });
          } catch (handlerErr) {
            console.error("[ProxyRes End] Unhandled error:", handlerErr.message);
            // UR-9 FIX: Destroy the socket before rejecting to prevent leak.
            // Without destroy(), the proxyReq socket stays open after the
            // Promise is rejected — no callback will ever close it.
            proxyReq.destroy();
            reject(handlerErr);
          }
        });
      });

      proxyReq.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bad Gateway", details: err.message }));
        }
        reject(err);
      });

      proxyReq.write(outboundBody);
      proxyReq.end();
    });
  };
}
