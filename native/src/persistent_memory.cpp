#include "persistent_memory.h"
#include <stdexcept>
#include <cstring>
#include <cmath>
#include <algorithm>
#include <sstream>
#include <chrono>

// SQLite is already on Windows/Mac/Linux — link with -lsqlite3
// or vendor sqlite3.c (single-file amalgamation)

namespace contextforge {

// ─────────────────────────────────────────────
// Constructor — open SQLite, init schema, load HNSW
// ─────────────────────────────────────────────

PersistentMemoryStore::PersistentMemoryStore(
  const std::string& db_path,
  int                vector_dim
) : db_(nullptr), dim_(vector_dim), db_path_(db_path),
    hnsw_(nullptr), space_(nullptr) {

  // Open SQLite
  int rc = sqlite3_open(db_path.c_str(), &db_);
  if (rc != SQLITE_OK) {
    throw std::runtime_error(
      std::string("[PersistentMemory] Cannot open DB: ") + sqlite3_errmsg(db_)
    );
  }

  // Enable WAL for concurrent read performance
  sqlite3_exec(db_, "PRAGMA journal_mode=WAL;", nullptr, nullptr, nullptr);
  sqlite3_exec(db_, "PRAGMA synchronous=NORMAL;", nullptr, nullptr, nullptr);

  initSchema();

  // Build HNSW index in memory (max 100k memories, M=16, ef=200)
  space_ = new hnswlib::InnerProductSpace(dim_);
  hnsw_  = new hnswlib::HierarchicalNSW<float>(space_, 100000, 16, 200);

  // Reload existing memories from SQLite into HNSW
  loadAllIntoHNSW();
}

PersistentMemoryStore::~PersistentMemoryStore() {
  if (db_)    sqlite3_close(db_);
  if (hnsw_)  delete hnsw_;
  if (space_) delete space_;
}

// ─────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────

void PersistentMemoryStore::initSchema() {
  const char* sql = R"SQL(
    CREATE TABLE IF NOT EXISTS memories (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      workspace    TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL,
      importance   REAL NOT NULL DEFAULT 0.5,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      metadata     TEXT NOT NULL DEFAULT '{}',
      embedding    BLOB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mem_user
      ON memories(user_id, workspace, created_at DESC);
  )SQL";

  char* err = nullptr;
  sqlite3_exec(db_, sql, nullptr, nullptr, &err);
  if (err) {
    std::string msg = err;
    sqlite3_free(err);
    throw std::runtime_error("[PersistentMemory] Schema error: " + msg);
  }
}

// ─────────────────────────────────────────────
// Load all stored embeddings into HNSW on startup
// ─────────────────────────────────────────────

void PersistentMemoryStore::loadAllIntoHNSW() {
  const char* sql =
    "SELECT id, embedding FROM memories ORDER BY created_at ASC";

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr);

  int loaded = 0;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    std::string id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));

    // Read blob
    const void* blob = sqlite3_column_blob(stmt, 1);
    int          nbytes = sqlite3_column_bytes(stmt, 1);
    int          n = nbytes / sizeof(float);

    if (n != dim_) continue; // Dimension mismatch — skip corrupt row

    std::vector<float> emb(n);
    std::memcpy(emb.data(), blob, nbytes);

    addToHNSW(id, emb);
    loaded++;
  }

  sqlite3_finalize(stmt);

  if (loaded > 0) {
    // Log to stderr (doesn't interfere with Node stdout)
    fprintf(stderr,
      "[PersistentMemory] Loaded %d memories from %s\n",
      loaded, db_path_.c_str()
    );
  }
}

// ─────────────────────────────────────────────
// HNSW helpers
// ─────────────────────────────────────────────

std::vector<float> PersistentMemoryStore::l2Normalize(
  const std::vector<float>& v
) {
  float norm = 0.0f;
  for (float x : v) norm += x * x;
  norm = std::sqrt(norm);

  if (norm < 1e-9f) return v; // Zero vector — return as-is

  std::vector<float> out(v.size());
  for (size_t i = 0; i < v.size(); i++) out[i] = v[i] / norm;
  return out;
}

void PersistentMemoryStore::addToHNSW(
  const std::string&         id,
  const std::vector<float>&  embedding
) {
  auto normalized = l2Normalize(embedding);
  hnswlib::labeltype label = next_label_++;

  hnsw_->addPoint(normalized.data(), label);

  label_to_id_[label] = id;
  id_to_label_[id]    = label;
}

void PersistentMemoryStore::removeFromHNSW(const std::string& id) {
  auto it = id_to_label_.find(id);
  if (it == id_to_label_.end()) return;

  hnswlib::labeltype label = it->second;
  hnsw_->markDelete(label);

  label_to_id_.erase(label);
  id_to_label_.erase(it);
}

// ─────────────────────────────────────────────
// Save
// ─────────────────────────────────────────────

std::string PersistentMemoryStore::save(const MemoryEntry& entry) {
  // Insert into SQLite
  const char* sql = R"SQL(
    INSERT INTO memories
      (id, user_id, workspace, content, importance,
       created_at, updated_at, metadata, embedding)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      content    = excluded.content,
      importance = excluded.importance,
      updated_at = excluded.updated_at,
      metadata   = excluded.metadata,
      embedding  = excluded.embedding
  )SQL";

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr);

  sqlite3_bind_text(stmt, 1, entry.id.c_str(), -1, SQLITE_STATIC);
  sqlite3_bind_text(stmt, 2, entry.user_id.c_str(), -1, SQLITE_STATIC);
  sqlite3_bind_text(stmt, 3, entry.workspace.c_str(), -1, SQLITE_STATIC);
  sqlite3_bind_text(stmt, 4, entry.content.c_str(), -1, SQLITE_STATIC);
  sqlite3_bind_double(stmt, 5, entry.importance);
  sqlite3_bind_int64(stmt, 6, entry.created_at);
  sqlite3_bind_int64(stmt, 7, entry.updated_at);
  sqlite3_bind_text(stmt, 8, entry.metadata_json.c_str(), -1, SQLITE_STATIC);

  // Embedding as blob
  size_t nbytes = entry.embedding.size() * sizeof(float);
  sqlite3_bind_blob(stmt, 9, entry.embedding.data(), (int)nbytes, SQLITE_STATIC);

  sqlite3_step(stmt);
  sqlite3_finalize(stmt);

  // Add to HNSW (remove first if updating)
  if (id_to_label_.count(entry.id)) {
    removeFromHNSW(entry.id);
  }
  addToHNSW(entry.id, entry.embedding);

  return entry.id;
}

// ─────────────────────────────────────────────
// Vector Search
// ─────────────────────────────────────────────

std::vector<MemorySearchResult> PersistentMemoryStore::search(
  const std::vector<float>& query_embedding,
  const std::string&        user_id,
  const std::string&        workspace,
  int                       top_k,
  float                     min_similarity
) {
  if (id_to_label_.empty()) return {};

  auto normalized = l2Normalize(query_embedding);
  int  k_search   = std::min(top_k * 3, (int)id_to_label_.size());

  // HNSW search
  auto raw = hnsw_->searchKnn(normalized.data(), k_search);

  // Collect candidate IDs with scores
  std::vector<std::pair<std::string, float>> candidates;
  while (!raw.empty()) {
    auto [dist, label] = raw.top();
    raw.pop();

    float similarity = 1.0f - dist; // InnerProductSpace: dist = 1 - cosine
    if (similarity < min_similarity) continue;

    auto it = label_to_id_.find(label);
    if (it == label_to_id_.end()) continue;

    candidates.push_back({it->second, similarity});
  }

  if (candidates.empty()) return {};

  // Sort descending by score
  std::sort(candidates.begin(), candidates.end(),
    [](const auto& a, const auto& b) { return a.second > b.second; }
  );

  // Fetch content + filter by user_id + workspace from SQLite
  std::vector<MemorySearchResult> results;
  results.reserve(top_k);

  for (const auto& [id, score] : candidates) {
    if ((int)results.size() >= top_k) break;

    const char* sql = R"SQL(
      SELECT id, content, created_at, metadata
      FROM memories
      WHERE id = ? AND user_id = ? AND workspace = ?
    )SQL";

    sqlite3_stmt* stmt = nullptr;
    sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr);
    sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 2, user_id.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 3, workspace.c_str(), -1, SQLITE_STATIC);

    if (sqlite3_step(stmt) == SQLITE_ROW) {
      MemorySearchResult r;
      r.id           = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
      r.content      = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
      r.created_at   = sqlite3_column_int64(stmt, 2);
      r.metadata_json = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3));
      r.score        = score;
      results.push_back(std::move(r));
    }

    sqlite3_finalize(stmt);
  }

  return results;
}

// ─────────────────────────────────────────────
// List recent
// ─────────────────────────────────────────────

std::vector<MemorySearchResult> PersistentMemoryStore::list(
  const std::string& user_id,
  const std::string& workspace,
  int                limit
) {
  const char* sql = R"SQL(
    SELECT id, content, created_at, metadata
    FROM memories
    WHERE user_id = ? AND workspace = ?
    ORDER BY created_at DESC
    LIMIT ?
  )SQL";

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, user_id.c_str(), -1, SQLITE_STATIC);
  sqlite3_bind_text(stmt, 2, workspace.c_str(), -1, SQLITE_STATIC);
  sqlite3_bind_int(stmt, 3, limit);

  std::vector<MemorySearchResult> results;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    MemorySearchResult r;
    r.id           = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    r.content      = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    r.created_at   = sqlite3_column_int64(stmt, 2);
    r.metadata_json = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3));
    r.score        = 1.0f;
    results.push_back(std::move(r));
  }

  sqlite3_finalize(stmt);
  return results;
}

// ─────────────────────────────────────────────
// Update
// ─────────────────────────────────────────────

bool PersistentMemoryStore::update(
  const std::string&        id,
  const std::string&        new_content,
  const std::vector<float>& new_embedding
) {
  int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()
  ).count();

  const char* sql = R"SQL(
    UPDATE memories
    SET content = ?, embedding = ?, updated_at = ?
    WHERE id = ?
  )SQL";

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, new_content.c_str(), -1, SQLITE_STATIC);

  size_t nbytes = new_embedding.size() * sizeof(float);
  sqlite3_bind_blob(stmt, 2, new_embedding.data(), (int)nbytes, SQLITE_STATIC);
  sqlite3_bind_int64(stmt, 3, now);
  sqlite3_bind_text(stmt, 4, id.c_str(), -1, SQLITE_STATIC);

  sqlite3_step(stmt);
  int changes = sqlite3_changes(db_);
  sqlite3_finalize(stmt);

  if (changes > 0) {
    // Update HNSW
    removeFromHNSW(id);
    addToHNSW(id, new_embedding);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────

bool PersistentMemoryStore::remove(const std::string& id) {
  const char* sql = "DELETE FROM memories WHERE id = ?";
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_STATIC);
  sqlite3_step(stmt);
  int changes = sqlite3_changes(db_);
  sqlite3_finalize(stmt);

  if (changes > 0) {
    removeFromHNSW(id);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────
// Count
// ─────────────────────────────────────────────

int PersistentMemoryStore::count(
  const std::string& user_id,
  const std::string& workspace
) {
  const char* sql =
    "SELECT COUNT(*) FROM memories WHERE user_id = ? AND workspace = ?";

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, user_id.c_str(), -1, SQLITE_STATIC);
  sqlite3_bind_text(stmt, 2, workspace.c_str(), -1, SQLITE_STATIC);

  int n = 0;
  if (sqlite3_step(stmt) == SQLITE_ROW) {
    n = sqlite3_column_int(stmt, 0);
  }
  sqlite3_finalize(stmt);
  return n;
}

// ─────────────────────────────────────────────
// N-API WRAPPER
// ─────────────────────────────────────────────

Napi::Object PersistentMemoryStoreNAPI::Init(
  Napi::Env env, Napi::Object exports
) {
  Napi::Function func = DefineClass(env, "PersistentMemoryStore", {
    InstanceMethod("save",       &PersistentMemoryStoreNAPI::Save),
    InstanceMethod("search",     &PersistentMemoryStoreNAPI::Search),
    InstanceMethod("textSearch", &PersistentMemoryStoreNAPI::TextSearch),
    InstanceMethod("list",       &PersistentMemoryStoreNAPI::List),
    InstanceMethod("update",     &PersistentMemoryStoreNAPI::Update),
    InstanceMethod("remove",     &PersistentMemoryStoreNAPI::Remove),
    InstanceMethod("count",      &PersistentMemoryStoreNAPI::Count),
  });

  Napi::FunctionReference* ctor = new Napi::FunctionReference();
  *ctor = Napi::Persistent(func);
  env.SetInstanceData(ctor);
  exports.Set("PersistentMemoryStore", func);
  return exports;
}

PersistentMemoryStoreNAPI::PersistentMemoryStoreNAPI(
  const Napi::CallbackInfo& info
) : Napi::ObjectWrap<PersistentMemoryStoreNAPI>(info) {

  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "PersistentMemoryStore(dbPath: string, dim?: number)")
      .ThrowAsJavaScriptException();
    return;
  }

  std::string db_path = info[0].As<Napi::String>().Utf8Value();
  int dim = (info.Length() > 1 && info[1].IsNumber())
    ? info[1].As<Napi::Number>().Int32Value()
    : 50; // GloVe-50d default

  try {
    store_ = std::make_unique<PersistentMemoryStore>(db_path, dim);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
}

// ─────────────────────────────────────────────
// JS: save({ id, userId, workspace, content, importance, createdAt, embedding[] })
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::Save(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "save(entry: object)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object obj = info[0].As<Napi::Object>();

  MemoryEntry entry;
  entry.id           = obj.Get("id").As<Napi::String>().Utf8Value();
  entry.user_id      = obj.Get("userId").As<Napi::String>().Utf8Value();
  entry.workspace    = obj.Has("workspace")
    ? obj.Get("workspace").As<Napi::String>().Utf8Value() : "";
  entry.content      = obj.Get("content").As<Napi::String>().Utf8Value();
  entry.importance   = obj.Has("importance")
    ? (float)obj.Get("importance").As<Napi::Number>().DoubleValue() : 0.5f;
  entry.created_at   = obj.Has("createdAt")
    ? obj.Get("createdAt").As<Napi::Number>().Int64Value()
    : std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
  entry.updated_at   = entry.created_at;
  entry.metadata_json = obj.Has("metadata")
    ? obj.Get("metadata").As<Napi::String>().Utf8Value() : "{}";

  // Embedding as Float32Array
  if (!obj.Has("embedding") || !obj.Get("embedding").IsTypedArray()) {
    Napi::TypeError::New(env, "entry.embedding must be Float32Array")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Float32Array emb = obj.Get("embedding").As<Napi::Float32Array>();
  entry.embedding.assign(emb.Data(), emb.Data() + emb.ElementLength());

  try {
    std::string saved_id = store_->save(entry);
    return Napi::String::New(env, saved_id);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

// ─────────────────────────────────────────────
// JS: search({ embedding, userId, workspace, topK, minSimilarity })
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::Search(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "search(opts: object)").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object opts = info[0].As<Napi::Object>();

  Napi::Float32Array emb = opts.Get("embedding").As<Napi::Float32Array>();
  std::vector<float> query_emb(emb.Data(), emb.Data() + emb.ElementLength());

  std::string user_id   = opts.Get("userId").As<Napi::String>().Utf8Value();
  std::string workspace = opts.Has("workspace")
    ? opts.Get("workspace").As<Napi::String>().Utf8Value() : "";
  int   top_k     = opts.Has("topK")
    ? opts.Get("topK").As<Napi::Number>().Int32Value() : 10;
  float min_sim   = opts.Has("minSimilarity")
    ? (float)opts.Get("minSimilarity").As<Napi::Number>().DoubleValue() : 0.3f;

  auto results = store_->search(query_emb, user_id, workspace, top_k, min_sim);

  Napi::Array arr = Napi::Array::New(env, results.size());
  for (size_t i = 0; i < results.size(); i++) {
    Napi::Object r = Napi::Object::New(env);
    r.Set("id",        Napi::String::New(env, results[i].id));
    r.Set("content",   Napi::String::New(env, results[i].content));
    r.Set("score",     Napi::Number::New(env, results[i].score));
    r.Set("createdAt", Napi::Number::New(env, (double)results[i].created_at));
    r.Set("metadata",  Napi::String::New(env, results[i].metadata_json));
    arr.Set(i, r);
  }
  return arr;
}

// ─────────────────────────────────────────────
// JS: list({ userId, workspace, limit })
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::List(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    return Napi::Array::New(env, 0);
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  std::string user_id   = opts.Get("userId").As<Napi::String>().Utf8Value();
  std::string workspace = opts.Has("workspace")
    ? opts.Get("workspace").As<Napi::String>().Utf8Value() : "";
  int limit = opts.Has("limit")
    ? opts.Get("limit").As<Napi::Number>().Int32Value() : 10;

  auto results = store_->list(user_id, workspace, limit);

  Napi::Array arr = Napi::Array::New(env, results.size());
  for (size_t i = 0; i < results.size(); i++) {
    Napi::Object r = Napi::Object::New(env);
    r.Set("id",        Napi::String::New(env, results[i].id));
    r.Set("content",   Napi::String::New(env, results[i].content));
    r.Set("createdAt", Napi::Number::New(env, (double)results[i].created_at));
    r.Set("metadata",  Napi::String::New(env, results[i].metadata_json));
    arr.Set(i, r);
  }
  return arr;
}

// ─────────────────────────────────────────────
// JS: update({ id, content, embedding })
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::Update(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    return Napi::Boolean::New(env, false);
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  std::string id      = opts.Get("id").As<Napi::String>().Utf8Value();
  std::string content = opts.Get("content").As<Napi::String>().Utf8Value();

  Napi::Float32Array emb = opts.Get("embedding").As<Napi::Float32Array>();
  std::vector<float> new_emb(emb.Data(), emb.Data() + emb.ElementLength());

  bool ok = store_->update(id, content, new_emb);
  return Napi::Boolean::New(env, ok);
}

// ─────────────────────────────────────────────
// JS: remove(id: string)
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::Remove(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    return Napi::Boolean::New(env, false);
  }
  std::string id = info[0].As<Napi::String>().Utf8Value();
  return Napi::Boolean::New(env, store_->remove(id));
}

// ─────────────────────────────────────────────
// JS: count({ userId, workspace })
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::Count(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    return Napi::Number::New(env, 0);
  }
  Napi::Object opts = info[0].As<Napi::Object>();
  std::string user_id   = opts.Get("userId").As<Napi::String>().Utf8Value();
  std::string workspace = opts.Has("workspace")
    ? opts.Get("workspace").As<Napi::String>().Utf8Value() : "";

  return Napi::Number::New(env, store_->count(user_id, workspace));
}

// TextSearch stub — delegates to BM25 in HybridRetriever from JS side
Napi::Value PersistentMemoryStoreNAPI::TextSearch(
  const Napi::CallbackInfo& info
) {
  // Text search is handled in JS via hybridRetriever.sparseSearch
  // This stub exists for API completeness
  return Napi::Array::New(info.Env(), 0);
}

} // namespace contextforge