#include "cache.h"
#include <iostream>
#include <algorithm>
#include <sstream>
#include <queue>   // SC-12: explicit priority_queue declaration in search guards

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

Napi::Object SemanticCache::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "SemanticCache", {
        InstanceMethod("add",             &SemanticCache::Add),
        InstanceMethod("search",          &SemanticCache::Search),
        InstanceMethod("invalidate",      &SemanticCache::Invalidate),
        InstanceMethod("clearAll",        &SemanticCache::ClearAll),
        InstanceMethod("addWithMeta",     &SemanticCache::AddWithMeta),
        InstanceMethod("searchK",         &SemanticCache::SearchK),
        InstanceMethod("searchThreshold", &SemanticCache::SearchThreshold),
        InstanceMethod("clearPrefix",     &SemanticCache::ClearPrefix),
        InstanceMethod("size",            &SemanticCache::Size),
        InstanceMethod("stats",           &SemanticCache::Stats),
    });

    Napi::FunctionReference* constructor = new Napi::FunctionReference();
    *constructor = Napi::Persistent(func);
    env.SetInstanceData(constructor);

    exports.Set("SemanticCache", func);
    return exports;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constructor
// ─────────────────────────────────────────────────────────────────────────────

SemanticCache::SemanticCache(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<SemanticCache>(info),
      current_label_(0),
      active_count_(0)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected vector dimension")
            .ThrowAsJavaScriptException();
        return;
    }

    dim_      = info[0].As<Napi::Number>().Uint32Value();
    space_    = new hnswlib::InnerProductSpace(dim_);
    alg_hnsw_ = new hnswlib::HierarchicalNSW<float>(space_, 100000, 16, 200);
}

SemanticCache::~SemanticCache() {
    delete alg_hnsw_;
    delete space_;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: remove an existing label cleanly
//
// SC-2/SC-8: Shared deduplication logic used by both Add and AddWithMeta.
// If the same ID is re-added, the old HNSW entry is marked deleted
// and removed from both maps before the new entry is inserted.
// ─────────────────────────────────────────────────────────────────────────────

void SemanticCache::removeByIdIfExists(const std::string& id) {
    auto rev_it = id_to_label_.find(id);
    if (rev_it == id_to_label_.end()) return;

    hnswlib::labeltype old_label = rev_it->second;

    try {
        alg_hnsw_->markDelete(old_label);
    } catch (...) {
        // Already deleted or invalid — continue cleanup
    }

    meta_map_.erase(old_label);
    id_to_label_.erase(rev_it);
    if (active_count_ > 0) active_count_--;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build hit object
// ─────────────────────────────────────────────────────────────────────────────

Napi::Object SemanticCache::BuildHitObject(Napi::Env env,
                                            hnswlib::labeltype label,
                                            float similarity) const {
    Napi::Object hit = Napi::Object::New(env);

    auto it = meta_map_.find(label);
    if (it != meta_map_.end()) {
        const VectorMetadata& m = it->second;
        hit.Set("id",        Napi::String::New(env, m.id));
        hit.Set("label",     Napi::Number::New(env, static_cast<double>(label)));
        hit.Set("score",     Napi::Number::New(env, similarity));
        hit.Set("namespace", Napi::String::New(env, m.namespaceName));
        hit.Set("type",      Napi::String::New(env, m.type));
        hit.Set("payload",   Napi::String::New(env, m.payload));
    } else {
        // Legacy Add() entry with no metadata
        hit.Set("id",        Napi::String::New(env, ""));
        hit.Set("label",     Napi::Number::New(env, static_cast<double>(label)));
        hit.Set("score",     Napi::Number::New(env, similarity));
        hit.Set("namespace", Napi::String::New(env, ""));
        hit.Set("type",      Napi::String::New(env, ""));
        hit.Set("payload",   Napi::String::New(env, ""));
    }

    return hit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Add (legacy)
//
// SC-2: Now removes existing entry with same ID before inserting.
// SC-6: addPoint wrapped in try/catch — throws JS error instead of crashing.
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Add(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsString())
        return env.Null();

    Napi::Float32Array arr = info[0].As<Napi::Float32Array>();
    std::string db_id      = info[1].As<Napi::String>().Utf8Value();

    // SC-10 FIX: dimension guard. addPoint reads dim_ floats from the
    // buffer unconditionally — a shorter Float32Array meant reading past
    // the end (UB). hybrid_retriever guards this at its boundary; the
    // cache must too (it shares the SAME underlying HNSW index).
    if (arr.ElementLength() != (size_t)dim_) {
        Napi::TypeError::New(env,
            "[SemanticCache] add: embedding dim " +
            std::to_string(arr.ElementLength()) + " != " + std::to_string(dim_))
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    // SC-2: Remove existing entry for this ID to prevent orphaned HNSW entries
    removeByIdIfExists(db_id);

    size_t label = current_label_;

    // SC-6: Catch addPoint exceptions — prevents Node.js process crash
    try {
        alg_hnsw_->addPoint(arr.Data(), label);
    } catch (const std::exception& e) {
        Napi::Error::New(env,
            std::string("[SemanticCache] addPoint failed: ") + e.what())
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    VectorMetadata meta;
    meta.id            = db_id;
    meta.namespaceName = "";
    meta.type          = "";
    meta.payload       = "";

    meta_map_[label]    = meta;
    id_to_label_[db_id] = label;
    current_label_++;
    active_count_++;

    return Napi::Number::New(env, static_cast<double>(label));
}

// ─────────────────────────────────────────────────────────────────────────────
// AddWithMeta (new)
//
// SC-8: Now removes existing entry with same ID before inserting.
// SC-6: addPoint wrapped in try/catch.
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::AddWithMeta(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4
        || !info[0].IsTypedArray()
        || !info[1].IsString()
        || !info[2].IsString()
        || !info[3].IsString()) {
        Napi::TypeError::New(env,
            "addWithMeta(Float32Array, id, namespace, type, payload?)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float32Array arr = info[0].As<Napi::Float32Array>();

    // SC-10: same dimension guard as Add()
    if (arr.ElementLength() != (size_t)dim_) {
        Napi::TypeError::New(env,
            "[SemanticCache] addWithMeta: embedding dim " +
            std::to_string(arr.ElementLength()) + " != " + std::to_string(dim_))
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    VectorMetadata meta;
    meta.id            = info[1].As<Napi::String>().Utf8Value();
    meta.namespaceName = info[2].As<Napi::String>().Utf8Value();
    meta.type          = info[3].As<Napi::String>().Utf8Value();
    meta.payload       = (info.Length() >= 5 && info[4].IsString())
                         ? info[4].As<Napi::String>().Utf8Value()
                         : "";

    // SC-8: Remove existing entry for this ID to prevent orphaned HNSW entries
    removeByIdIfExists(meta.id);

    size_t label = current_label_;

    // SC-6: Catch addPoint exceptions
    try {
        alg_hnsw_->addPoint(arr.Data(), label);
    } catch (const std::exception& e) {
        Napi::Error::New(env,
            std::string("[SemanticCache] addPoint failed: ") + e.what())
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    meta_map_[label]       = meta;
    id_to_label_[meta.id]  = label;
    current_label_++;
    active_count_++;

    return Napi::Number::New(env, static_cast<double>(label));
}

// ─────────────────────────────────────────────────────────────────────────────
// SearchK (new)
//
// SC-1: Clamp to active_count_ not current_label_.
//       current_label_ includes deleted entries — active_count_ is accurate.
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::SearchK(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsNumber())
        return Napi::Array::New(env, 0);

    Napi::Float32Array query = info[0].As<Napi::Float32Array>();
    size_t k                 = info[1].As<Napi::Number>().Uint32Value();

    if (active_count_ == 0 || k == 0)
        return Napi::Array::New(env, 0);

    // SC-11 FIX: dimension guard — searchKnn reads dim_ floats from the
    // query buffer; a short query vector was an out-of-bounds read (UB).
    if (query.ElementLength() != (size_t)dim_)
        return Napi::Array::New(env, 0);

    // SC-1: Clamp to active_count_ — current_label_ includes deleted entries
    size_t actual_k = std::min(k, active_count_);

    // SC-12 FIX: searchKnn can throw (e.g. "Cannot return the results in a
    // contiguous 2D array" edge cases, allocation failures). The binding is
    // compiled with NAPI_DISABLE_CPP_EXCEPTIONS — an uncaught C++ exception
    // at this boundary is std::terminate: the ENTIRE proxy process dies on
    // one bad query. addPoint got this guard in SC-6; searches never did.
    std::priority_queue<std::pair<float, hnswlib::labeltype>> result;
    try {
        result = alg_hnsw_->searchKnn(query.Data(), actual_k);
    } catch (const std::exception& e) {
        fprintf(stderr, "[SemanticCache] searchKnn failed: %s\n", e.what());
        return Napi::Array::New(env, 0);
    }

    // Collect from max-heap (largest distance at top) then reverse for
    // descending similarity order (best match first)
    std::vector<std::pair<float, hnswlib::labeltype>> hits;
    hits.reserve(result.size());
    while (!result.empty()) {
        hits.push_back(result.top());
        result.pop();
    }
    std::reverse(hits.begin(), hits.end());

    Napi::Array out = Napi::Array::New(env, hits.size());
    for (size_t i = 0; i < hits.size(); i++) {
        float similarity = 1.0f - hits[i].first;
        out[i] = BuildHitObject(env, hits[i].second, similarity);
    }

    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search (legacy)
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Search(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsNumber())
        return env.Null();

    Napi::Float32Array query   = info[0].As<Napi::Float32Array>();
    float similarity_threshold = info[1].As<Napi::Number>().FloatValue();
    float distance_threshold   = 1.0f - similarity_threshold;

    if (active_count_ == 0) return env.Null();

    // SC-11: dimension guard (same as SearchK)
    if (query.ElementLength() != (size_t)dim_) return env.Null();

    // SC-12: crash guard (same as SearchK)
    std::priority_queue<std::pair<float, hnswlib::labeltype>> result;
    try {
        result = alg_hnsw_->searchKnn(query.Data(), 1);
    } catch (const std::exception& e) {
        fprintf(stderr, "[SemanticCache] searchKnn failed: %s\n", e.what());
        return env.Null();
    }
    if (result.empty()) return env.Null();

    float              distance = result.top().first;
    hnswlib::labeltype label    = result.top().second;

    if (distance <= distance_threshold) {
        auto it = meta_map_.find(label);
        if (it != meta_map_.end()) {
            return Napi::String::New(env, it->second.id);
        }
    }

    return env.Null();
}

// ─────────────────────────────────────────────────────────────────────────────
// SearchThreshold (new — alias for Search)
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::SearchThreshold(const Napi::CallbackInfo& info) {
    return Search(info);
}

// ─────────────────────────────────────────────────────────────────────────────
// Invalidate
//
// SC-4: Now returns true only if the label was actually found and deleted.
//       Previously always returned true — callers could not detect failure.
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Invalidate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Numeric vector label expected")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    size_t target_label = info[0].As<Napi::Number>().Uint32Value();
    bool   deleted      = false;

    try {
        alg_hnsw_->markDelete(target_label);

        auto it = meta_map_.find(target_label);
        if (it != meta_map_.end()) {
            id_to_label_.erase(it->second.id);
            meta_map_.erase(it);
            if (active_count_ > 0) active_count_--;
            deleted = true;
        }
    } catch (const std::exception&) {
        // Label does not exist — deleted stays false
    }

    return Napi::Boolean::New(env, deleted);
}

// ─────────────────────────────────────────────────────────────────────────────
// ClearAll
//
// SC-5: Set alg_hnsw_ to nullptr before reallocation so a failed `new`
//       does not leave a dangling pointer that subsequent calls dereference.
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::ClearAll(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    try {
        delete alg_hnsw_;
        alg_hnsw_ = nullptr;  // SC-5: safe state before reallocation

        alg_hnsw_ = new hnswlib::HierarchicalNSW<float>(space_, 100000, 16, 200);

        meta_map_.clear();
        id_to_label_.clear();
        current_label_ = 0;
        active_count_  = 0;

        return Napi::Boolean::New(env, true);
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ClearPrefix
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::ClearPrefix(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "String prefix expected")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string prefix = info[0].As<Napi::String>().Utf8Value();
    size_t      removed = 0;

    // Collect matching labels first to avoid iterator invalidation
    std::vector<hnswlib::labeltype> to_remove;
    for (const auto& [label, meta] : meta_map_) {
        if (meta.id.rfind(prefix, 0) == 0) {
            to_remove.push_back(label);
        }
    }

    for (hnswlib::labeltype label : to_remove) {
        try {
            alg_hnsw_->markDelete(label);
            auto it = meta_map_.find(label);
            if (it != meta_map_.end()) {
                id_to_label_.erase(it->second.id);
                meta_map_.erase(it);
                if (active_count_ > 0) active_count_--;
                removed++;
            }
        } catch (const std::exception&) {}
    }

    return Napi::Number::New(env, static_cast<double>(removed));
}

// ─────────────────────────────────────────────────────────────────────────────
// Size
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Size(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(active_count_));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
//
// SC-9: Empty-string namespace entries (from legacy Add()) are filtered out
//       so the stats output only shows meaningful named namespaces.
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Stats(const Napi::Env env) const {
    Napi::Object out = Napi::Object::New(env);

    out.Set("size", Napi::Number::New(env, static_cast<double>(active_count_)));
    out.Set("dim",  Napi::Number::New(env, static_cast<double>(dim_)));

    std::unordered_map<std::string, size_t> ns_counts;
    for (const auto& [label, meta] : meta_map_) {
        // SC-9: Skip empty-string namespace from legacy Add() calls
        if (!meta.namespaceName.empty()) {
            ns_counts[meta.namespaceName]++;
        }
    }

    Napi::Object ns_obj = Napi::Object::New(env);
    for (const auto& [ns, count] : ns_counts) {
        ns_obj.Set(ns, Napi::Number::New(env, static_cast<double>(count)));
    }
    out.Set("namespaces", ns_obj);

    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats — NAPI entry point
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Stats(const Napi::CallbackInfo& info) {
    return Stats(info.Env());
}