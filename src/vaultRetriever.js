/**
 * vaultRetriever.js
 *
 * Fixes applied:
 *   VR-1: require("path") replaced with static ES module import.
 *         process.cwd() base replaced with getWorkspaceRoot() for
 *         consistent path resolution regardless of server start directory.
 *
 *   VR-2: targetLine now correctly converted from 1-indexed (LLM input)
 *         to 0-indexed (array ops) immediately after parsing. Previously
 *         "line:219" was treated as 0-indexed, giving a slice centered
 *         on display line 220 instead of 219.
 *
 *   VR-3: recordVaultRetrieval calls use vaultId ?? fallback string
 *         to prevent undefined being passed as the vault ID key.
 *
 *   VR-6: TIER 2 now uses hybridRetriever with a lower threshold (0.3)
 *         instead of semanticCache (planner anchor cache) at 0.9.
 *         semanticCache contains intent classification anchors, not vault
 *         content — searching it for vault retrieval was always a miss.
 *
 *   VR-7: TIER 1 results now include vault ID header when vaultId is
 *         known, so the LLM can associate retrieved content with the
 *         vault stub in its conversation history.
 *
 *   VR-8: fetchNeighborChunks calls parallelized with Promise.all
 *         instead of sequential awaits. Reduces DB round-trips from
 *         O(n) sequential to O(1) parallel for n chunk results.
 */

import { getEmbedder } from "./memory/embedder.js";
import fs from "node:fs";
import path from "node:path";
import {
  fetchFromCache,
  fetchChunksByIds,
  fetchVaultTextConcatenated,
  fetchNeighborChunks,
  fetchFromVault,
} from "./logging/cacheDb.js";
import { statsEmitter } from "./proxy/statsEmitter.js";
import { getWorkspaceRoot } from "./graph/graphDb.js";

// ─────────────────────────────────────────────
// Tier 0.5: Line-hint file slice
// ─────────────────────────────────────────────

const LINE_HINT_PATTERN = /\bline[:\s]+(\d+)\b/i;
const FILE_PATH_PATTERN = /\b((?:src\/|\.\/)?[\w/\\.\-]+\.\w{1,6})\b/;

const SLICE_BEFORE = 15;
const SLICE_AFTER  = 25;

function tryLineHintSlice(searchQuery) {
  if (!searchQuery || typeof searchQuery !== "string") return null;

  const lineMatch = searchQuery.match(LINE_HINT_PATTERN);
  const fileMatch = searchQuery.match(FILE_PATH_PATTERN);

  if (!lineMatch || !fileMatch) return null;

  // VR-2 FIX: targetLine1 is 1-indexed (from LLM/find_route output).
  // Convert immediately to 0-indexed for all array operations.
  // Previously targetLine was used as 0-indexed without conversion,
  // causing the slice to be centered 1 line too late in the file.
  const targetLine1 = parseInt(lineMatch[1], 10);
  const targetLine  = targetLine1 - 1; // 0-indexed for array ops

  const filePath = fileMatch[1].replace(/\\/g, "/");

  // VR-1 FIX: Use path module (static import) + getWorkspaceRoot()
  // instead of require("path") (invalid in ES modules) and process.cwd()
  // (inconsistent when server starts from a parent directory).
  const absolutePath =
    filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)
      ? filePath
      : path.join(getWorkspaceRoot(), filePath);

  try {
    const source = fs.readFileSync(absolutePath, "utf-8").replace(/\r\n/g, "\n");
    const lines  = source.split("\n");

    // VR-2 FIX: Use 0-indexed targetLine for bounds check
    if (targetLine < 0 || targetLine >= lines.length) return null;

    const startLine = Math.max(0, targetLine - SLICE_BEFORE);
    const endLine   = Math.min(lines.length - 1, targetLine + SLICE_AFTER);
    const slice     = lines.slice(startLine, endLine + 1);

    // Line numbers in display are 1-indexed
    const numbered = slice.map((line, i) => {
      const lineNo = startLine + i + 1;
      return `${String(lineNo).padStart(4, " ")} | ${line}`;
    });

    // VR-2 FIX: Display range uses 1-indexed values consistently
    console.log(
      `[Vault] 📍 Line-hint slice: ${filePath} lines ${startLine + 1}–${endLine + 1} ` +
        `(${slice.length} lines around line ${targetLine1})`
    );

    return (
      `[File slice: ${filePath} lines ${startLine + 1}–${endLine + 1}]\n` +
      `NOTE: Line numbers shown for reference. Do NOT include them in search_string or new_body.\n\n` +
      numbered.join("\n")
    );
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Main retriever
// ─────────────────────────────────────────────

export async function retrieveFromVault(
  vaultId,
  searchQuery,
  messages,
  semanticCache,
  hybridRetriever
) {
  // ── TIER 0: Direct vault lookup ──────────────────────────────────────────
  if (vaultId) {
    const concatenated = fetchVaultTextConcatenated(vaultId);
    if (concatenated && concatenated.length > 0) {
      console.log(
        `[Vault] 📦 Direct chunk retrieval: ${vaultId} (${concatenated.length} chars)`
      );
      statsEmitter.recordCacheHit("ragRetrieval", true);
      statsEmitter.recordVaultRetrieval(vaultId, concatenated.length);
      return `[Vault ${vaultId}]\n\n${concatenated}`;
    }

    const rawVault = fetchFromVault(vaultId);
    if (rawVault && rawVault.length > 0) {
      console.log(
        `[Vault] 📦 Direct raw retrieval: ${vaultId} (${rawVault.length} chars)`
      );
      statsEmitter.recordCacheHit("ragRetrieval", true);
      statsEmitter.recordVaultRetrieval(vaultId, rawVault.length);
      return `[Vault ${vaultId}]\n\n${rawVault}`;
    }

    console.warn(`[Vault] ⚠️  Vault ${vaultId} not found in DB — falling through`);
  }

  // ── TIER 0.5: Line-hint file slice ──────────────────────────────────────
  if (searchQuery) {
    const sliceResult = tryLineHintSlice(searchQuery);
    if (sliceResult) {
      statsEmitter.recordCacheHit("ragRetrieval", true);
      // VR-3 FIX: Use fallback ID when vaultId is undefined
      statsEmitter.recordVaultRetrieval(
        vaultId ?? "line_hint_slice",
        sliceResult.length
      );
      return sliceResult;
    }
  }

  // ── Build expanded query for semantic search ─────────────────────────────
  let expandedQuery = searchQuery || "";

  if (messages && Array.isArray(messages) && messages.length > 0) {
    const recentContext = messages
      .slice(-3)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter((c) => c.length > 0)
      .join(" ")
      .slice(0, 200);

    if (recentContext && !expandedQuery.includes(recentContext)) {
      expandedQuery = `${searchQuery || ""} ${recentContext}`.trim();
    }
  }

  // ── TIER 1: Hybrid search ────────────────────────────────────────────────
  if (hybridRetriever && expandedQuery) {
    try {
      const queryEmbedding = await getEmbedder().embed(expandedQuery);

      if (queryEmbedding) {
        console.log(
          `[Hybrid RAG] 🔍 Searching: "${expandedQuery.substring(0, 80)}..."`
        );

        const results = hybridRetriever.hybridSearch(
          queryEmbedding,
          5,
          0.5,
          expandedQuery
        );

        if (results && results.length > 0) {
          console.log(`[Hybrid RAG] ✅ Found ${results.length} relevant chunks`);

          const chunkIds = results.map((r) => r.id);
          const chunks   = await fetchChunksByIds(chunkIds);

          if (chunks.length > 0) {
            // VR-8 FIX: Parallelize neighbor fetches instead of sequential awaits.
            // Previously: 5 awaits in series = 5 sequential DB round-trips.
            // Now: Promise.all = 1 parallel round-trip for all neighbors.
            const neighborPromises = chunks.map((chunk) =>
              semanticCache
                ? fetchNeighborChunks(chunk.vaultId, chunk.index, 1, 1)
                : Promise.resolve([])
            );
            const allNeighbors = await Promise.all(neighborPromises);

            const contextPieces = [];

            for (const result of results) {
              const chunkIdx = chunks.findIndex((c) => c.chunkId === result.id);
              if (chunkIdx === -1) continue;

              const chunk     = chunks[chunkIdx];
              const neighbors = allNeighbors[chunkIdx] ?? [];

              console.log(
                `  - ${result.id}: dense=${result.denseScore.toFixed(3)}, ` +
                  `sparse=${result.sparseScore.toFixed(3)}`
              );

              const neighborContext = neighbors
                .filter((n) => n.chunkId !== chunk.chunkId)
                .map((n) => n.text.substring(0, 200))
                .join("\n...\n");

              contextPieces.push(
                `[Chunk ${chunk.index} (score: ${(result.combinedScore * 100).toFixed(0)}%)]\n` +
                  chunk.text +
                  (neighborContext
                    ? `\n\n[Surrounding Context]\n${neighborContext}`
                    : "")
              );
            }

            // VR-7 FIX: Include vault ID header when known so the LLM can
            // associate retrieved content with the vault stub in its history.
            const headerLine = vaultId
              ? `[Vault ${vaultId} — retrieved via semantic search]\n\n`
              : `[Semantic search results]\n\n`;

            const text = contextPieces.join("\n" + "=".repeat(50) + "\n");
            statsEmitter.recordCacheHit("ragRetrieval", true);
            // VR-3 FIX: Fallback ID when vaultId undefined
            statsEmitter.recordVaultRetrieval(
              vaultId ?? "hybrid_search",
              text.length
            );
            return headerLine + text;
          }

          // Fallback: use inline text from results if chunk DB missed
          if (results.some((r) => r.text)) {
            const fallbackPieces = results
              .filter((r) => r.text)
              .map(
                (r, i) =>
                  `[Chunk ${i + 1} (score: ${(r.combinedScore * 100).toFixed(0)}%)]\n${r.text}`
              );
            if (fallbackPieces.length > 0) {
              console.log(
                `[Hybrid RAG] ⚡ Tier 1b: ${fallbackPieces.length} HNSW text snippets`
              );
              const text = fallbackPieces.join("\n" + "=".repeat(50) + "\n");
              statsEmitter.recordCacheHit("ragRetrieval", true);
              statsEmitter.recordVaultRetrieval(
                vaultId ?? "hybrid_search_inline",
                text.length
              );
              return text;
            }
          }
        } else {
          statsEmitter.recordCacheHit("ragRetrieval", false);
        }
      }
    } catch (err) {
      console.warn(`[Hybrid RAG] ⚠️ Search failed: ${err.message}`);
      statsEmitter.recordCacheHit("ragRetrieval", false);
    }
  }

  // ── TIER 2: Lower-threshold hybrid search fallback ───────────────────────
  //
  // VR-6 FIX: Previously used semanticCache.search() at threshold 0.9.
  // semanticCache contains planner intent anchors ("fix the bug", "create
  // a new endpoint"), not vault content — searching it for code retrieval
  // was architecturally wrong and always missed at 0.9 threshold.
  //
  // New: second hybridRetriever pass at lower threshold (0.3) using
  // the original search_query only (not the context-expanded query).
  // This catches content that TIER 1's 0.5 threshold missed.
  if (hybridRetriever && searchQuery) {
    try {
      const queryEmbedding = await getEmbedder().embed(searchQuery);
      if (queryEmbedding) {
        const results = hybridRetriever.hybridSearch(
          queryEmbedding,
          3,
          0.3,   // lower threshold than TIER 1
          searchQuery
        );

        if (results && results.length > 0) {
          const chunkIds = results.map((r) => r.id);
          const chunks   = await fetchChunksByIds(chunkIds);

          if (chunks.length > 0) {
            const pieces = chunks.map(
              (chunk, i) =>
                `[Chunk ${chunk.index} (score: ${(results[i]?.combinedScore * 100 || 0).toFixed(0)}%)]\n` +
                chunk.text
            );

            const headerLine = vaultId
              ? `[Vault ${vaultId} — low-threshold fallback]\n\n`
              : `[Low-threshold search results]\n\n`;

            const text = pieces.join("\n" + "=".repeat(50) + "\n");
            console.log(
              `[Hybrid RAG] 📦 Tier 2 low-threshold hit: ${chunks.length} chunk(s)`
            );
            statsEmitter.recordCacheHit("ragRetrieval", true);
            statsEmitter.recordVaultRetrieval(
              vaultId ?? "hybrid_search_t2",
              text.length
            );
            return headerLine + text;
          }
        }
      }
    } catch {
      /* fall through to TIER 3 */
    }
  }

  // ── TIER 3: Cache fallback ───────────────────────────────────────────────
  if (vaultId) {
    const cachedResponse = await fetchFromCache(vaultId);
    if (cachedResponse) {
      console.log(`[Hybrid RAG] 📦 Cache fallback: ${vaultId}`);
      statsEmitter.recordCacheHit("ragRetrieval", true);
      statsEmitter.recordVaultRetrieval(vaultId, cachedResponse.length);
      return cachedResponse;
    }
  }

  console.log(`[Hybrid RAG] ❌ Vault ${vaultId ?? "none"} not found`);
  statsEmitter.recordCacheHit("ragRetrieval", false);
  return null;
}