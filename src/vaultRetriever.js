import { getEmbedder } from "./memory/embedder.js";
import fs from "node:fs";
import {
  fetchFromCache,
  fetchChunksByIds,
  fetchVaultTextConcatenated,
  fetchNeighborChunks,
  fetchFromVault,
} from "./logging/cacheDb.js";
import { statsEmitter } from "./proxy/statsEmitter.js";

// ─────────────────────────────────────────────
// Tier 0.5: Line-hint file slice
//
// When find_route returns a line number for an inline handler,
// the LLM can call contextforge_retrieve with:
//   search_query: "line:219 src/server.js"  (or similar)
//
// This tier intercepts that pattern and returns just the 40 lines
// surrounding the target line — enough to build a valid old_string
// for replace_string without reading the entire 600-line server.js.
//
// Pattern matched: "line:N filepath" or "line:N" alone
// Also matches if search_query IS a file path (no line hint needed,
// just return the whole file sliced to reasonable size).
// ─────────────────────────────────────────────

const LINE_HINT_PATTERN = /\bline[:\s]+(\d+)\b/i;
const FILE_PATH_PATTERN = /\b((?:src\/|\.\/)?[\w/\\.\-]+\.\w{1,6})\b/;

const SLICE_BEFORE = 15;  // lines before the target line
const SLICE_AFTER  = 25;  // lines after (more after since that's where the handler body is)

function tryLineHintSlice(searchQuery) {
  if (!searchQuery || typeof searchQuery !== "string") return null;

  const lineMatch = searchQuery.match(LINE_HINT_PATTERN);
  const fileMatch = searchQuery.match(FILE_PATH_PATTERN);

  if (!lineMatch || !fileMatch) return null;

  const targetLine = parseInt(lineMatch[1], 10);
  const filePath   = fileMatch[1].replace(/\\/g, "/");

  // Resolve to absolute path
  const absolutePath = filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)
    ? filePath
    : require("path").join(process.cwd(), filePath);

  try {
    const source = fs.readFileSync(absolutePath, "utf-8")
      .replace(/\r\n/g, "\n");
    const lines  = source.split("\n");

    if (targetLine >= lines.length) return null;

    const startLine = Math.max(0, targetLine - SLICE_BEFORE);
    const endLine   = Math.min(lines.length - 1, targetLine + SLICE_AFTER);

    const slice = lines.slice(startLine, endLine + 1);

    // Add line numbers so the LLM can reference them in old_string
    const numbered = slice.map((line, i) => {
      const lineNo = startLine + i + 1; // 1-based for display
      return `${String(lineNo).padStart(4, " ")} | ${line}`;
    });

    console.log(
      `[Vault] 📍 Line-hint slice: ${filePath} lines ${startLine + 1}–${endLine + 1} ` +
      `(${slice.length} lines around line ${targetLine + 1})`,
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
  hybridRetriever,
) {
  // ── TIER 0: Direct vault lookup ──────────────────────────────────────────
  if (vaultId) {
    const concatenated = fetchVaultTextConcatenated(vaultId);
    if (concatenated && concatenated.length > 0) {
      console.log(`[Vault] 📦 Direct chunk retrieval: ${vaultId} (${concatenated.length} chars)`);
      statsEmitter.recordCacheHit("ragRetrieval", true);
      statsEmitter.recordVaultRetrieval(vaultId, concatenated.length);
      return `[Vault ${vaultId}]\n\n${concatenated}`;
    }

    const rawVault = fetchFromVault(vaultId);
    if (rawVault && rawVault.length > 0) {
      console.log(`[Vault] 📦 Direct raw retrieval: ${vaultId} (${rawVault.length} chars)`);
      statsEmitter.recordCacheHit("ragRetrieval", true);
      statsEmitter.recordVaultRetrieval(vaultId, rawVault.length);
      return `[Vault ${vaultId}]\n\n${rawVault}`;
    }

    console.warn(`[Vault] ⚠️  Vault ${vaultId} not found in DB — falling through`);
  }

  // ── TIER 0.5: Line-hint file slice ──────────────────────────────────────
  // Fires when the LLM passes a search_query like "line:219 src/server.js"
  // which comes from the patch_hint in a find_route response.
  // Returns just the relevant lines — avoids reading the whole file.
  if (searchQuery) {
    const sliceResult = tryLineHintSlice(searchQuery);
    if (sliceResult) {
      statsEmitter.recordCacheHit("ragRetrieval", true);
      statsEmitter.recordVaultRetrieval(vaultId, sliceResult.length);
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
        console.log(`[Hybrid RAG] 🔍 Searching: "${expandedQuery.substring(0, 80)}..."`);

        const results = hybridRetriever.hybridSearch(queryEmbedding, 5, 0.5, expandedQuery);

        if (results && results.length > 0) {
          console.log(`[Hybrid RAG] ✅ Found ${results.length} relevant chunks`);

          const chunkIds = results.map((r) => r.id);
          const chunks   = await fetchChunksByIds(chunkIds);

          if (chunks.length > 0) {
            const contextPieces = [];

            for (const result of results) {
              const chunk = chunks.find((c) => c.chunkId === result.id);
              if (chunk) {
                console.log(
                  `  - ${result.id}: dense=${result.denseScore.toFixed(3)}, ` +
                  `sparse=${result.sparseScore.toFixed(3)}`,
                );

                let neighborContext = "";
                if (semanticCache) {
                  const neighbors = await fetchNeighborChunks(chunk.vaultId, chunk.index, 1, 1);
                  neighborContext = neighbors
                    .filter((n) => n.chunkId !== chunk.chunkId)
                    .map((n) => n.text.substring(0, 200))
                    .join("\n...\n");
                }

                contextPieces.push(
                  `[Chunk ${chunk.index} (score: ${(result.combinedScore * 100).toFixed(0)}%)]\n` +
                  `${chunk.text}\n` +
                  (neighborContext ? `\n[Surrounding Context]\n${neighborContext}` : ""),
                );
              }
            }

            const text = contextPieces.join("\n" + "=".repeat(50) + "\n");
            statsEmitter.recordCacheHit("ragRetrieval", true);
            statsEmitter.recordVaultRetrieval(vaultId, text.length);
            return text;
          }

          if (results.some((r) => r.text)) {
            const fallbackPieces = results
              .filter((r) => r.text)
              .map((r, i) =>
                `[Chunk ${i + 1} (score: ${(r.combinedScore * 100).toFixed(0)}%)]\n${r.text}`,
              );
            if (fallbackPieces.length > 0) {
              console.log(`[Hybrid RAG] ⚡ Tier 1b: ${fallbackPieces.length} HNSW text snippets`);
              const text = fallbackPieces.join("\n" + "=".repeat(50) + "\n");
              statsEmitter.recordCacheHit("ragRetrieval", true);
              statsEmitter.recordVaultRetrieval(vaultId, text.length);
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

  // ── TIER 2: Direct HNSW search ───────────────────────────────────────────
  if (semanticCache && searchQuery) {
    try {
      const queryEmbedding = await getEmbedder().embed(searchQuery);
      if (queryEmbedding) {
        const directHit = semanticCache.search(queryEmbedding, 0.9);
        if (directHit) {
          const cachedText = await fetchFromCache(directHit);
          if (cachedText) {
            console.log(`[Hybrid RAG] 📦 Direct HNSW hit`);
            statsEmitter.recordCacheHit("ragRetrieval", true);
            statsEmitter.recordVaultRetrieval(vaultId, cachedText.length);
            return cachedText;
          }
        }
      }
    } catch { /* fall through */ }
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