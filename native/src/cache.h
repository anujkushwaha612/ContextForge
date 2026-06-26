#pragma once
#include <napi.h>
#include <string>
#include <unordered_map>
#include <vector>
#include "hnswlib/hnswlib/hnswlib.h"

// ─────────────────────────────────────────────────────────────────────────────
// VectorMetadata
// Replaces the old id_map_ (label → string).
// Stores structured metadata alongside each vector so subsystems
// (planner, memory, cache) can share one HNSW index with namespace isolation.
// ─────────────────────────────────────────────────────────────────────────────
struct VectorMetadata {
    std::string id;             // Namespaced string ID, e.g. "PLANNER__PATCH__0"
    std::string namespaceName;  // e.g. "PLANNER", "MEMORY", "CACHE"
    std::string type;           // e.g. "anchor", "document", "response"
    std::string payload;        // Arbitrary JSON string for extra data
};

class SemanticCache : public Napi::ObjectWrap<SemanticCache> {
    friend class HybridRetriever;
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    SemanticCache(const Napi::CallbackInfo& info);
    ~SemanticCache();

private:
    // ── Existing API (preserved for backward compat) ──────────────────────
    Napi::Value Add(const Napi::CallbackInfo& info);
    Napi::Value Search(const Napi::CallbackInfo& info);           // threshold search, returns string|null
    Napi::Value Invalidate(const Napi::CallbackInfo& info);
    Napi::Value ClearAll(const Napi::CallbackInfo& info);

    // ── New API ───────────────────────────────────────────────────────────
    Napi::Value AddWithMeta(const Napi::CallbackInfo& info);      // add(vec, id, namespace, type, payload?)
    Napi::Value SearchK(const Napi::CallbackInfo& info);          // searchK(vec, k) → [{id,label,score,namespace,type,payload}]
    Napi::Value SearchThreshold(const Napi::CallbackInfo& info);  // searchThreshold(vec, threshold) → string|null (alias for Search)
    Napi::Value ClearPrefix(const Napi::CallbackInfo& info);      // clearPrefix("PLANNER__") → count removed
    Napi::Value Size(const Napi::CallbackInfo& info);             // size() → number of active vectors
    Napi::Value Stats(const Napi::CallbackInfo& info);            // stats() → {size, dim, namespaces}

    // ── Internal helpers ──────────────────────────────────────────────────
    Napi::Object BuildHitObject(Napi::Env env,
                                hnswlib::labeltype label,
                                float similarity) const;

    size_t dim_;
    hnswlib::SpaceInterface<float>*    space_;
    hnswlib::HierarchicalNSW<float>*   alg_hnsw_;
    hnswlib::labeltype                 current_label_;

    // Replaces old id_map_ — keyed by HNSW integer label
    std::unordered_map<hnswlib::labeltype, VectorMetadata> meta_map_;

    // Reverse index: string ID → label (for contains() and invalidate-by-id)
    std::unordered_map<std::string, hnswlib::labeltype> id_to_label_;

    // Active count (HNSW doesn't expose this after markDelete)
    size_t active_count_;
};