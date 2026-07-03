// src/workers/embeddingWorker.js
//
// Fixes applied (this pass — pipeline sync audit):
//   EW-1 (critical): DB path hardcoded ../data/contextforge.db while the
//        main thread (cacheDb.js CD-1) resolves CF_DATA_DIR first. Under
//        the CLI daemon (which sets CF_DATA_DIR to the per-workspace dir)
//        the worker wrote chunks into a DIFFERENT database file than the
//        one vaultRetriever reads — every hybrid retrieval of worker-
//        indexed content silently missed. Now uses the identical
//        resolution rule as cacheDb.
//   EW-2: vault_chunks CREATE was schema-drifted from cacheDb's (missing
//        created_at and the FK to prune_vault). Whichever thread ran first
//        decided the real schema. Worker now uses the identical DDL, and
//        enables foreign_keys like the main thread.
//   EW-3: INSERT OR IGNORE → INSERT OR REPLACE, matching cacheDb CD-4 —
//        re-indexing a vault after content change must update chunks, not
//        silently keep stale ones.
//   EW-4: requestEmbeddings promise leaked forever if the main-thread
//        bridge died mid-request (worker kept a pending entry and the
//        vault was never saved, without vectors OR text). 30s timeout →
//        resolve(null) → chunks saved text-only (BM25 still works).
import { parentPort } from "node:worker_threads";
import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// WORKER-OWNED DATABASE CONNECTION
// WAL mode allows concurrent access with main thread
// EW-1: MUST resolve identically to cacheDb.js (CD-1) or the worker
// writes to a different database than the retriever reads.
// ==========================================
const DATA_DIR = process.env.CF_DATA_DIR || path.join(__dirname, "../data");
mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "contextforge.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON"); // EW-2: match main thread

// EW-2: identical DDL to cacheDb.js — prune_vault first (FK target), then
// vault_chunks. Normally cacheDb created these before the worker spawns;
// this is defensive for cold starts, and MUST NOT drift from the real schema.
db.exec(`
  CREATE TABLE IF NOT EXISTS prune_vault (
    vault_id TEXT PRIMARY KEY,
    dropped_text TEXT,
    content_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS vault_chunks (
    chunk_id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    chunk_text TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    token_estimate INTEGER NOT NULL,
    vector BLOB,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vault_id) REFERENCES prune_vault(vault_id) ON DELETE CASCADE
  )
`);

// EW-3: OR REPLACE matches cacheDb CD-4 — re-indexed vaults update chunks
const insertChunk = db.prepare(`
  INSERT OR REPLACE INTO vault_chunks
  (chunk_id, vault_id, chunk_text, chunk_index, token_estimate, vector)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const saveChunks = db.transaction((vaultId, chunks) => {
  for (const chunk of chunks) {
    const chunkId   = `${vaultId}_chunk_${chunk.index}`;
    const vectorBlob = chunk.vector
      ? Buffer.from(new Float32Array(chunk.vector).buffer)
      : null;
    insertChunk.run(
      chunkId,
      vaultId,
      chunk.text,
      chunk.index,
      chunk.tokenEstimate,
      vectorBlob,
    );
  }
});

// ==========================================
// CONTENT-AWARE CHUNKER (unchanged)
// ==========================================
const MAX_CHUNK_CHARS = 1200;
const MIN_CHUNK_CHARS = 200;
const OVERLAP_LINES   = 3;

function detectContentType(text) {
  const sample = text.slice(0, 2000);
  if (
    /^\[?\d{2}:\d{2}:\d{2}/m.test(sample) ||
    /\b(ERROR|WARN|INFO|DEBUG|FATAL)\b/m.test(sample)
  ) return "logs";
  if (/^\s*[\[{]/.test(text.trimStart())) return "json";
  const firstLine = sample.split("\n")[0] || "";
  const density =
    (firstLine.match(/[{}\[\]":,]/g) || []).length /
    Math.max(firstLine.length, 1);
  if (density > 0.15) return "json";
  if (
    /^(function |class |const |import |export |async function)/m.test(sample)
  ) return "code";
  return "prose";
}

function chunkByLines(text, linesPerChunk, overlapLines = 0) {
  const lines  = text.split("\n").filter((l) => l.trim());
  const chunks = [];
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    const start = Math.max(0, i - overlapLines);
    const slice = lines.slice(start, i + linesPerChunk).join("\n").trim();
    if (slice.length >= MIN_CHUNK_CHARS) chunks.push(slice);
  }
  return chunks;
}

function chunkJson(text) {
  try {
    const parsed = JSON.parse(text);
    const chunks = [];
    if (Array.isArray(parsed)) {
      for (let i = 0; i < parsed.length; i += 10) {
        chunks.push(JSON.stringify(parsed.slice(i, i + 10), null, 2));
      }
    } else {
      let current = {};
      for (const key of Object.keys(parsed)) {
        current[key] = parsed[key];
        if (JSON.stringify(current).length > MAX_CHUNK_CHARS) {
          chunks.push(JSON.stringify(current, null, 2));
          current = {};
        }
      }
      if (Object.keys(current).length > 0)
        chunks.push(JSON.stringify(current, null, 2));
    }
    return chunks.filter((c) => c.length >= MIN_CHUNK_CHARS);
  } catch {
    /* fall through */
  }

  try {
    const lines  = text.split("\n");
    const chunks = [];
    let current  = [];
    let depth    = 0;
    for (const line of lines) {
      current.push(line);
      for (const char of line) {
        if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") depth--;
      }
      if (depth <= 1 && /^\s*},?\s*$/.test(line) && current.length > 0) {
        const chunk = current.join("\n").trim();
        if (chunk.length >= MIN_CHUNK_CHARS) chunks.push(chunk);
        current = [];
      }
      if (current.length >= 60) {
        chunks.push(current.join("\n").trim());
        current = [];
      }
    }
    if (current.length > 0) chunks.push(current.join("\n").trim());
    return chunks.filter((c) => c.length >= MIN_CHUNK_CHARS);
  } catch {
    /* fall through */
  }

  return chunkByLines(text, 50);
}

function chunkText(text) {
  const type = detectContentType(text);
  let chunks;

  try {
    switch (type) {
      case "logs":
        chunks = chunkByLines(text, 20, OVERLAP_LINES);
        break;
      case "json":
        chunks = chunkJson(text);
        break;
      case "code":
        chunks = chunkByLines(text, 25, OVERLAP_LINES);
        break;
      default: {
        const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
        chunks           = [];
        let current      = "";
        for (const para of paragraphs) {
          if (
            (current + para).length > MAX_CHUNK_CHARS &&
            current.length > MIN_CHUNK_CHARS
          ) {
            chunks.push(current.trim());
            current = para;
          } else {
            current += (current ? "\n\n" : "") + para;
          }
        }
        if (current.trim()) chunks.push(current.trim());
        break;
      }
    }
  } catch {
    chunks = chunkByLines(text, 50);
  }

  if (!chunks || chunks.length === 0) {
    chunks = chunkByLines(text, 50);
  }

  return {
    chunks: chunks.filter((c) => c && c.trim().length >= MIN_CHUNK_CHARS),
    type,
  };
}

// ==========================================
// PENDING EMBED REQUESTS
// Maps requestId → { vaultId, chunks, resolve }
// Main thread sends back embeddings keyed by requestId
// ==========================================
const pendingRequests = new Map();
let   requestCounter  = 0;

const EMBED_TIMEOUT_MS = 30_000;

function requestEmbeddings(vaultId, chunks) {
  return new Promise((resolve) => {
    const requestId = `emb_${++requestCounter}`;

    // EW-4: if the main-thread bridge dies (worker error handler removed it,
    // embedder crashed, etc.) this promise previously hung FOREVER — the
    // vault was never saved at all, not even text-only. Timeout → null →
    // caller saves chunks without vectors (BM25/sparse retrieval still works).
    const timer = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        parentPort.postMessage(
          `⚠️  Vault ${vaultId}: embed request timed out after ${EMBED_TIMEOUT_MS / 1000}s — saving text-only`,
        );
        resolve(null);
      }
    }, EMBED_TIMEOUT_MS);
    timer.unref?.();

    pendingRequests.set(requestId, {
      vaultId,
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
    });

    // Ask main thread to embed these chunks
    parentPort.postMessage({
      type:      "embed_request",
      requestId,
      vaultId,
      texts:     chunks,
    });
  });
}

// ==========================================
// MESSAGE LISTENER
// Receives two message shapes:
//   { vaultId, text }              ← index request from main thread
//   { type: "embed_response", ... } ← embeddings back from main thread
// ==========================================
parentPort.on("message", async (data) => {
  if (!data) return;

  // ── Handle embedding response from main thread ──
  if (data.type === "embed_response") {
    const pending = pendingRequests.get(data.requestId);
    if (!pending) return;
    pendingRequests.delete(data.requestId);
    pending.resolve(data.vectors); // float[][] from main thread
    return;
  }

  // ── Handle embed_error from main thread ──
  if (data.type === "embed_error") {
    const pending = pendingRequests.get(data.requestId);
    if (!pending) return;
    pendingRequests.delete(data.requestId);
    pending.resolve(null); // resolve with null — save without vectors
    return;
  }

  // ── Handle index request ──
  if (!data.vaultId || !data.text) return;
  const { vaultId, text } = data;
  if (!text.trim()) return;

  try {
    const startTime = performance.now();

    // 1. Chunk the text
    const { chunks, type } = chunkText(text);
    if (chunks.length === 0) {
      parentPort.postMessage(
        `⚠️  Vault ${vaultId}: no viable chunks produced`,
      );
      return;
    }

    // 2. Request embeddings from main thread (uses the C++ ONNX embedder)
    parentPort.postMessage(`⚙️  Vault ${vaultId}: requesting embeddings for ${chunks.length} chunks...`);
    const vectors = await requestEmbeddings(vaultId, chunks);

    // 3. Format for SQLite
    const vaultChunks = chunks.map((chunkText, i) => ({
      text:          chunkText,
      index:         i,
      tokenEstimate: Math.ceil(chunkText.length / 4),
      vector:        vectors ? vectors[i] : null,
    }));

    // 4. Write to SQLite
    saveChunks(vaultId, vaultChunks);

    const latency = (performance.now() - startTime).toFixed(0);
    parentPort.postMessage(
      `📦 Vault ${vaultId} indexed: ${chunks.length} chunks (${type}) in ${latency}ms`,
    );
  } catch (err) {
    parentPort.postMessage(
      `❌ Worker Error on vault ${vaultId}: ${err.message}`,
    );
  }
});

// Graceful shutdown
process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});