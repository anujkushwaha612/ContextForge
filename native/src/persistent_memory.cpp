#include "persistent_memory.h"
#include <stdexcept>
#include <cstring>
#include <cmath>
#include <algorithm>
#include <sstream>
#include <chrono>

namespace contextforge {

// ─────────────────────────────────────────────
// SQLite RAII statement guard
// PM-1: All prepare calls now checked.
//       stmt released automatically on scope exit.
// ─────────────────────────────────────────────

struct StmtGuard {
    sqlite3_stmt* stmt = nullptr;
    StmtGuard() = default;
    ~StmtGuard() { if (stmt) sqlite3_finalize(stmt); }
    StmtGuard(const StmtGuard&)            = delete;
    StmtGuard& operator=(const StmtGuard&) = delete;
};

// PM-1: Helper that prepares and validates in one call.
// Returns false and logs on failure — caller can early-return.
static bool safePrepare(
    sqlite3*       db,
    const char*    sql,
    sqlite3_stmt** stmt,
    const char*    context)
{
    int rc = sqlite3_prepare_v2(db, sql, -1, stmt, nullptr);
    if (rc != SQLITE_OK || *stmt == nullptr) {
        fprintf(stderr,
            "[PersistentMemory] prepare failed in %s: %s\n",
            context, sqlite3_errmsg(db));
        return false;
    }
    return true;
}

// ─────────────────────────────────────────────
// Constructor
// PM-5: Count existing memories before allocating HNSW
//       so the index is large enough to hold them all.
// ─────────────────────────────────────────────

PersistentMemoryStore::PersistentMemoryStore(
    const std::string& db_path,
    int                vector_dim
) : db_(nullptr), dim_(vector_dim), db_path_(db_path),
    hnsw_(nullptr), space_(nullptr)
{
    int rc = sqlite3_open(db_path.c_str(), &db_);
    if (rc != SQLITE_OK) {
        throw std::runtime_error(
            std::string("[PersistentMemory] Cannot open DB: ") + sqlite3_errmsg(db_)
        );
    }

    sqlite3_exec(db_, "PRAGMA journal_mode=WAL;",       nullptr, nullptr, nullptr);
    sqlite3_exec(db_, "PRAGMA synchronous=NORMAL;",     nullptr, nullptr, nullptr);

    initSchema();

    // PM-5: Count existing rows so HNSW is sized correctly
    size_t existing_count = 0;
    {
        StmtGuard g;
        if (safePrepare(db_, "SELECT COUNT(*) FROM memories", &g.stmt, "count_init")) {
            if (sqlite3_step(g.stmt) == SQLITE_ROW)
                existing_count = (size_t)sqlite3_column_int64(g.stmt, 0);
        }
    }

    // Reserve headroom for future inserts (at least 100k or 2x existing)
    size_t max_elements = std::max((size_t)100000, existing_count * 2 + 10000);

    space_ = new hnswlib::InnerProductSpace(dim_);
    hnsw_  = new hnswlib::HierarchicalNSW<float>(space_, max_elements, 16, 200);

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
// PM-1: prepare return now checked via safePrepare
// ─────────────────────────────────────────────

void PersistentMemoryStore::loadAllIntoHNSW() {
    const char* sql =
        "SELECT id, embedding FROM memories ORDER BY created_at ASC";

    StmtGuard g;
    if (!safePrepare(db_, sql, &g.stmt, "loadAllIntoHNSW"))
        return;

    int loaded = 0;
    while (sqlite3_step(g.stmt) == SQLITE_ROW) {
        std::string id = reinterpret_cast<const char*>(
            sqlite3_column_text(g.stmt, 0));

        const void* blob   = sqlite3_column_blob(g.stmt, 1);
        int         nbytes = sqlite3_column_bytes(g.stmt, 1);
        int         n      = nbytes / (int)sizeof(float);

        if (n != dim_) continue;

        std::vector<float> emb(n);
        std::memcpy(emb.data(), blob, nbytes);

        addToHNSW(id, emb);
        loaded++;
    }

    if (loaded > 0) {
        fprintf(stderr,
            "[PersistentMemory] Loaded %d memories from %s\n",
            loaded, db_path_.c_str());
    }
}

// ─────────────────────────────────────────────
// HNSW helpers
//
// PM-8: Freed labels are recycled via freed_labels_ queue.
//       After many delete+insert cycles, next_label_ would
//       exceed max_elements and HNSW would throw. Recycling
//       reuses deleted slots, keeping the label space bounded.
// ─────────────────────────────────────────────

std::vector<float> PersistentMemoryStore::l2Normalize(
    const std::vector<float>& v
) {
    float norm = 0.0f;
    for (float x : v) norm += x * x;
    norm = std::sqrt(norm);
    if (norm < 1e-9f) return v;

    std::vector<float> out(v.size());
    for (size_t i = 0; i < v.size(); i++) out[i] = v[i] / norm;
    return out;
}

void PersistentMemoryStore::addToHNSW(
    const std::string&        id,
    const std::vector<float>& embedding
) {
    auto normalized = l2Normalize(embedding);

    // PM-8: Reuse freed label if available, otherwise allocate new
    hnswlib::labeltype label;
    if (!freed_labels_.empty()) {
        label = freed_labels_.front();
        freed_labels_.pop();
    } else {
        label = next_label_++;
    }

    hnsw_->addPoint(normalized.data(), label);
    label_to_id_[label] = id;
    id_to_label_[id]    = label;
}

void PersistentMemoryStore::removeFromHNSW(const std::string& id) {
    auto it = id_to_label_.find(id);
    if (it == id_to_label_.end()) return;

    hnswlib::labeltype label = it->second;
    hnsw_->markDelete(label);

    // PM-8: Recycle the label slot for future inserts
    freed_labels_.push(label);

    label_to_id_.erase(label);
    id_to_label_.erase(it);
}

// ─────────────────────────────────────────────
// Save
//
// PM-1: prepare return checked
// PM-2: step return checked — HNSW only updated on confirmed write
// ─────────────────────────────────────────────

std::string PersistentMemoryStore::save(const MemoryEntry& entry) {
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

    StmtGuard g;
    if (!safePrepare(db_, sql, &g.stmt, "save"))
        return "";

    sqlite3_bind_text  (g.stmt, 1, entry.id.c_str(),            -1, SQLITE_STATIC);
    sqlite3_bind_text  (g.stmt, 2, entry.user_id.c_str(),       -1, SQLITE_STATIC);
    sqlite3_bind_text  (g.stmt, 3, entry.workspace.c_str(),     -1, SQLITE_STATIC);
    sqlite3_bind_text  (g.stmt, 4, entry.content.c_str(),       -1, SQLITE_STATIC);
    sqlite3_bind_double(g.stmt, 5, entry.importance);
    sqlite3_bind_int64 (g.stmt, 6, entry.created_at);
    sqlite3_bind_int64 (g.stmt, 7, entry.updated_at);
    sqlite3_bind_text  (g.stmt, 8, entry.metadata_json.c_str(), -1, SQLITE_STATIC);

    size_t nbytes = entry.embedding.size() * sizeof(float);
    sqlite3_bind_blob(g.stmt, 9, entry.embedding.data(), (int)nbytes, SQLITE_STATIC);

    // PM-2: Check step result before updating HNSW
    int rc = sqlite3_step(g.stmt);
    if (rc != SQLITE_DONE) {
        fprintf(stderr,
            "[PersistentMemory] save failed for id=%s: %s\n",
            entry.id.c_str(), sqlite3_errmsg(db_));
        return "";
    }

    // Only update HNSW after confirmed SQLite write
    if (id_to_label_.count(entry.id))
        removeFromHNSW(entry.id);
    addToHNSW(entry.id, entry.embedding);

    return entry.id;
}

// ─────────────────────────────────────────────
// Vector Search
//
// PM-1: prepare return checked
// PM-3: Single batched IN query instead of N individual queries
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

    auto raw = hnsw_->searchKnn(normalized.data(), k_search);

    std::vector<std::pair<std::string, float>> candidates;
    while (!raw.empty()) {
        auto [dist, label] = raw.top();
        raw.pop();

        float similarity = 1.0f - dist;
        if (similarity < min_similarity) continue;

        auto it = label_to_id_.find(label);
        if (it == label_to_id_.end()) continue;

        candidates.push_back({it->second, similarity});
    }

    if (candidates.empty()) return {};

    std::sort(candidates.begin(), candidates.end(),
        [](const auto& a, const auto& b) { return a.second > b.second; });

    // PM-3: Build a single IN query for all candidates.
    // Replaces N individual prepare/step/finalize cycles with one query.
    // Keep only up to top_k candidates for the IN clause.
    size_t fetch_count = std::min((size_t)top_k, candidates.size());

    std::string placeholders;
    for (size_t i = 0; i < fetch_count; i++) {
        if (i > 0) placeholders += ",";
        placeholders += "?";
    }

    std::string sql =
        "SELECT id, content, created_at, metadata FROM memories "
        "WHERE id IN (" + placeholders + ") "
        "AND user_id = ? AND workspace = ?";

    StmtGuard g;
    if (!safePrepare(db_, sql.c_str(), &g.stmt, "search"))
        return {};

    // Bind candidate IDs
    for (size_t i = 0; i < fetch_count; i++) {
        sqlite3_bind_text(g.stmt, (int)(i + 1),
            candidates[i].first.c_str(), -1, SQLITE_STATIC);
    }

    // Bind user_id and workspace after the IN placeholders
    int base = (int)fetch_count + 1;
    sqlite3_bind_text(g.stmt, base,     user_id.c_str(),   -1, SQLITE_STATIC);
    sqlite3_bind_text(g.stmt, base + 1, workspace.c_str(), -1, SQLITE_STATIC);

    // Collect rows into a map for score lookup
    // (SQLite does not guarantee IN clause order)
    std::unordered_map<std::string, MemorySearchResult> row_map;
    while (sqlite3_step(g.stmt) == SQLITE_ROW) {
        MemorySearchResult r;
        r.id            = reinterpret_cast<const char*>(sqlite3_column_text(g.stmt, 0));
        r.content       = reinterpret_cast<const char*>(sqlite3_column_text(g.stmt, 1));
        r.created_at    = sqlite3_column_int64(g.stmt, 2);
        r.metadata_json = reinterpret_cast<const char*>(sqlite3_column_text(g.stmt, 3));
        r.score         = 0.0f; // filled below from candidates
        row_map[r.id]   = std::move(r);
    }

    // Reassemble in score order, attaching HNSW scores
    std::vector<MemorySearchResult> results;
    results.reserve(fetch_count);

    for (size_t i = 0; i < fetch_count && (int)results.size() < top_k; i++) {
        auto it = row_map.find(candidates[i].first);
        if (it == row_map.end()) continue; // filtered by user_id/workspace

        it->second.score = candidates[i].second;
        results.push_back(std::move(it->second));
    }

    return results;
}

// ─────────────────────────────────────────────
// List recent
// PM-1: prepare return checked
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

    StmtGuard g;
    if (!safePrepare(db_, sql, &g.stmt, "list"))
        return {};

    sqlite3_bind_text(g.stmt, 1, user_id.c_str(),   -1, SQLITE_STATIC);
    sqlite3_bind_text(g.stmt, 2, workspace.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_int (g.stmt, 3, limit);

    std::vector<MemorySearchResult> results;
    while (sqlite3_step(g.stmt) == SQLITE_ROW) {
        MemorySearchResult r;
        r.id            = reinterpret_cast<const char*>(sqlite3_column_text(g.stmt, 0));
        r.content       = reinterpret_cast<const char*>(sqlite3_column_text(g.stmt, 1));
        r.created_at    = sqlite3_column_int64(g.stmt, 2);
        r.metadata_json = reinterpret_cast<const char*>(sqlite3_column_text(g.stmt, 3));
        r.score         = 1.0f;
        results.push_back(std::move(r));
    }

    return results;
}

// ─────────────────────────────────────────────
// Update
// PM-1: prepare return checked
// PM-2: step return checked — HNSW only updated on confirmed write
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

    StmtGuard g;
    if (!safePrepare(db_, sql, &g.stmt, "update"))
        return false;

    sqlite3_bind_text(g.stmt, 1, new_content.c_str(), -1, SQLITE_STATIC);

    size_t nbytes = new_embedding.size() * sizeof(float);
    sqlite3_bind_blob (g.stmt, 2, new_embedding.data(), (int)nbytes, SQLITE_STATIC);
    sqlite3_bind_int64(g.stmt, 3, now);
    sqlite3_bind_text (g.stmt, 4, id.c_str(), -1, SQLITE_STATIC);

    // PM-2: Check step result
    int rc      = sqlite3_step(g.stmt);
    int changes = sqlite3_changes(db_);

    if (rc != SQLITE_DONE || changes == 0)
        return false;

    // Only update HNSW after confirmed SQLite write
    removeFromHNSW(id);
    addToHNSW(id, new_embedding);
    return true;
}

// ─────────────────────────────────────────────
// Delete
// PM-1: prepare return checked
// PM-2: step return checked
// ─────────────────────────────────────────────

bool PersistentMemoryStore::remove(const std::string& id) {
    const char* sql = "DELETE FROM memories WHERE id = ?";

    StmtGuard g;
    if (!safePrepare(db_, sql, &g.stmt, "remove"))
        return false;

    sqlite3_bind_text(g.stmt, 1, id.c_str(), -1, SQLITE_STATIC);

    int rc      = sqlite3_step(g.stmt);
    int changes = sqlite3_changes(db_);

    if (rc != SQLITE_DONE || changes == 0)
        return false;

    removeFromHNSW(id);
    return true;
}

// ─────────────────────────────────────────────
// Count
// PM-1: prepare return checked
// ─────────────────────────────────────────────

int PersistentMemoryStore::count(
    const std::string& user_id,
    const std::string& workspace
) {
    const char* sql =
        "SELECT COUNT(*) FROM memories WHERE user_id = ? AND workspace = ?";

    StmtGuard g;
    if (!safePrepare(db_, sql, &g.stmt, "count"))
        return 0;

    sqlite3_bind_text(g.stmt, 1, user_id.c_str(),   -1, SQLITE_STATIC);
    sqlite3_bind_text(g.stmt, 2, workspace.c_str(), -1, SQLITE_STATIC);

    int n = 0;
    if (sqlite3_step(g.stmt) == SQLITE_ROW)
        n = sqlite3_column_int(g.stmt, 0);

    return n;
}

// ─────────────────────────────────────────────
// N-API WRAPPER
// ─────────────────────────────────────────────

Napi::Object PersistentMemoryStoreNAPI::Init(
    Napi::Env env, Napi::Object exports
) {
    Napi::Function func = DefineClass(env, "PersistentMemoryStore", {
        InstanceMethod("save",   &PersistentMemoryStoreNAPI::Save),
        InstanceMethod("search", &PersistentMemoryStoreNAPI::Search),
        InstanceMethod("list",   &PersistentMemoryStoreNAPI::List),
        InstanceMethod("update", &PersistentMemoryStoreNAPI::Update),
        InstanceMethod("remove", &PersistentMemoryStoreNAPI::Remove),
        InstanceMethod("count",  &PersistentMemoryStoreNAPI::Count),
        // PM-11: textSearch removed from registered methods.
        // Text search is handled entirely in JS via hybridRetriever.sparseSearch.
        // Registering a stub that silently returns [] is misleading.
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
        Napi::TypeError::New(env,
            "PersistentMemoryStore(dbPath: string, dim?: number)")
            .ThrowAsJavaScriptException();
        return;
    }

    std::string db_path = info[0].As<Napi::String>().Utf8Value();

    // PM-10: Default is 384 (all-MiniLM-L6-v2), not 50 (GloVe-50d).
    // The actual model used throughout ContextForge outputs 384 dimensions.
    int dim = (info.Length() > 1 && info[1].IsNumber())
        ? info[1].As<Napi::Number>().Int32Value()
        : 384;

    try {
        store_ = std::make_unique<PersistentMemoryStore>(db_path, dim);
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    }
}

// ─────────────────────────────────────────────
// JS: save(...)
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::Save(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "save(entry: object)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object obj = info[0].As<Napi::Object>();

    MemoryEntry entry;
    entry.id            = obj.Get("id").As<Napi::String>().Utf8Value();
    entry.user_id       = obj.Get("userId").As<Napi::String>().Utf8Value();
    entry.workspace     = obj.Has("workspace")
        ? obj.Get("workspace").As<Napi::String>().Utf8Value() : "";
    entry.content       = obj.Get("content").As<Napi::String>().Utf8Value();
    entry.importance    = obj.Has("importance")
        ? (float)obj.Get("importance").As<Napi::Number>().DoubleValue() : 0.5f;
    entry.created_at    = obj.Has("createdAt")
        ? obj.Get("createdAt").As<Napi::Number>().Int64Value()
        : std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    entry.updated_at    = entry.created_at;
    entry.metadata_json = obj.Has("metadata")
        ? obj.Get("metadata").As<Napi::String>().Utf8Value() : "{}";

    if (!obj.Has("embedding") || !obj.Get("embedding").IsTypedArray()) {
        Napi::TypeError::New(env, "entry.embedding must be Float32Array")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Float32Array emb = obj.Get("embedding").As<Napi::Float32Array>();
    entry.embedding.assign(emb.Data(), emb.Data() + emb.ElementLength());

    try {
        std::string saved_id = store_->save(entry);
        if (saved_id.empty())
            return env.Undefined();
        return Napi::String::New(env, saved_id);
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Undefined();
    }
}

// ─────────────────────────────────────────────
// JS: search(...)
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
    int   top_k   = opts.Has("topK")
        ? opts.Get("topK").As<Napi::Number>().Int32Value() : 10;
    float min_sim = opts.Has("minSimilarity")
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
// JS: list(...)
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::List(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject())
        return Napi::Array::New(env, 0);

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
// JS: update(...)
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::Update(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject())
        return Napi::Boolean::New(env, false);

    Napi::Object opts = info[0].As<Napi::Object>();
    std::string id      = opts.Get("id").As<Napi::String>().Utf8Value();
    std::string content = opts.Get("content").As<Napi::String>().Utf8Value();

    Napi::Float32Array emb = opts.Get("embedding").As<Napi::Float32Array>();
    std::vector<float> new_emb(emb.Data(), emb.Data() + emb.ElementLength());

    return Napi::Boolean::New(env, store_->update(id, content, new_emb));
}

// ─────────────────────────────────────────────
// JS: remove(id: string)
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::Remove(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString())
        return Napi::Boolean::New(env, false);

    std::string id = info[0].As<Napi::String>().Utf8Value();
    return Napi::Boolean::New(env, store_->remove(id));
}

// ─────────────────────────────────────────────
// JS: count({ userId, workspace })
// ─────────────────────────────────────────────

Napi::Value PersistentMemoryStoreNAPI::Count(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject())
        return Napi::Number::New(env, 0);

    Napi::Object opts = info[0].As<Napi::Object>();
    std::string user_id   = opts.Get("userId").As<Napi::String>().Utf8Value();
    std::string workspace = opts.Has("workspace")
        ? opts.Get("workspace").As<Napi::String>().Utf8Value() : "";

    return Napi::Number::New(env, store_->count(user_id, workspace));
}

} // namespace contextforge