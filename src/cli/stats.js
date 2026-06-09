#!/usr/bin/env node
// src/cli/stats.js
// Run: node src/cli/stats.js

import Database from "better-sqlite3";
import path     from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "../../contextforge.db");

let db;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (err) {
  console.error(`\n❌ Cannot open database: ${DB_PATH}`);
  console.error(`   ${err.message}`);
  process.exit(1);
}

// ── Check which tables exist ──
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
  .all()
  .map(r => r.name);

console.log("\n╔══════════════════════════════════════════════════╗");
console.log("║         ContextForge Runtime Stats               ║");
console.log("╚══════════════════════════════════════════════════╝\n");

console.log(`📂 Database: ${DB_PATH}`);
console.log(`📋 Tables found: ${tables.join(", ") || "none"}\n`);

// ── Vault stats ──
if (tables.includes("vault")) {
  try {
    const vaultStats = db.prepare(`
      SELECT 
        COUNT(*)                          AS total_entries,
        SUM(LENGTH(content))              AS total_chars,
        AVG(LENGTH(content))              AS avg_chars,
        MAX(LENGTH(content))              AS max_chars,
        MIN(LENGTH(content))              AS min_chars
      FROM vault
    `).get();

    console.log("🏛️  Vault");
    console.log(`   Entries:       ${vaultStats.total_entries}`);
    console.log(`   Total chars:   ${(vaultStats.total_chars || 0).toLocaleString()}`);
    console.log(`   Avg entry:     ${Math.round(vaultStats.avg_chars || 0).toLocaleString()} chars`);
    console.log(`   Largest entry: ${(vaultStats.max_chars || 0).toLocaleString()} chars`);
    console.log(`   Est. tokens saved: ~${Math.round((vaultStats.total_chars || 0) / 4).toLocaleString()}\n`);
  } catch (e) {
    console.log(`   ⚠️  vault table error: ${e.message}\n`);
  }
}

// ── Vault chunks stats ──
if (tables.includes("vault_chunks")) {
  try {
    const chunkStats = db.prepare(`
      SELECT
        COUNT(*)              AS total_chunks,
        COUNT(DISTINCT vault_id) AS unique_vaults,
        SUM(token_estimate)   AS total_tokens,
        SUM(CASE WHEN vector IS NOT NULL THEN 1 ELSE 0 END) AS chunks_with_vectors
      FROM vault_chunks
    `).get();

    console.log("🧩  Vault Chunks (RAG Index)");
    console.log(`   Total chunks:    ${chunkStats.total_chunks}`);
    console.log(`   Unique vaults:   ${chunkStats.unique_vaults}`);
    console.log(`   Total tokens:    ${(chunkStats.total_tokens || 0).toLocaleString()}`);
    console.log(`   With embeddings: ${chunkStats.chunks_with_vectors} / ${chunkStats.total_chunks}`);
    const pct = chunkStats.total_chunks > 0
      ? ((chunkStats.chunks_with_vectors / chunkStats.total_chunks) * 100).toFixed(1)
      : 0;
    console.log(`   Embedding coverage: ${pct}%\n`);
  } catch (e) {
    console.log(`   ⚠️  vault_chunks error: ${e.message}\n`);
  }
}

// ── Memory store stats ──
if (tables.includes("memories")) {
  try {
    const memStats = db.prepare(`
      SELECT
        COUNT(*)                    AS total_memories,
        COUNT(DISTINCT user_id)     AS unique_users,
        COUNT(DISTINCT workspace)   AS unique_workspaces,
        AVG(importance)             AS avg_importance
      FROM memories
    `).get();

    console.log("🧠  Memory Store");
    console.log(`   Total memories:  ${memStats.total_memories}`);
    console.log(`   Unique users:    ${memStats.unique_users}`);
    console.log(`   Workspaces:      ${memStats.unique_workspaces}`);
    console.log(`   Avg importance:  ${(memStats.avg_importance || 0).toFixed(2)}\n`);
  } catch (e) {
    console.log(`   ⚠️  memories table error: ${e.message}\n`);
  }
}

// ── Savings tracker ──
if (tables.includes("savings")) {
  try {
    const savings = db.prepare(`
      SELECT
        COUNT(*)          AS total_requests,
        SUM(tokens_saved) AS total_saved,
        SUM(input_tokens) AS total_input,
        AVG(tokens_saved) AS avg_saved,
        MAX(tokens_saved) AS max_saved
      FROM savings
    `).get();

    const pct = savings.total_input > 0
      ? ((savings.total_saved / (savings.total_saved + savings.total_input)) * 100).toFixed(1)
      : 0;

    console.log("💰  Token Savings");
    console.log(`   Requests processed: ${savings.total_requests}`);
    console.log(`   Total tokens saved: ${(savings.total_saved || 0).toLocaleString()}`);
    console.log(`   Avg saved/request:  ${Math.round(savings.avg_saved || 0).toLocaleString()}`);
    console.log(`   Best single save:   ${(savings.max_saved || 0).toLocaleString()}`);
    console.log(`   Overall compression: ${pct}%\n`);

    // Per-model breakdown
    const byModel = db.prepare(`
      SELECT model, COUNT(*) as reqs, SUM(tokens_saved) as saved
      FROM savings
      GROUP BY model
      ORDER BY saved DESC
    `).all();

    if (byModel.length > 0) {
      console.log("   By model:");
      for (const row of byModel) {
        console.log(`     ${row.model}: ${row.reqs} reqs, ${row.saved.toLocaleString()} tokens saved`);
      }
      console.log("");
    }
  } catch (e) {
    console.log(`   ⚠️  savings table error: ${e.message}\n`);
  }
}

// ── Cache stats ──
if (tables.includes("cache")) {
  try {
    const cacheStats = db.prepare(`
      SELECT COUNT(*) AS entries FROM cache
    `).get();
    console.log("⚡  Cache");
    console.log(`   Entries: ${cacheStats.entries}\n`);
  } catch (e) {}
}

// ── Raw table dump for unknown tables ──
const knownTables = new Set([
  "vault", "vault_chunks", "memories", "savings", "cache"
]);
const unknownTables = tables.filter(t => !knownTables.has(t));
if (unknownTables.length > 0) {
  console.log(`📦  Other tables: ${unknownTables.join(", ")}`);
  for (const t of unknownTables) {
    try {
      const count = db.prepare(`SELECT COUNT(*) as n FROM "${t}"`).get();
      console.log(`   ${t}: ${count.n} rows`);
    } catch (_) {}
  }
  console.log("");
}

db.close();