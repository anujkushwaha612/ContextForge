#include "cache.h"
#include <iostream>
#include <algorithm>
#include <sstream>

// ─────────────────────────────────────────────────────────────────────────────
// Init — register all methods
// ─────────────────────────────────────────────────────────────────────────────

Napi::Object SemanticCache::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "SemanticCache", {
        // ── Existing API (backward compatible) ──
        InstanceMethod("add",             &SemanticCache::Add),
        InstanceMethod("search",          &SemanticCache::Search),
        InstanceMethod("invalidate",      &SemanticCache::Invalidate),
        InstanceMethod("clearAll",        &SemanticCache::ClearAll),

        // ── New API ──
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
        Napi::TypeError::New(env, "Expected vector dimension").ThrowAsJavaScriptException();
        return;
    }

    dim_     = info[0].As<Napi::Number>().Uint32Value();
    space_   = new hnswlib::InnerProductSpace(dim_);
    alg_hnsw_ = new hnswlib::HierarchicalNSW<float>(space_, 100000, 16, 200);
}

SemanticCache::~SemanticCache() {
    delete alg_hnsw_;
    delete space_;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — build a JS hit object from a label + similarity score
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
        // Fallback for vectors added via legacy Add() with no metadata
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
// Add (legacy — backward compatible)
// add(Float32Array, stringId) → numeric label
// Stores minimal metadata: id only, namespace/type/payload empty.
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Add(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsString())
        return env.Null();

    Napi::Float32Array arr = info[0].As<Napi::Float32Array>();
    std::string db_id      = info[1].As<Napi::String>().Utf8Value();

    size_t label = current_label_;
    alg_hnsw_->addPoint(arr.Data(), label);

    VectorMetadata meta;
    meta.id            = db_id;
    meta.namespaceName = "";
    meta.type          = "";
    meta.payload       = "";

    meta_map_[label]   = meta;
    id_to_label_[db_id] = label;
    current_label_++;
    active_count_++;

    return Napi::Number::New(env, static_cast<double>(label));
}

// ─────────────────────────────────────────────────────────────────────────────
// AddWithMeta (new)
// addWithMeta(Float32Array, id, namespace, type, payload?) → numeric label
// Full metadata stored — enables clearPrefix(), stats(), typed search.
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

    VectorMetadata meta;
    meta.id            = info[1].As<Napi::String>().Utf8Value();
    meta.namespaceName = info[2].As<Napi::String>().Utf8Value();
    meta.type          = info[3].As<Napi::String>().Utf8Value();
    meta.payload       = (info.Length() >= 5 && info[4].IsString())
                             ? info[4].As<Napi::String>().Utf8Value()
                             : "";

    size_t label = current_label_;
    alg_hnsw_->addPoint(arr.Data(), label);

    meta_map_[label]         = meta;
    id_to_label_[meta.id]    = label;
    current_label_++;
    active_count_++;

    return Napi::Number::New(env, static_cast<double>(label));
}

// ─────────────────────────────────────────────────────────────────────────────
// SearchK (new — core primitive)
// searchK(Float32Array, k) → Array<{id, label, score, namespace, type, payload}>
// Returns k nearest neighbors sorted by descending similarity.
// JS decides thresholds — C++ does not bake them in.
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::SearchK(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsNumber())
        return Napi::Array::New(env, 0);

    Napi::Float32Array query = info[0].As<Napi::Float32Array>();
    size_t k                 = info[1].As<Napi::Number>().Uint32Value();

    if (active_count_ == 0 || k == 0)
        return Napi::Array::New(env, 0);

    // Clamp k to actual indexed points to avoid HNSW assertion
    size_t actual_k = std::min(k, (size_t)current_label_);

    auto result = alg_hnsw_->searchKnn(query.Data(), actual_k);

    // HNSW returns a max-heap (worst first) — collect then reverse
    std::vector<std::pair<float, hnswlib::labeltype>> hits;
    hits.reserve(result.size());
    while (!result.empty()) {
        hits.push_back(result.top());
        result.pop();
    }
    // Now hits[0] = worst, hits.back() = best — reverse for descending score
    std::reverse(hits.begin(), hits.end());

    Napi::Array out = Napi::Array::New(env, hits.size());
    for (size_t i = 0; i < hits.size(); i++) {
        float similarity = 1.0f - hits[i].first;  // InnerProductSpace: dist = 1 - dot
        out[i] = BuildHitObject(env, hits[i].second, similarity);
    }

    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search (legacy — backward compatible)
// search(Float32Array, similarityThreshold) → stringId | null
// Kept for all existing callers (vaultRetriever, cacheDb, etc.)
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Search(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsNumber())
        return env.Null();

    Napi::Float32Array query      = info[0].As<Napi::Float32Array>();
    float similarity_threshold    = info[1].As<Napi::Number>().FloatValue();
    float distance_threshold      = 1.0f - similarity_threshold;

    if (active_count_ == 0) return env.Null();

    auto result = alg_hnsw_->searchKnn(query.Data(), 1);
    if (result.empty()) return env.Null();

    float distance             = result.top().first;
    hnswlib::labeltype label   = result.top().second;

    if (distance <= distance_threshold) {
        auto it = meta_map_.find(label);
        if (it != meta_map_.end()) {
            return Napi::String::New(env, it->second.id);
        }
    }

    return env.Null();
}

// ─────────────────────────────────────────────────────────────────────────────
// SearchThreshold (new — explicit alias for Search)
// searchThreshold(Float32Array, threshold) → stringId | null
// Same as Search() but with a name that makes the intent obvious.
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::SearchThreshold(const Napi::CallbackInfo& info) {
    // Identical implementation — delegates to the same HNSW call.
    return Search(info);
}

// ─────────────────────────────────────────────────────────────────────────────
// Invalidate (updated — now decrements active_count_)
// invalidate(numericLabel) → boolean
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Invalidate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Numeric vector label expected")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    size_t target_label = info[0].As<Napi::Number>().Uint32Value();

    try {
        alg_hnsw_->markDelete(target_label);

        // Clean up metadata and reverse index
        auto it = meta_map_.find(target_label);
        if (it != meta_map_.end()) {
            id_to_label_.erase(it->second.id);
            meta_map_.erase(it);
            if (active_count_ > 0) active_count_--;
        }
    } catch (const std::exception&) {
        // Label doesn't exist — safe to ignore
    }

    return Napi::Boolean::New(env, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// ClearAll (updated — resets both maps and active_count_)
// clearAll() → boolean
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::ClearAll(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    try {
        delete alg_hnsw_;
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
// ClearPrefix (new)
// clearPrefix("PLANNER__") → number of vectors removed
// Marks all vectors whose ID starts with prefix as deleted.
// Does NOT rebuild the graph — uses markDelete for each match.
// Safe to call while other namespaces are active.
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::ClearPrefix(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "String prefix expected")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string prefix = info[0].As<Napi::String>().Utf8Value();
    size_t removed     = 0;

    // Collect matching labels first to avoid iterator invalidation
    std::vector<hnswlib::labeltype> to_remove;
    for (const auto& [label, meta] : meta_map_) {
        if (meta.id.rfind(prefix, 0) == 0) {   // starts_with
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
// Size (new)
// size() → number of active (non-deleted) vectors
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Size(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(active_count_));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats (new)
// stats() → { size, dim, namespaces: { "PLANNER": 37, "CACHE": 120 } }
// ─────────────────────────────────────────────────────────────────────────────

Napi::Value SemanticCache::Stats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object out = Napi::Object::New(env);

    out.Set("size", Napi::Number::New(env, static_cast<double>(active_count_)));
    out.Set("dim",  Napi::Number::New(env, static_cast<double>(dim_)));

    // Count vectors per namespace
    std::unordered_map<std::string, size_t> ns_counts;
    for (const auto& [label, meta] : meta_map_) {
        ns_counts[meta.namespaceName]++;
    }

    Napi::Object ns_obj = Napi::Object::New(env);
    for (const auto& [ns, count] : ns_counts) {
        ns_obj.Set(ns, Napi::Number::New(env, static_cast<double>(count)));
    }
    out.Set("namespaces", ns_obj);

    return out;
}