// Initializes the SQLite database, creates tables for request logs and analytics, and exports the db connection

import Database from 'better-sqlite3';
import path from 'path';

// This will create a file named contextforge.db in your src/data
const db = new Database(path.join(__dirname,  "../data/contextforge.db"));

// Initialize the schema
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    model TEXT,
    original_tokens INTEGER,
    compressed_tokens INTEGER,
    savings_usd REAL,
    latency_ms REAL
  )
`);

// Prepare the insert statement (prepared statements are faster and prevent SQL injection)
const insertRequest = db.prepare(`
  INSERT INTO requests (model, original_tokens, compressed_tokens, savings_usd, latency_ms)
  VALUES (?, ?, ?, ?, ?)
`);
