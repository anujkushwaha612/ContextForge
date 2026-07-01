#pragma once
#include <napi.h>
#include <string>
#include <unordered_map>
#include <vector>
#include <queue>
#include "hnswlib/hnswlib/hnswlib.h"

// ─────────────────────────────────────────────────────────────────────────────
// VectorMetadata
// ─────────────────────────────────────────────────────────────────────────────
struct VectorMetadata {
    std::string id;
    std::string namespaceName;
    std::string type;
    std::string payload;
};

class SemanticCache : public Napi::ObjectWrap<SemanticCache> {
    friend class HybridRetriever;

public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    SemanticCache(const Napi::CallbackInfo& info);
    ~SemanticCache();

private:
    // ── Existing API ──────────────────────────────────────────────────────
    Napi::Value Add(const Napi::CallbackInfo& info);
    Napi::Value Search(const Napi::CallbackInfo& info);
    Napi::Value Invalidate(const Napi::CallbackInfo& info);
    Napi::Value ClearAll(const Napi::CallbackInfo& info);

    // ── New API ───────────────────────────────────────────────────────────
    Napi::Value AddWithMeta(const Napi::CallbackInfo& info);
    Napi::Value SearchK(const Napi::CallbackInfo& info);
    Napi::Value SearchThreshold(const Napi::CallbackInfo& info);
    Napi::Value ClearPrefix(const Napi::CallbackInfo& info);
    Napi::Value Size(const Napi::CallbackInfo& info);

    // Stats has two overloads:
    //   - NAPI entry point called by JS
    //   - const helper called internally (e.g. from tests or other C++ code)
    Napi::Value Stats(const Napi::CallbackInfo& info);
    Napi::Value Stats(Napi::Env env) const;

    // ── Internal helpers ──────────────────────────────────────────────────

    // SC-2/SC-8: Remove existing HNSW entry for an ID before re-inserting.
    // Prevents orphaned entries when the same ID is added more than once.
    void removeByIdIfExists(const std::string& id);

    // Build a JS result object from a label + similarity score
    Napi::Object BuildHitObject(Napi::Env env,
                                hnswlib::labeltype label,
                                float similarity) const;

    // ── Member state ──────────────────────────────────────────────────────
    size_t dim_;
    hnswlib::SpaceInterface<float>*   space_;
    hnswlib::HierarchicalNSW<float>*  alg_hnsw_;
    hnswlib::labeltype                current_label_;

    std::unordered_map<hnswlib::labeltype, VectorMetadata> meta_map_;
    std::unordered_map<std::string, hnswlib::labeltype>    id_to_label_;

    // Accurate count of non-deleted vectors.
    // current_label_ counts all ever-inserted (including deleted) —
    // active_count_ is what SearchK should clamp to.
    size_t active_count_;
};