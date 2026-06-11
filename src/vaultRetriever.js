// src/vaultRetriever.js
import { getEmbedder } from "./memory/embedder.js";
import {
  fetchFromCache,
  fetchChunksByIds,
  fetchVaultTextConcatenated,
  fetchNeighborChunks,
  fetchFromVault,
} from "./logging/cacheDb.js";

export async function retrieveFromVault(
  vaultId,
  searchQuery,
  messages,
  semanticCache,
  hybridRetriever,
) {
  // ==========================================
  // QUERY EXPANSION: Extract context from recent messages
  // ==========================================
  let expandedQuery = searchQuery || "";

  if (messages && Array.isArray(messages) && messages.length > 0) {
    // Extract last 3 user/assistant messages for context
    const recentContext = messages
      .slice(-3)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter((c) => c.length > 0)
      .join(" ")
      .slice(0, 200); // Cap at 200 chars

    if (recentContext && !expandedQuery.includes(recentContext)) {
      expandedQuery = `${searchQuery || ""} ${recentContext}`.trim();
    }
  }

  // ==========================================
  // TIER 1: HYBRID SEARCH (Dense + Sparse)
  // ==========================================
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

                // ✅ Use semanticCache for direct HNSW fallback on neighbors
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

            return contextPieces.join("\n" + "=".repeat(50) + "\n");
          }

          // ── Tier 1b: HNSW hit but DB chunk lookup missed ──
          // The index found relevant results but fetchChunksByIds came back empty
          // (chunk IDs in HNSW don't match DB yet — e.g. freshly indexed content).
          // Return the raw text snippets from the HNSW results directly
          // instead of falling through to the full-vault Tier 3 dump.
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
              return fallbackPieces.join("\n" + "=".repeat(50) + "\n");
            }
          }

          // HNSW results have no text at all — log and fall through
          console.warn(
            `[Hybrid RAG] ⚠️ HNSW found ${results.length} chunks but DB+text lookup both missed — skipping to Tier 2`,
          );
        }
      }
    } catch (err) {
      console.warn(`[Hybrid RAG] ⚠️ Search failed: ${err.message}`);
    }
  }

  // ==========================================
  // TIER 2: DIRECT HNSW SEARCH (fallback)
  // ==========================================
  if (semanticCache && searchQuery) {
    try {
      const queryEmbedding = await getEmbedder().embed(searchQuery);
      if (queryEmbedding) {
        const directHit = semanticCache.search(queryEmbedding, 0.9);
        if (directHit) {
          console.log(`[Hybrid RAG] 📦 Direct HNSW hit: ${directHit}`);
          const cachedText = await fetchFromCache(directHit);
          if (cachedText) return cachedText;
        }
      }
    } catch (e) {
      // Fall through
    }
  }

  // ==========================================
  // TIER 3: FULL VAULT RETRIEVAL (no search query)
  // ==========================================
  if (vaultId) {
    try {
      const concatenated = await fetchVaultTextConcatenated(vaultId);
      if (concatenated) {
        console.log(`[Hybrid RAG] 📦 Retrieved full vault: ${vaultId}`);
        return `[Vault ${vaultId}]\n\n${concatenated}`;
      }
    } catch (e) {
      // Fall through
    }

    const rawVault = await fetchFromVault(vaultId);
    if (rawVault) {
      console.log(`[Hybrid RAG] 📦 Raw vault: ${vaultId}`);
      return `[Vault ${vaultId}]\n\n${rawVault}`;
    }

    const cachedResponse = await fetchFromCache(vaultId);
    if (cachedResponse) {
      console.log(`[Hybrid RAG] 📦 Cache: ${vaultId}`);
      return cachedResponse;
    }
  }

  console.log(`[Hybrid RAG] ❌ Vault ${vaultId} not found`);
  return null;
}
