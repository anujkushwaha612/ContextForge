#pragma once

#include <napi.h>
#include <string>
#include <vector>
#include <unordered_map>
#include <queue>
#include <sqlite3.h>
#include "hnswlib/hnswlib/hnswlib.h"

namespace contextforge {

// ─────────────────────────────────────────────
// MemoryEntry — one memory row
// ─────────────────────────────────────────────
struct MemoryEntry {
    std::string        id;
    std::string        user_id;
    std::string        workspace;
    std::string        content;
    float              importance;
    int64_t            created_at;
    int64_t            updated_at;
    std::string        metadata_json;
    std::vector<float> embedding;
};

// ─────────────────────────────────────────────
// MemorySearchResult — one search result row
// ─────────────────────────────────────────────
struct MemorySearchResult {
    std::string id;
    std::string content;
    float       score;
    int64_t     created_at;
    std::string metadata_json;
};

// ─────────────────────────────────────────────
// PersistentMemoryStore
//
// SQLite-backed vector store with in-memory HNSW index.
// Survives server restarts — HNSW is rebuilt from SQLite on startup.
//
// Changes from original header:
//   - vector_dim default changed from 50 (GloVe) to 384 (all-MiniLM-L6-v2)
//   - freed_labels_ queue added for PM-8 label recycling
//   - textSearch() removed from public interface (stub was silent empty array)
//   - insertRow/deleteRow removed (direct SQL in .cpp, no separate helpers needed)
//   - JS_* methods removed (NAPI wrapper is a separate class)
// ─────────────────────────────────────────────
class PersistentMemoryStore {
public:
    // PM-10: Default dim changed to 384 — matches all-MiniLM-L6-v2
    explicit PersistentMemoryStore(
        const std::string& db_path,
        int                vector_dim = 384);
    ~PersistentMemoryStore();

    std::string save(const MemoryEntry& entry);

    std::vector<MemorySearchResult> search(
        const std::vector<float>& query_embedding,
        const std::string&        user_id,
        const std::string&        workspace,
        int                       top_k,
        float                     min_similarity);

    std::vector<MemorySearchResult> list(
        const std::string& user_id,
        const std::string& workspace,
        int                limit);

    bool update(
        const std::string&        id,
        const std::string&        new_content,
        const std::vector<float>& new_embedding);

    bool remove(const std::string& id);

    int count(const std::string& user_id, const std::string& workspace);

private:
    sqlite3*    db_;
    int         dim_;
    std::string db_path_;

    hnswlib::HierarchicalNSW<float>* hnsw_;
    hnswlib::InnerProductSpace*      space_;

    std::unordered_map<hnswlib::labeltype, std::string> label_to_id_;
    std::unordered_map<std::string, hnswlib::labeltype> id_to_label_;
    hnswlib::labeltype next_label_ = 0;

    // PM-8: Freed label recycling — prevents next_label_ growing unboundedly
    // after many delete+insert cycles would eventually exceed max_elements.
    std::queue<hnswlib::labeltype> freed_labels_;

    void initSchema();
    void loadAllIntoHNSW();

    void addToHNSW(const std::string& id, const std::vector<float>& embedding);
    void removeFromHNSW(const std::string& id);

    static std::vector<float> l2Normalize(const std::vector<float>& v);
};

// ─────────────────────────────────────────────
// N-API wrapper
//
// PM-11: textSearch removed from registered methods — the stub always
//        returned an empty array with no warning. Text search is handled
//        in JS via hybridRetriever.sparseSearch.
// ─────────────────────────────────────────────
class PersistentMemoryStoreNAPI
    : public Napi::ObjectWrap<PersistentMemoryStoreNAPI> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    explicit PersistentMemoryStoreNAPI(const Napi::CallbackInfo& info);

private:
    std::unique_ptr<PersistentMemoryStore> store_;

    Napi::Value Save(const Napi::CallbackInfo& info);
    Napi::Value Search(const Napi::CallbackInfo& info);
    Napi::Value List(const Napi::CallbackInfo& info);
    Napi::Value Update(const Napi::CallbackInfo& info);
    Napi::Value Remove(const Napi::CallbackInfo& info);
    Napi::Value Count(const Napi::CallbackInfo& info);
    // TextSearch intentionally omitted — handled in JS layer
};

} // namespace contextforge