// src/vaultRetriever.js
import { getEmbedder } from "./memory/embedder.js";
import {
  fetchFromCache,
  fetchChunksByIds,
  fetchVaultTextConcatenated,
  fetchNeighborChunks,
  fetchFromVault,
} from "./logging/cacheDb.js";
import { statsEmitter } from "./proxy/statsEmitter.js";

export async function retrieveFromVault(
  vaultId,
  searchQuery,
  messages,
  semanticCache,
  hybridRetriever,
) {
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

  // ── TIER 1: HYBRID SEARCH ──
  if (hybridRetriever && expandedQuery) {
    try {
      const queryEmbedding = await getEmbedder().embed(expandedQuery);

      if (queryEmbedding) {
        console.log(
          `[Hybrid RAG] 🔍 Searching: "${expandedQuery.substring(0, 80)}..."`,
        );

        const results = hybridRetriever.hybridSearch(
          queryEmbedding,
          5,
          0.5,
          expandedQuery,
        );

        if (results && results.length > 0) {
          console.log(
            `[Hybrid RAG] ✅ Found ${results.length} relevant chunks`,
          );

          const chunkIds = results.map((r) => r.id);
          const chunks = await fetchChunksByIds(chunkIds);

          if (chunks.length > 0) {
            const contextPieces = [];

            for (const result of results) {
              const chunk = chunks.find((c) => c.chunkId === result.id);

              if (chunk) {
                console.log(
                  `  - ${result.id}: dense=${result.denseScore.toFixed(3)}, sparse=${result.sparseScore.toFixed(3)}`,
                );

                let neighborContext = "";
                if (semanticCache) {
                  const neighbors = await fetchNeighborChunks(
                    chunk.vaultId,
                    chunk.index,
                    1,
                    1,
                  );
                  neighborContext = neighbors
                    .filter((n) => n.chunkId !== chunk.chunkId)
                    .map((n) => n.text.substring(0, 200))
                    .join("\n...\n");
                }

                contextPieces.push(
                  `[Chunk ${chunk.index} (score: ${(result.combinedScore * 100).toFixed(0)}%)]\n` +
                    `${chunk.text}\n` +
                    (neighborContext
                      ? `\n[Surrounding Context]\n${neighborContext}`
                      : ""),
                );
              }
            }

            const text = contextPieces.join("\n" + "=".repeat(50) + "\n");
            // ── Hook: Tier 1 hit ──
            statsEmitter.recordCacheHit("ragRetrieval", true);
            statsEmitter.recordVaultRetrieval(vaultId, text.length);
            return text;
          }

          // ── Tier 1b: HNSW hit but DB chunk lookup missed ──
          if (results.some((r) => r.text)) {
            const fallbackPieces = results
              .filter((r) => r.text)
              .map(
                (r, i) =>
                  `[Chunk ${i + 1} (score: ${(r.combinedScore * 100).toFixed(0)}%)]\n${r.text}`,
              );
            if (fallbackPieces.length > 0) {
              console.log(
                `[Hybrid RAG] ⚡ Tier 1b: returning ${fallbackPieces.length} HNSW text snippets (DB chunk miss)`,
              );
              const text = fallbackPieces.join("\n" + "=".repeat(50) + "\n");
              // ── Hook: Tier 1b partial hit ──
              statsEmitter.recordCacheHit("ragRetrieval", true);
              statsEmitter.recordVaultRetrieval(vaultId, text.length);
              return text;
            }
          }

          console.warn(
            `[Hybrid RAG] ⚠️ HNSW found ${results.length} chunks but DB+text lookup both missed — skipping to Tier 2`,
          );
        } else {
          // ── Hook: Tier 1 miss — no results from hybrid search ──
          statsEmitter.recordCacheHit("ragRetrieval", false);
        }
      }
    } catch (err) {
      console.warn(`[Hybrid RAG] ⚠️ Search failed: ${err.message}`);
      statsEmitter.recordCacheHit("ragRetrieval", false);
    }
  }

  // ── TIER 2: DIRECT HNSW SEARCH ──
  if (semanticCache && searchQuery) {
    try {
      const queryEmbedding = await getEmbedder().embed(searchQuery);
      if (queryEmbedding) {
        const directHit = semanticCache.search(queryEmbedding, 0.9);
        if (directHit) {
          console.log(`[Hybrid RAG] 📦 Direct HNSW hit: ${directHit}`);
          const cachedText = await fetchFromCache(directHit);
          if (cachedText) {
            // ── Hook: Tier 2 hit ──
            statsEmitter.recordCacheHit("ragRetrieval", true);
            statsEmitter.recordVaultRetrieval(vaultId, cachedText.length);
            return cachedText;
          }
        }
      }
    } catch (e) {
      // Fall through
    }
  }

  // ── TIER 3: FULL VAULT RETRIEVAL ──
  if (vaultId) {
    try {
      const concatenated = await fetchVaultTextConcatenated(vaultId);
      if (concatenated) {
        console.log(`[Hybrid RAG] 📦 Retrieved full vault: ${vaultId}`);
        const text = `[Vault ${vaultId}]\n\n${concatenated}`;
        // ── Hook: Tier 3 full vault ──
        statsEmitter.recordCacheHit("ragRetrieval", false); // not a cache hit — full fallback
        statsEmitter.recordVaultRetrieval(vaultId, text.length);
        return text;
      }
    } catch (e) {
      // Fall through
    }

    const rawVault = await fetchFromVault(vaultId);
    if (rawVault) {
      console.log(`[Hybrid RAG] 📦 Raw vault: ${vaultId}`);
      const text = `[Vault ${vaultId}]\n\n${rawVault}`;
      // ── Hook: Tier 3 raw vault ──
      statsEmitter.recordCacheHit("ragRetrieval", false);
      statsEmitter.recordVaultRetrieval(vaultId, text.length);
      return text;
    }

    const cachedResponse = await fetchFromCache(vaultId);
    if (cachedResponse) {
      console.log(`[Hybrid RAG] 📦 Cache: ${vaultId}`);
      // ── Hook: Tier 3 cache fallback ──
      statsEmitter.recordCacheHit("ragRetrieval", true);
      statsEmitter.recordVaultRetrieval(vaultId, cachedResponse.length);
      return cachedResponse;
    }
  }

  console.log(`[Hybrid RAG] ❌ Vault ${vaultId} not found`);
  // ── Hook: total miss ──
  statsEmitter.recordCacheHit("ragRetrieval", false);
  return null;
}
