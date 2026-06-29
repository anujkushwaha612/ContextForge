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
import { retrieveFromVault } from "../vaultRetriever.js";
import { recordCCRSuccess } from "../ccr/index.js";
import {
  isGraphToolCall,
  executeGraphQuery,
  normalizeGraphToolName,
  isReadFileChunkTool,
  executeReadFileChunk,
} from "../graph/graphTools.js";
import { isPatchToolCall, executePatchToolCall, PATCH_TOOL_NAME } from "../graph/patchTools.js";
import { hasMemoryToolCalls, executeMemoryToolCalls } from "../memory/memoryTools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_GHOST_RETRIES = 10;
const MAX_GRAPH_ONLY_ROUNDS = 5;

// ── Chunk cache ──────────────────────────────────────────────────────────────
// Caches file lines read during the session so overlapping reads
// (e.g. L100-120 followed by L103-118) don't hit disk twice.
// Key: "filepath:startLine:endLine" → content string
// Cleared alongside SESSION_TOOL_CACHE when a patch modifies the file.
const CHUNK_CACHE = new Map();
const CHUNK_CACHE_MAX = 100;

function chunkCacheKey(filePath, startLine, endLine) {
  return `${filePath}:${startLine}:${endLine}`;
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
  // Remove all cached chunks for a file when it gets patched
  for (const key of CHUNK_CACHE.keys()) {
    if (key.startsWith(`${filePath}:`)) {
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

/**
 * Surgical cache invalidation after a patch.
 *
 * Invalidation rules:
 *   1. If target_symbol is known → only clear find_symbol entries for
 *      that exact symbol. All other symbols stay cached.
 *   2. Always clear find_route entries for the patched file — routes
 *      may have shifted line numbers after a patch.
 *   3. Always clear chunk cache entries for the patched file — content
 *      has changed so any cached line ranges are stale.
 *   4. Never clear symbols from OTHER files — they are unaffected.
 *
 *
 * @param {string} filePath     - The file that was patched
 * @param {string|null} symbol  - The specific symbol that was modified, or null for global patches
 */
export function invalidateCacheForPatch(filePath, symbol) {
  const fileBasename = filePath.replace(/\\/g, "/").split("/").pop().toLowerCase();

  let cleared = 0;

  for (const key of SESSION_TOOL_CACHE.keys()) {
    const keyLower = key.toLowerCase();

    // Always clear find_route for this file — line numbers may have shifted
    if (keyLower.includes('"find_route"') && keyLower.includes(fileBasename.replace(".js", ""))) {
      SESSION_TOOL_CACHE.delete(key);
      cleared++;
      continue;
    }

    // If we know the specific symbol, only clear that symbol's cache entry
    if (symbol) {
      const symbolLower = symbol.toLowerCase();
      if (keyLower.includes('"find_symbol"') && keyLower.includes(`"${symbolLower}"`)) {
        SESSION_TOOL_CACHE.delete(key);
        cleared++;
      }
      // Leave all other find_symbol entries intact — they are still valid
      continue;
    }

    // No symbol known (global patch) — clear all entries referencing this file
    if (keyLower.includes(fileBasename.replace(".js", ""))) {
      SESSION_TOOL_CACHE.delete(key);
      cleared++;
    }
  }

  // Always clear chunk cache for the patched file — content has changed
  chunkCacheInvalidateFile(filePath);

  if (cleared > 0) {
    console.log(
      `[Ghost Interceptor] 🗑️  Invalidated ${cleared} cache entries` +
        (symbol ? ` for symbol '${symbol}'` : ` for file '${fileBasename}'`)
    );
  }
}

/**
 * Surgical cache invalidation for external file modifications.
 *
 * Called by the file watcher when a file is saved externally
 * (not via patch). Clears all cache entries for THIS file only.
 *
 * Differs from invalidateCacheForPatch:
 *   - invalidateCacheForPatch: knows the specific symbol → ultra-surgical
 *   - invalidateCacheForFile: file changed externally → clear all symbols in this file
 *
 * @param {string} filePath - The file that was modified
 */
export function invalidateCacheForFile(filePath) {
  const fileBasename = filePath.replace(/\\/g, "/").split("/").pop().toLowerCase();

  let cleared = 0;

  for (const key of SESSION_TOOL_CACHE.keys()) {
    const keyLower = key.toLowerCase();

    // Clear all graph queries for this file
    // (find_symbol, find_route, show_callers, etc.)
    if (keyLower.includes(fileBasename.replace(".js", ""))) {
      SESSION_TOOL_CACHE.delete(key);
      cleared++;
    }
  }

  // Clear all chunk cache entries for this file
  chunkCacheInvalidateFile(filePath);

  if (cleared > 0) {
    console.log(
      `[Ghost Interceptor] 🗑️  Invalidated ${cleared} cache entries for file '${fileBasename}'`
    );
  }
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

  async process(toolCalls, currentPayload, retryCount) {
    if (retryCount >= MAX_GHOST_RETRIES) {
      return { intercepted: true, circuitBreakerTripped: true, toolCalls };
    }

    const backgroundCalls = toolCalls.filter((tc) => this.isBackgroundTool(tc.function?.name));
    if (backgroundCalls.length === 0) return { intercepted: false };

    // ── Graph-only loop guard ─────────────────────────────────────────────
    const allAreGraphQueries = backgroundCalls.every((tc) => {
      const n = tc.function?.name || "";
      return isGraphToolCall(n) && !normalizeGraphToolName(n).includes("contextforge_retrieve");
    });

    if (allAreGraphQueries) {
      this._graphOnlyRounds++;
      if (this._graphOnlyRounds > MAX_GRAPH_ONLY_ROUNDS) {
        console.warn(
          `\n[Ghost Interceptor] ⚠️  Graph-only round ${this._graphOnlyRounds} — ` +
            `LLM stuck in navigation loop. Letting through to force decision.`
        );
        return { intercepted: false };
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

      // ── Session cache ──
      const cachedResult = sessionCacheGet(name, argsStr);
      if (cachedResult !== null) {
        console.log(`[Ghost Interceptor] ♻️ Session cache hit: ${name}("${argsStr.slice(0, 60)}")`);
        results.push({ tool_call_id: tc.id, name, content: cachedResult });
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
          content = executeGraphQuery(args.query_type, args.target);
          console.log(
            `[Ghost Interceptor] ✅ Graph: ${args.query_type}("${args.target}") → ${content.length} chars`
          );
          statsEmitter.recordAgentAction("graphLookups");
          toolSucceeded = true;
          isActionTool = false;
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
          console.log(
            `[Ghost Interceptor] ♻️ Chunk cache hit: ${args.file_path}` +
              ` L${args.start_line}-${args.end_line} → ${content.length} chars`
          );
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
          } else {
            console.log(`[Ghost Interceptor] ❌ Patch failed: ${parsed.error?.slice(0, 100)}`);
          }
        } catch {
          toolSucceeded = false;
        }
      } else if (normalized.includes("contextforge_retrieve")) {
        isActionTool = true;
        let vaultedText = null;
        const sq = (args.search_query || "").trim();

        if (sq && /^[\w$]+$/.test(sq)) {
          try {
            const graphHits = executeGraphQuery("find_symbol", sq);
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
              args.search_query || null,
              currentPayload.messages,
              this.semanticCache,
              this.hybridRetriever
            );
          } catch (err) {
            console.error(`[Ghost Interceptor] ⚠️ Vault retrieval failed: ${err.message}`);
          }
        }

        if (vaultedText) {
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
        } else {
          content = "Memory tool returned no results.";
          toolSucceeded = false;
        }
      }

      // Cache graph query results (not patches — those are write operations)
      if (!isActionTool || isPatchToolCall(name) === false) {
        sessionCacheSet(name, argsStr, content);
      }

      // Track progress and failures
      if (isActionTool && toolSucceeded) madeForwardProgress = true;
      if (isActionTool && !toolSucceeded) hadFailure = true;

      results.push({ tool_call_id: tc.id, name, content });
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

function computeNextRetry(result, retryCount, maxRetries = MAX_GHOST_RETRIES) {
  if (result.madeForwardProgress) {
    return retryCount;
  }
  if (result.hadFailure) {
    return retryCount + 1;
  }
  return retryCount;
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
      ghostRetries: 0,
      hopCount: 0,
    };

    return new Promise((resolve, reject) => {
      const modelOverride = process.env.CF_MODEL_OVERRIDE;
      if (modelOverride) {
        currentPayload = { ...currentPayload, model: modelOverride };
      }

      // ── Inject WorkspaceState summary ─────────────────────────────────
      // Tells the LLM what has already been patched this session so it
      // doesn't re-search for symbols it already modified.
      const workspaceSummary = buildWorkspaceSummary();
      if (workspaceSummary && currentPayload.messages?.length > 0) {
        const msgs = currentPayload.messages;
        const lastUserIdx = msgs.reduce((acc, m, i) => (m.role === "user" ? i : acc), -1);
        if (lastUserIdx !== -1) {
          // Prepend workspace state to the last user message as a text block
          const lastUser = msgs[lastUserIdx];
          const existingContent =
            typeof lastUser.content === "string"
              ? lastUser.content
              : JSON.stringify(lastUser.content);
          // Only inject if not already present (avoid duplication on retries)
          if (!existingContent.includes("[ContextForge WorkspaceState]")) {
            msgs[lastUserIdx] = {
              ...lastUser,
              content: `${workspaceSummary}\n\n---\n\n${existingContent}`,
            };
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
        console.log(`\n[Route] ${req.url} -> ${providerBase}${outboundPath}`);
      } else {
        console.log(`\n[Ghost Interceptor] Retry #${retryCount} -> ${providerBase}${outboundPath}`);
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
              if (hasSeenToolCall) {
                if (translatedEvents.length > 0) {
                  isFirstChunk = false;
                  heldEvents.push(...translatedEvents);
                }
                continue;
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
              if (hasSeenToolCall) {
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
                    retryCount
                  );

                  if (result.intercepted) {
                    if (result.circuitBreakerTripped) {
                      console.warn(
                        `\n⚠️  [Ghost Interceptor] Circuit breaker TRIPPED on streaming path.`
                      );
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
                      content: null,
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
                      });
                    }

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

            if (message?.tool_calls && message.tool_calls.length > 0) {
              const result = await interceptor.process(
                message.tool_calls,
                currentPayload,
                retryCount
              );

              if (result.intercepted) {
                if (result.circuitBreakerTripped) {
                  console.warn(
                    `\n⚠️  [Ghost Interceptor] Circuit breaker TRIPPED on non-streaming path.`
                  );
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
                  });
                }

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
