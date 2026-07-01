/**
 * upstreamRequest.js
 *
 * Retry counter logic:
 *   - Graph queries: do NOT increment retryCount (cheap, cached exploration)
 *   - Vault retrieval success: does NOT increment (necessary forward work)
 *   - Patch success: does NOT increment (forward progress)
 *   - ANY failure (patch miss, vault miss, malformed args): ALWAYS increments
 *   - Graph-only rounds capped at MAX_GRAPH_ONLY_ROUNDS (navigation loop guard)
 *
 * This replaces the old hasSuccess logic which had two bugs:
 *   1. Failed patches didn't increment → infinite retries on whitespace mismatch
 *   2. Successful graph queries incremented → burned budget on normal exploration
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizePathForCache(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath ?? "";

  // Normalize separators
  const p = filePath.replace(/\\/g, "/");

  // Already absolute — normalize and lowercase
  if (path.isAbsolute(filePath) || /^[A-Za-z]:\//.test(p)) {
    return p.toLowerCase();
  }

  // Relative — resolve against workspace root for canonical form
  try {
    const workspaceRoot = getWorkspaceRoot();
    return path.resolve(workspaceRoot, filePath).replace(/\\/g, "/").toLowerCase();
  } catch {
    // getWorkspaceRoot not ready yet — use normalized relative path
    return p.toLowerCase();
  }
}

const MAX_GHOST_RETRIES = 10;
const MAX_GRAPH_ONLY_ROUNDS = 3;
const MAX_HOP_COUNT = 15;

// ── Chunk cache ──────────────────────────────────────────────────────────────
// Caches file lines read during the session so overlapping reads
// (e.g. L100-120 followed by L103-118) don't hit disk twice.
// Key: "filepath:startLine:endLine" → content string
// Cleared alongside SESSION_TOOL_CACHE when a patch modifies the file.
const CHUNK_CACHE = new Map();
const CHUNK_CACHE_MAX = 100;

function chunkCacheKey(filePath, startLine, endLine) {
  return `${normalizePathForCache(filePath)}:${startLine}:${endLine}`;
}

function chunkCacheGet(filePath, startLine, endLine) {
  return CHUNK_CACHE.get(chunkCacheKey(filePath, startLine, endLine)) ?? null;
}

function chunkCacheSet(filePath, startLine, endLine, content) {
  if (CHUNK_CACHE.size >= CHUNK_CACHE_MAX) {
    CHUNK_CACHE.delete(CHUNK_CACHE.keys().next().value);
  }
  CHUNK_CACHE.set(chunkCacheKey(filePath, startLine, endLine), content);
}

// ── WorkspaceState ────────────────────────────────────────────────────────
// Tracks what has been modified during this session so the LLM doesn't
// need to re-discover changes via graph queries.
// Injected as a compact system note before every upstream call.
const workspaceState = {
  modifiedFiles: new Map(), // filePath → { linesChanged, lastPatchedAt, symbol }
  verifiedSymbols: new Set(), // symbols confirmed patched and read-back verified
  recentPatches: [], // last 5 patches for context window injection
};

function recordPatch(filePath, symbol, linesChanged) {
  workspaceState.modifiedFiles.set(filePath, {
    linesChanged,
    lastPatchedAt: Date.now(),
    symbol: symbol || "GLOBAL",
  });
  workspaceState.recentPatches.unshift({
    file: filePath,
    symbol: symbol || "GLOBAL",
    linesChanged,
    at: new Date().toISOString(),
  });
  // Keep only last 5
  if (workspaceState.recentPatches.length > 5) {
    workspaceState.recentPatches.pop();
  }
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
      lines.push(`  • [${p.at}] ${p.file}::${p.symbol} — ${p.linesChanged} lines`);
    }
  }
  lines.push(
    "NOTE: These files have already been patched. Do not re-patch unless you have verified the current state with read_file_chunk."
  );
  return lines.join("\n");
}

function chunkCacheInvalidateFile(filePath) {
  const normalized = normalizePathForCache(filePath);
  for (const key of CHUNK_CACHE.keys()) {
    if (key.startsWith(`${normalized}:`)) {
      CHUNK_CACHE.delete(key);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session-scoped tool result cache
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_TOOL_CACHE = new Map();
const SESSION_CACHE_MAX = 200;

function _sessionCacheKey(name, argsStr) {
  try {
    const parsed = JSON.parse(argsStr || "{}");

    // ── Normalize contextforge_retrieve args ──────────────────────────
    if (name === "contextforge_retrieve" || name?.includes("contextforge_retrieve")) {
      const canonical = { vault_id: parsed.vault_id ?? "" };
      const sq = (parsed.search_query ?? "").trim();
      if (sq) canonical.search_query = sq;
      return `${name}:${JSON.stringify(canonical)}`;
    }

    // ── Normalize read_file_chunk file_path ───────────────────────────
    // The LLM passes absolute paths on some calls and relative paths on
    // others for the same file. Normalize to canonical form so both
    // produce the same cache key.
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

export function invalidateCacheForPatch(filePath, symbol) {
  // Normalize the file path to match how it was stored in the cache key
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
      }
      continue;
    }

    if (keyLower.includes(fileBasename)) {
      SESSION_TOOL_CACHE.delete(key);
      cleared++;
    }
  }

  chunkCacheInvalidateFile(filePath); // already normalized inside
}

export function invalidateCacheForFile(filePath) {
  const normalizedPath = normalizePathForCache(filePath);
  const fileBasename = normalizedPath.split("/").pop().replace(".js", "").toLowerCase();

  let cleared = 0;

  for (const key of SESSION_TOOL_CACHE.keys()) {
    const keyLower = key.toLowerCase();
    if (keyLower.includes(fileBasename)) {
      SESSION_TOOL_CACHE.delete(key);
      cleared++;
    }
  }

  chunkCacheInvalidateFile(filePath); // already normalized inside
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

    // ── Stall detector ──────────────────────────────────────────────────
    // Tracks how many times each tool+args combination has been called
    // within this request chain. Key: "toolName:argsJson" → call count.
    // If the same call appears MAX_IDENTICAL_CALLS times consecutively,
    // the LLM is stuck in a loop — we interrupt with a hint.
    this._callFrequency = new Map();
    this._MAX_IDENTICAL_CALLS = 3;
  }

  /**
   * Records a tool call and checks if it has been called too many times
   * with identical arguments. Returns true if the call is a stall loop.
   *
   * Uses the same normalized key as sessionCacheGet so cache hits and
   * stall detection are always in sync — if the session cache is working,
   * a repeated call would have been served from cache and never reach here.
   * A stall reaching this check means the cache missed (different args
   * or cache was invalidated), and the LLM is genuinely re-requesting
   * the same thing.
   *
   * @param {string} name    - Tool name
   * @param {string} argsStr - Raw arguments JSON string
   * @returns {{ isStall: boolean, count: number, hintMessage: string|null }}
   */
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
    // ── Dual circuit breaker ──────────────────────────────────────────────
    // retryCount: failure budget — increments only on patch/vault failures
    //             and stall detections. Catches broken operation loops.
    // hopCount:   exploration budget — increments on every LLM round-trip.
    //             Catches pure graph/read exploration loops that never fail
    //             but also never make forward progress toward completion.
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

    // ── Exploration loop guard ────────────────────────────────────────────
    // Tracks consecutive rounds where ALL calls are read-only exploration
    // (graph queries + read_file_chunk). Resets when any write operation
    // (patch, vault retrieve, memory) appears in the batch.
    //
    // FIX 1: Was "graph-only" — now covers read_file_chunk too since mixed
    //         graph+read loops were bypassing the old allAreGraphQueries check.
    //
    // FIX 2: Was returning { intercepted: false } which let tool calls pass
    //         through to the LLM WITHOUT executing them and WITHOUT tool result
    //         messages. This caused API errors (tool call with no result) or
    //         LLM hallucination. Now injects a navigation-timeout hint instead.
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
        // Inject a hint message for EACH stalled tool call so the LLM
        // receives a valid tool result for every tool call it made.
        // Returning { intercepted: false } here would leave tool calls
        // without results, causing downstream API errors.
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
          hadFailure: true, // increment retryCount so circuit breaker can catch runaway
        };
      }
    } else {
      // A write operation appeared — reset the read-only round counter
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

      // ── Session cache ──
      const cachedResult = sessionCacheGet(name, argsStr);
      if (cachedResult !== null) {
        results.push({ tool_call_id: tc.id, name, content: cachedResult });
        continue;
      }

      // ── Stall detection ──────────────────────────────────────────────────────
      // Only reaches here if the session cache missed — meaning the LLM is
      // requesting a tool call we have NOT seen before (or cache was invalidated).
      // If we have seen this EXACT call MAX_IDENTICAL_CALLS times already without
      // a cache hit, the LLM is in a genuine stall loop.
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
        hadFailure = true; // treat stall as failure so retryCount increments
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

      if (isGraphToolCall(name)) {
        if (args.query_type && args.target !== undefined) {
          // ── Concept dedup for find() only ─────────────────────────────────
          if (args.query_type === "find") {
            const conceptKey = normalizeConceptKey(args.target);
            const resolvedResult = this._resolvedConcepts.get(conceptKey);

            if (resolvedResult !== undefined) {
              //               console.log(
              //                 `[Ghost Interceptor] 🔁 Concept cache hit: find("${args.target}") ` +
              //                   `→ key "${conceptKey}" (${resolvedResult.length} chars)`
              //               );
              // Set content and fall through — metrics, session cache, results.push all run normally
              content = resolvedResult;
              toolSucceeded = true;
              isActionTool = false;
              // Skip the executeGraphQuery call but continue normal pipeline below
            }
          }

          // Only execute if not already resolved by concept cache above
          if (!content) {
            content = await executeGraphQuery(args.query_type, args.target, args);
            console.log(
              `[Ghost Interceptor] ✅ Graph: ${args.query_type}("${args.target}") → ${content.length} chars`
            );
            statsEmitter.recordAgentAction("graphLookups");
            toolSucceeded = true;
            isActionTool = false;

            // ── Mark concept resolved only on genuine find() success ────────
            // Parse the JSON response and check the structured found flag —
            // never use content.length as a success proxy.
            if (args.query_type === "find") {
              try {
                const parsed = JSON.parse(content);
                // found:true + count>0 = genuine result
                // result:"not_found" = miss — don't cache, let variations try
                if (parsed.found === true && parsed.count > 0) {
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
      } else if (isReadFileChunkTool(name)) {
        // Check chunk cache first — avoids re-reading overlapping regions
        const cachedChunk = chunkCacheGet(args.file_path, args.start_line, args.end_line);
        if (cachedChunk !== null) {
          content = cachedChunk;
          //           console.log(
          //             `[Ghost Interceptor] ♻️ Chunk cache hit: ${args.file_path}` +
          //               ` L${args.start_line}-${args.end_line} → ${content.length} chars`
          //           );
        } else {
          content = executeReadFileChunk(args.file_path, args.start_line, args.end_line);
          chunkCacheSet(args.file_path, args.start_line, args.end_line, content);
          console.log(
            `[Ghost Interceptor] 📖 Read chunk: ${args.file_path}` +
              ` L${args.start_line}-${args.end_line} → ${content.length} chars`
          );
        }
        toolSucceeded = true;
        isActionTool = false;
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

            // ── Invalidate semantic dedup registry for this file ──────────────
            // After a patch, the file content has changed. If the dedup registry
            // still holds the pre-patch entry, the next turn will see the new
            // content as a near-duplicate of the old version and emit a vault stub
            // referencing stale content. Invalidating here forces the post-patch
            // content to be registered fresh on the next turn.
            invalidateRegistryEntry(args.file_path);
          } else {
            console.log(`[Ghost Interceptor] ❌ Patch failed: ${parsed.error?.slice(0, 100)}`);

            // ← NEW: clear chunk cache so next read hits disk not stale cache
            chunkCacheInvalidateFile(args.file_path);

            // ← NEW: clear graph cache for this file too
            invalidateCacheForFile(args.file_path);

            // ← NEW: consecutive failure guard
            this._consecutivePatchFailures = (this._consecutivePatchFailures ?? 0) + 1;
            if (this._consecutivePatchFailures >= 3) {
              console.warn(
                `[Ghost Interceptor] ⚠️ ${this._consecutivePatchFailures} consecutive patch failures — forcing read hint`
              );
              content = JSON.stringify({
                success: false,
                error: parsed.error,
                hint: `STOP retrying. Use read_file_chunk(file_path: "${args.file_path}", start_line: 1, end_line: 99999) to get the exact current file content before attempting another patch.`,
              });
            }
          }
        } catch {
          toolSucceeded = false;
          this._consecutivePatchFailures = (this._consecutivePatchFailures ?? 0) + 1;
        }
      } else if (normalized.includes("contextforge_retrieve")) {
        isActionTool = true;
        let vaultedText = null;
        const sq = (args.search_query ?? "").trim();

        // ── Graph shortcut for simple symbol queries ──────────────────────
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
          // ── Compress on first retrieval of this vault ─────────────────
          // _retrievedVaultIds tracks vaults seen this request chain.
          // First access: compress and cache the compressed form.
          // Subsequent accesses: session cache hit returns compressed form
          //   directly — this block is never reached again for the same
          //   vault+query combination after Change 1 normalizes the key.
          if (!this._retrievedVaultIds.has(args.vault_id)) {
            this._retrievedVaultIds.add(args.vault_id);
            const { compressCodeOutput } = await import("../compression/astCompressor.js");
            const compressed = compressCodeOutput(vaultedText, "", null, null);
            if (compressed.vaulted || compressed.kept !== vaultedText) {
              const reduction =
                vaultedText.length > 0
                  ? Math.round((1 - compressed.kept.length / vaultedText.length) * 100)
                  : 0;
              vaultedText =
                `[CF_VAULT:${args.vault_id}] Structure preview (${reduction}% smaller).\n` +
                `To get the FULL raw source for patching, call contextforge_retrieve ` +
                `with vault_id="${args.vault_id}" again.\n\n` +
                compressed.kept;
              console.log(
                `[Ghost Interceptor] 📦 Vault ${args.vault_id} compressed on first access: ` +
                  `${vaultedText.length} chars (${reduction}% reduction)`
              );
            }
          }

          recordCCRSuccess(currentPayload, args.vault_id);
          statsEmitter.recordAgentAction("rawVaultOpens");
          console.log(
            `[Ghost Interceptor] ✅ Vault ${args.vault_id} opened (${vaultedText.length} chars)`
          );
          content = vaultedText;
          toolSucceeded = true;

          // ── Cache the compressed form immediately ─────────────────────
          // Write to session cache here rather than at the bottom of the
          // loop so the cached value is always the compressed preview.
          // The bottom-of-loop cache write is skipped for action tools
          // unless isPatchToolCall is false — which creates the inconsistency
          // where raw content gets cached on second retrieval.
          // Writing here guarantees the compressed form is always cached.
          sessionCacheSet(name, argsStr, content);
        } else {
          content = `Vault ${args.vault_id} empty or not found.`;
          toolSucceeded = false;
        }
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
          // Cache memory results — same user+query produces same result
          // within a request chain. Prevents redundant memory searches
          // if the LLM calls the same memory tool twice.
          sessionCacheSet(name, argsStr, content);
        } else {
          content = "Memory tool returned no results.";
          toolSucceeded = false;
        }
      }

      // Cache read-only tool results (graph queries, read_file_chunk).
      // Action tools manage their own cache writes inside their blocks:
      //   - patch:    writes nothing (mutates disk, results not reusable)
      //   - retrieve: writes compressed form immediately after compression
      //   - memory:   writes on success inside the memory block above
      if (!isActionTool) {
        sessionCacheSet(name, argsStr, content);
      }

      // Track progress and failures
      if (isActionTool && toolSucceeded) madeForwardProgress = true;
      if (isActionTool && !toolSucceeded) hadFailure = true;

      results.push({ tool_call_id: tc.id, name, content, __cf_raw: isReadFileChunkTool(name) });
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
// Retry counter logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the next retryCount value after an intercepted tool round.
 *
 * Rules:
 *   - Forward progress (patch success, vault success) → retryCount unchanged
 *   - Failure (patch fail, vault miss, stall detection) → retryCount + 1
 *   - Pure exploration (graph queries, reads) → retryCount unchanged
 *     These are governed by MAX_HOP_COUNT in acc, not retryCount.
 *
 * @param {object} result      - Return value from interceptor.process()
 * @param {number} retryCount  - Current failure budget counter
 * @returns {number}
 */
function computeNextRetry(result, retryCount) {
  if (result.madeForwardProgress) return retryCount;
  if (result.hadFailure) return retryCount + 1;
  // Pure exploration (graph/read) — retryCount unchanged, hop budget handles it
  return retryCount;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Usage Normalizer
// ─────────────────────────────────────────────────────────────────────────────

function normalizeUsage(rawUsage) {
  if (!rawUsage) {
    return { input: 0, cacheRead: 0, output: 0 };
  }

  // 1. Anthropic Format
  if (rawUsage.cache_read_input_tokens !== undefined) {
    return {
      input: (rawUsage.input_tokens || 0) + (rawUsage.cache_creation_input_tokens || 0),
      cacheRead: rawUsage.cache_read_input_tokens || 0,
      output: rawUsage.output_tokens || 0,
    };
  }

  // 2. OpenAI / Ollama Format
  if (rawUsage.prompt_tokens !== undefined) {
    const totalPrompt = rawUsage.prompt_tokens || 0;
    const cacheRead = rawUsage.prompt_tokens_details?.cached_tokens || 0;
    return {
      // In OpenAI, prompt_tokens includes the cached tokens.
      // We subtract them to find the "active" input tokens that cost full price.
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
    // ── PATCH 1: hopCount added to acc ──
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

      // ── Inject WorkspaceState summary ─────────────────────────────────────────
      // Only inject if:
      //   1. Not in passthrough mode
      //   2. There are actually modified files to report
      //   3. The current hop has a user message to inject into
      //   4. The workspace summary hasn't already been injected into THIS
      //      specific message (guard against re-injection on recursive hops)
      //
      // FIX 1: Array content is now handled correctly — workspace state is
      //         prepended as a new text block instead of converting the array
      //         to a JSON string.
      //
      // FIX 2: Only inject on hops where a patch has actually occurred
      //         (workspaceState.modifiedFiles.size > 0). Graph-only hops
      //         that haven't patched anything don't need workspace state.
      //
      // FIX 3: The summary is built once and checked against a stable sentinel
      //         marker rather than scanning the full content string.
      const workspaceSummary =
        process.env.CF_MODE === "passthrough" ? null : buildWorkspaceSummary();

      if (workspaceSummary && currentPayload.messages?.length > 0) {
        const msgs = currentPayload.messages;

        // Find the last human-authored user message.
        // Skip tool result messages (role:"tool" in OpenAI format,
        // or role:"user" with all tool_result blocks in Anthropic format).
        const lastUserIdx = msgs.reduce((acc, m, i) => {
          if (m.role !== "user") return acc;
          // Skip Anthropic-format tool result messages
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

          // ── Check if already injected into this message ────────────────
          // Use a stable sentinel check that works for both string and
          // array content without stringifying the entire content.
          let alreadyInjected = false;

          if (typeof lastUser.content === "string") {
            alreadyInjected = lastUser.content.includes("[ContextForge WorkspaceState]");
          } else if (Array.isArray(lastUser.content)) {
            // Check if any text block starts with the sentinel
            alreadyInjected = lastUser.content.some(
              (b) =>
                b.type === "text" &&
                typeof b.text === "string" &&
                b.text.includes("[ContextForge WorkspaceState]")
            );
          }

          if (!alreadyInjected) {
            if (typeof lastUser.content === "string") {
              // String content — prepend as plain text
              msgs[lastUserIdx] = {
                ...lastUser,
                content: `${workspaceSummary}\n\n---\n\n${lastUser.content}`,
              };
            } else if (Array.isArray(lastUser.content)) {
              // Array content (Anthropic format) — prepend as a new text block.
              // FIX 1: Do NOT convert array to string. Insert a text block
              // at the front of the array to preserve the block structure.
              msgs[lastUserIdx] = {
                ...lastUser,
                content: [
                  { type: "text", text: `${workspaceSummary}\n\n---` },
                  ...lastUser.content,
                ],
              };
            }
            // If content is null/undefined (tool-only assistant message),
            // skip injection — there is nowhere to put it.
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
        // ── PATCH 2: track physical hops independently from failure budget ──
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

      // Ask the provider adapter to translate the route
      const outboundPath =
        typeof provider.transformPath === "function" ? provider.transformPath(req.url) : req.url;

      // Use the mock port if it exists, otherwise use standard provider
      const targetPort = ctx.mockUpstreamPort || provider.port;
      const targetHost = ctx.mockUpstreamPort ? "127.0.0.1" : provider.hostname;

      const requestOptions = {
        hostname: targetHost,
        port: targetPort,
        path: outboundPath,
        method: "POST",
        headers: outboundHeaders,
      };

      // If hitting the local mock provider, always use HTTP
      const isHttp =
        ctx.mockUpstreamPort ||
        provider.protocol === "http" ||
        provider.port === 11434 ||
        provider.port === 80;
      const requestModule = isHttp ? http : https;

      const providerBase = provider.port
        ? `${provider.hostname}:${provider.port}`
        : provider.hostname;

      if (retryCount === 0) {
        //         console.log(`\n[Route] ${req.url} -> ${providerBase}${outboundPath}`);
      } else {
        //         console.log(`\n[Ghost Interceptor] Retry #${retryCount} -> ${providerBase}${outboundPath}`);
      }

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

        // SSE line buffer — handles chunks that split across TCP packets
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

          // ── Buffered SSE line parser ──────────────────────────────────
          // Google's API splits SSE events across multiple TCP chunks.
          // We buffer incomplete lines and only process complete ones.
          sseLineBuffer += rawSseText;
          const lines = sseLineBuffer.split("\n");

          // The last element is either empty (complete) or a partial line.
          // Keep it in the buffer for the next chunk.
          sseLineBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let openAiData = line.substring(6).trim();
            if (!openAiData) continue;

            try {
              if (openAiData !== "[DONE]") {
                const parsed = JSON.parse(openAiData);
                const delta = parsed.choices?.[0]?.delta;

                // Strip Google's non-standard extra_content from tool calls
                // before any downstream processing touches it
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
                    // ── Preserve Gemini thought_signature for echo-back ──
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
            // 🚨 NEW: Catch upstream HTTP errors immediately, even on streams
            if (proxyRes.statusCode >= 400) {
              const fullResponseBuf = Buffer.concat(responseChunks);
              console.error(
                `\n[Upstream Error] Google Gemini Rejected the Request (HTTP ${proxyRes.statusCode}):`
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
                    // Echo Gemini's thought_signature back — required for
                    // multi-hop tool calls or Gemini throws HTTP 400
                    if (tc.extra_content) {
                      call.extra_content = tc.extra_content;
                    }
                    return call;
                  });

                if (validToolCalls.length > 0) {
                  const result = await interceptor.process(
                    validToolCalls,
                    currentPayload,
                    retryCount,
                    acc.hopCount // ← pass hop count for dual circuit breaker
                  );

                  if (result.intercepted) {
                    if (result.circuitBreakerTripped) {
                      //                       console.warn(
                      //                         `\n⚠️  [Ghost Interceptor] Circuit breaker TRIPPED on streaming path.`
                      //                       );
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
                          content: `SYSTEM_ERROR: Background tool budget exhausted (${MAX_GHOST_RETRIES} hops used). Do not retry this tool. Summarise what you have found so far and proceed using only standard file tools.`,
                        }))
                      );
                      executeUpstreamRequest(currentPayload, 0, acc).then(resolve).catch(reject);
                      return;
                    }

                    currentPayload.messages.push({
                      role: "assistant",
                      content: fullStreamedText.length > 0 ? fullStreamedText : null,
                      // Include extra_content (thought_signature) so Gemini
                      // accepts the next hop without throwing HTTP 400
                      tool_calls: result.toolCalls,
                    });

                    for (const r of result.results) {
                      currentPayload.messages.push({
                        role: "tool",
                        tool_call_id: r.tool_call_id,
                        name: r.name,
                        content: r.content,
                        ...(r.__cf_raw ? { __cf_raw: true } : {}),
                      });
                    }

                    interceptAndVaultMassiveToolResults(currentPayload);

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

                if (fullStreamedText.trim().length > 0) {
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
                acc.hopCount // ← pass hop count for dual circuit breaker
              );

              if (result.intercepted) {
                if (result.circuitBreakerTripped) {
                  //                   console.warn(
                  //                     `\n⚠️  [Ghost Interceptor] Circuit breaker TRIPPED on non-streaming path.`
                  //                   );
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
                      content: `SYSTEM_ERROR: Background tool budget exhausted (${MAX_GHOST_RETRIES} hops used). Do not retry this tool. Summarise what you have found so far and proceed using only standard file tools.`,
                    }))
                  );
                  executeUpstreamRequest(currentPayload, 0, acc).then(resolve).catch(reject);
                  return;
                }

                // Re-attach any provider-specific extra_content from the
                // original message tool calls so Gemini accepts the next hop
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
                  currentPayload.messages.push({
                    role: "tool",
                    tool_call_id: r.tool_call_id,
                    name: r.name,
                    content: r.content,
                    ...(r.__cf_raw ? { __cf_raw: true } : {}),
                  });
                }

                interceptAndVaultMassiveToolResults(currentPayload);

                const nextRetry = computeNextRetry(result, retryCount);
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

            if (proxyRes.statusCode === 200 && message?.content?.trim().length > 0) {
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

            // ── Extract Usage Tokens ──
            if (jsonResponse.usage) {
              const normalizedUsage = normalizeUsage(jsonResponse.usage);
              // Replace the locally estimated 'hopTokens' with the true input from the LLM
              acc.accumulatedInputTokens -= hopTokens;
              acc.accumulatedInputTokens += normalizedUsage.input + normalizedUsage.cacheRead;
              acc.accumulatedCacheReadTokens += normalizedUsage.cacheRead;
            }

            resolve({ hopEndTime, ...acc });
          } catch (handlerErr) {
            console.error("[ProxyRes End] Unhandled error:", handlerErr.message);
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
