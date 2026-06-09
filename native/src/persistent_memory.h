#pragma once
#include <napi.h>
#include <string>
#include <vector>
#include <unordered_map>
#include <sqlite3.h>

// Forward declare hnswlib types (already vendored for SemanticCache)
#include "hnswlib/hnswlib/hnswlib.h"

namespace contextforge {

// ─────────────────────────────────────────────
// One memory entry (mirrors SQLite row)
// ─────────────────────────────────────────────
struct MemoryEntry {
  std::string id;
  std::string user_id;
  std::string workspace;
  std::string content;
  float       importance;
  int64_t     created_at;
  int64_t     updated_at;
  std::string metadata_json;

  // Embedding vector (dim = 50 for GloVe-50d)
  std::vector<float> embedding;
};

// ─────────────────────────────────────────────
// Search result
// ─────────────────────────────────────────────
struct MemorySearchResult {
  std::string id;
  std::string content;
  float       score;         // cosine similarity
  int64_t     created_at;
  std::string metadata_json;
};

// ─────────────────────────────────────────────
// PersistentMemoryStore
// SQLite-backed vector store with HNSW index
// Survives server restarts
// ─────────────────────────────────────────────
class PersistentMemoryStore {
public:
  explicit PersistentMemoryStore(
    const std::string& db_path,
    int                vector_dim = 50  // GloVe-50d
  );
  ~PersistentMemoryStore();

  // Save a memory entry with pre-computed embedding
  std::string save(const MemoryEntry& entry);

  // Search by embedding vector — returns top-k results
  std::vector<MemorySearchResult> search(
    const std::vector<float>& query_embedding,
    const std::string&        user_id,
    const std::string&        workspace,
    int                       top_k,
    float                     min_similarity
  );

  // BM25 text search (delegates to tokenized content)
  std::vector<MemorySearchResult> textSearch(
    const std::string& query,
    const std::string& user_id,
    const std::string& workspace,
    int                top_k
  );

  // List recent entries
  std::vector<MemorySearchResult> list(
    const std::string& user_id,
    const std::string& workspace,
    int                limit
  );

  // Update content + re-embed
  bool update(
    const std::string& id,
    const std::string& new_content,
    const std::vector<float>& new_embedding
  );

  // Delete entry
  bool remove(const std::string& id);

  // Get entry count
  int count(const std::string& user_id, const std::string& workspace);

  // N-API registration
  static Napi::Object Init(Napi::Env env, Napi::Object exports);

private:
  sqlite3*    db_;
  int         dim_;
  std::string db_path_;

  // In-memory HNSW index (rebuilt from SQLite on startup)
  hnswlib::HierarchicalNSW<float>* hnsw_;
  hnswlib::InnerProductSpace*      space_;

  // Map: HNSW label → memory id
  std::unordered_map<hnswlib::labeltype, std::string> label_to_id_;
  // Map: memory id → HNSW label
  std::unordered_map<std::string, hnswlib::labeltype> id_to_label_;
  hnswlib::labeltype next_label_ = 0;

  // SQLite helpers
  void initSchema();
  void loadAllIntoHNSW();
  void insertRow(const MemoryEntry& entry);
  void deleteRow(const std::string& id);

  // HNSW helpers
  void addToHNSW(const std::string& id, const std::vector<float>& embedding);
  void removeFromHNSW(const std::string& id);

  // Cosine similarity (L2-normalized → inner product)
  static std::vector<float> l2Normalize(const std::vector<float>& v);

  // N-API instance methods
  Napi::Value JS_Save(const Napi::CallbackInfo& info);
  Napi::Value JS_Search(const Napi::CallbackInfo& info);
  Napi::Value JS_TextSearch(const Napi::CallbackInfo& info);
  Napi::Value JS_List(const Napi::CallbackInfo& info);
  Napi::Value JS_Update(const Napi::CallbackInfo& info);
  Napi::Value JS_Remove(const Napi::CallbackInfo& info);
  Napi::Value JS_Count(const Napi::CallbackInfo& info);

  static Napi::Object EntryToJS(
    Napi::Env env,
    const MemorySearchResult& r
  );
};

// N-API wrapper
class PersistentMemoryStoreNAPI
  : public Napi::ObjectWrap<PersistentMemoryStoreNAPI> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit PersistentMemoryStoreNAPI(const Napi::CallbackInfo& info);

private:
  std::unique_ptr<PersistentMemoryStore> store_;

  Napi::Value Save(const Napi::CallbackInfo& info);
  Napi::Value Search(const Napi::CallbackInfo& info);
  Napi::Value TextSearch(const Napi::CallbackInfo& info);
  Napi::Value List(const Napi::CallbackInfo& info);
  Napi::Value Update(const Napi::CallbackInfo& info);
  Napi::Value Remove(const Napi::CallbackInfo& info);
  Napi::Value Count(const Napi::CallbackInfo& info);
};

} // namespace contextforge