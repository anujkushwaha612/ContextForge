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
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { statsEmitter } from "./statsEmitter.js";

import { countTokens } from "../compression/compressionHelper.js";
import { interceptAndVaultMassiveToolResults } from "../compression/fatCatch.js";
import { retrieveFromVault } from "../vaultRetriever.js";
import { recordCCRSuccess } from "../ccr/index.js";
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
import { invalidateRegistryEntry } from "../compression/semanticDedup.js";
import { processPayloadForTelemetry } from "./toolTelemetry.js";

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
const MAX_GRAPH_ONLY_ROUNDS = 3;
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

class ToolInterceptor {
  constructor(ctx) {
    this.semanticCache = ctx.semanticCache;
    this.hybridRetriever = ctx.hybridRetriever;
    this.memoryHandler = ctx.memoryHandler;
    this.req = ctx.req;

    this._graphOnlyRounds = 0;
    this._retrievedVaultIds = new Set();
    this._resolvedConcepts = new Map();
    this._consecutivePatchFailures = 0;
    this._callFrequency = new Map();
    this._MAX_IDENTICAL_CALLS = 3;
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
    if (retryCount >= MAX_GHOST_RETRIES) {
      console.warn(
        `[Ghost Interceptor] ⛔ Failure circuit breaker tripped ` +
          `(${retryCount} failures >= ${MAX_GHOST_RETRIES} max)`
      );
      return { intercepted: true, circuitBreakerTripped: true, toolCalls };
    }

    if (hopCount >= MAX_HOP_COUNT) {
      console.warn(
        `[Ghost Interceptor] ⛔ Hop circuit breaker tripped ` +
          `(${hopCount} hops >= ${MAX_HOP_COUNT} max)`
      );
      return { intercepted: true, circuitBreakerTripped: true, toolCalls };
    }

    const backgroundCalls = toolCalls.filter((tc) => this.isBackgroundTool(tc.function?.name));
    if (backgroundCalls.length === 0) return { intercepted: false };

    const allAreReadOnly = backgroundCalls.every((tc) => {
      const n = tc.function?.name || "";
      return (
        (isGraphToolCall(n) && !normalizeGraphToolName(n).includes("contextforge_retrieve")) ||
        isReadFileChunkTool(n)
      );
    });

    if (allAreReadOnly) {
      this._graphOnlyRounds++;
      if (this._graphOnlyRounds > MAX_GRAPH_ONLY_ROUNDS) {
        console.warn(
          `[Ghost Interceptor] ⚠️ Exploration loop detected ` +
            `(${this._graphOnlyRounds} read-only rounds > ${MAX_GRAPH_ONLY_ROUNDS} max) ` +
            `— injecting navigation-timeout hint`
        );
        const timeoutResults = backgroundCalls.map((tc) => ({
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify({
            error: "NAVIGATION_TIMEOUT",
            hint:
              `You have spent ${this._graphOnlyRounds} consecutive rounds on read-only exploration ` +
              `(graph queries and file reads) without taking any action. ` +
              `You have enough context to proceed. ` +
              `Stop exploring and either: (1) apply a patch with contextforge_patch_ast, ` +
              `(2) create the file directly, or (3) report what you found.`,
          }),
        }));
        return {
          intercepted: true,
          results: timeoutResults,
          toolCalls: backgroundCalls,
          madeForwardProgress: false,
          hadFailure: true,
        };
      }
    } else {
      this._graphOnlyRounds = 0;
    }

    console.log(
      `\n[Ghost Interceptor] 🔍 Intercepted ${backgroundCalls.length} background tool(s) ` +
        `(retry ${retryCount}/${MAX_GHOST_RETRIES})`
    );

    const results = [];
    let madeForwardProgress = false;
    let hadFailure = false;

    for (const tc of backgroundCalls) {
      const name = tc.function.name;
      const argsStr = tc.function.arguments || "{}";

      // ── Session cache ──────────────────────────────────────────────────────
      const cachedResult = sessionCacheGet(name, argsStr);
      if (cachedResult !== null) {
        results.push({ tool_call_id: tc.id, name, content: cachedResult });
        continue;
      }

      // ── Stall detection ────────────────────────────────────────────────────
      const stallCheck = this._checkAndRecordCall(name, argsStr);
      if (stallCheck.isStall) {
        console.warn(
          `[Ghost Interceptor] 🔁 Stall detected: ${name} called ${stallCheck.count}x ` +
            `with identical args — injecting loop-break hint`
        );
        results.push({
          tool_call_id: tc.id,
          name,
          content: stallCheck.hintMessage,
        });
        hadFailure = true;
        continue;
      }

      let args = {};
      try {
        args = JSON.parse(argsStr);
      } catch (err) {
        console.error(
          `[Ghost Interceptor] ⚠️ Args JSON malformed for ${name}: "${argsStr.slice(0, 120)}"`
        );
        results.push({
          tool_call_id: tc.id,
          name,
          content: JSON.stringify({
            error: `Malformed JSON arguments: ${err.message}`,
          }),
        });
        hadFailure = true;
        continue;
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
            invalidateRegistryEntry(args.file_path);
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
        const userId = this.req.headers["x-contextforge-user-id"] ?? "anonymous";
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

function computeNextRetry(result, retryCount, maxRetries = MAX_GHOST_RETRIES) {
  if (result.madeForwardProgress) return retryCount;
  if (result.hadFailure) return Math.min(retryCount + 1, maxRetries);
  return retryCount;
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
      if (retryCount === 0) {
        setTimeout(() => processPayloadForTelemetry(currentPayload, req.headers), 0);
      }

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

      const outboundBody = JSON.stringify(currentPayload);
      const outboundHeaders = provider.transformHeaders(req.headers);
      outboundHeaders["content-length"] = Buffer.byteLength(outboundBody);

      const outboundPath =
        typeof provider.transformPath === "function" ? provider.transformPath(req.url) : req.url;

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
        let hasSeenToolCall = false;
        let heldEvents = [];
        let isStandardToolStream = false;
        let sseLineBuffer = "";

        proxyRes.on("data", (chunk) => {
          responseChunks.push(chunk);

          if (proxyRes.statusCode >= 400) {
            console.error(`\n[Upstream Error ${proxyRes.statusCode}] ->`, chunk.toString("utf-8"));
          }

          if (!isStreamRequest) return;

          const rawSseText = chunk.toString("utf-8");
          sseBuffer += rawSseText;

          if (clientAdapter.name === "openai") {
            if (!res.headersSent) res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.write(chunk);
            return;
          }

          sseLineBuffer += rawSseText;
          const lines = sseLineBuffer.split("\n");
          sseLineBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let openAiData = line.substring(6).trim();
            if (!openAiData) continue;

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
                  for (const tc of delta.tool_calls) {
                    let idx = tc.index;

                    if (tc.id) {
                      const existingIdx = toolCalls.findIndex((t) => t?.id === tc.id);
                      if (existingIdx !== -1) {
                        idx = existingIdx;
                      } else {
                        idx = toolCalls.length;
                      }
                    } else if (tc.function?.name) {
                      if (toolCalls.length > 0 && toolCalls[toolCalls.length - 1].name) {
                        idx = toolCalls.length;
                      } else {
                        idx = Math.max(0, toolCalls.length - 1);
                      }
                    } else if (idx === undefined) {
                      idx = Math.max(0, toolCalls.length - 1);
                    }

                    if (!toolCalls[idx]) {
                      toolCalls[idx] = {
                        id: tc.id || `call_cf_${Date.now()}_${idx}`,
                        name: "",
                        arguments: "",
                        extra_content: null,
                      };
                    }
                    if (tc.id) toolCalls[idx].id = tc.id;
                    if (tc.function?.name) toolCalls[idx].name += tc.function.name;
                    if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
                    if (tc.extra_content) toolCalls[idx].extra_content = tc.extra_content;
                  }
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
                  if (allNamesComplete) {
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
                  continue;
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
          }
        });

        proxyRes.on("end", async () => {
          const hopEndTime = performance.now();

          try {
            if (proxyRes.statusCode >= 400) {
              const fullResponseBuf = Buffer.concat(responseChunks);
              console.error(
                `\n[Upstream Error] Upstream rejected request (HTTP ${proxyRes.statusCode}):`
              );
              console.error(fullResponseBuf.toString("utf-8"));

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
              if (hasSeenToolCall && process.env.CF_MODE !== "passthrough") {
                const validToolCalls = toolCalls
                  .filter((tc) => tc.name)
                  .map((tc) => {
                    const call = {
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: tc.arguments },
                    };
                    if (tc.extra_content) call.extra_content = tc.extra_content;
                    return call;
                  });

                if (validToolCalls.length > 0) {
                  const result = await interceptor.process(
                    validToolCalls,
                    currentPayload,
                    retryCount,
                    acc.hopCount
                  );

                  if (result.intercepted) {
                    if (result.circuitBreakerTripped) {
                      currentPayload.messages.push(
                        {
                          role: "assistant",
                          content: null,
                          tool_calls: validToolCalls,
                        },
                        ...validToolCalls.map((tc) => ({
                          role: "tool",
                          tool_call_id: tc.id,
                          name: tc.function.name,
                          content:
                            `SYSTEM_ERROR: Background tool budget exhausted ` +
                            `(${MAX_GHOST_RETRIES} hops used). Do not retry this tool. ` +
                            `Summarise what you have found so far and proceed using only standard file tools.`,
                        }))
                      );
                      executeUpstreamRequest(currentPayload, 0, acc).then(resolve).catch(reject);
                      return;
                    }

                    currentPayload.messages.push({
                      role: "assistant",
                      content: fullStreamedText.length > 0 ? fullStreamedText : null,
                      tool_calls: result.toolCalls,
                    });

                    for (const r of result.results) {
                      let cfType = "text";
                      if (r.__cf_raw) cfType = "code";
                      else if (r.name === "contextforge_retrieve") cfType = "code";
                      else if (
                        typeof r.content === "string" &&
                        r.content.trimStart().startsWith("{")
                      )
                        cfType = "json";

                      currentPayload.messages.push({
                        role: "tool",
                        tool_call_id: r.tool_call_id,
                        name: r.name,
                        content: r.content,
                        _cf_type: cfType,
                        ...(r.__cf_raw ? { __cf_raw: true } : {}),
                      });
                    }

                    interceptAndVaultMassiveToolResults(currentPayload);

                    // UR-8 FIX: pass maxRetries so per-request budget applies
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

            if (
              message?.tool_calls &&
              message.tool_calls.length > 0 &&
              process.env.CF_MODE !== "passthrough"
            ) {
              const result = await interceptor.process(
                message.tool_calls,
                currentPayload,
                retryCount,
                acc.hopCount
              );

              if (result.intercepted) {
                if (result.circuitBreakerTripped) {
                  currentPayload.messages.push(
                    {
                      role: "assistant",
                      content: message.content ?? null,
                      tool_calls: message.tool_calls,
                    },
                    ...message.tool_calls.map((tc) => ({
                      role: "tool",
                      tool_call_id: tc.id,
                      name: tc.function.name,
                      content:
                        `SYSTEM_ERROR: Background tool budget exhausted ` +
                        `(${MAX_GHOST_RETRIES} hops used). Do not retry this tool. ` +
                        `Summarise what you have found so far and proceed using only standard file tools.`,
                    }))
                  );
                  executeUpstreamRequest(currentPayload, 0, acc).then(resolve).catch(reject);
                  return;
                }

                const toolCallsWithMeta = result.toolCalls.map((tc) => {
                  const original = message.tool_calls.find((orig) => orig.id === tc.id);
                  if (original?.extra_content) {
                    return { ...tc, extra_content: original.extra_content };
                  }
                  return tc;
                });

                currentPayload.messages.push({
                  role: "assistant",
                  content: message.content ?? null,
                  tool_calls: toolCallsWithMeta,
                });

                for (const r of result.results) {
                  let cfType = "text";
                  if (r.__cf_raw) cfType = "code";
                  else if (r.name === "contextforge_retrieve") cfType = "code";
                  else if (typeof r.content === "string" && r.content.trimStart().startsWith("{"))
                    cfType = "json";

                  currentPayload.messages.push({
                    role: "tool",
                    tool_call_id: r.tool_call_id,
                    name: r.name,
                    content: r.content,
                    _cf_type: cfType,
                    ...(r.__cf_raw ? { __cf_raw: true } : {}),
                  });
                }

                interceptAndVaultMassiveToolResults(currentPayload);

                // UR-8 FIX: consistent with streaming path
                const nextRetry = computeNextRetry(result, retryCount, maxRetries);
                executeUpstreamRequest(currentPayload, nextRetry, acc).then(resolve).catch(reject);
                return;
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
