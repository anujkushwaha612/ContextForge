#include "cache.h"
#include <iostream>

Napi::Object SemanticCache::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "SemanticCache", {
        InstanceMethod("add", &SemanticCache::Add),
        InstanceMethod("search", &SemanticCache::Search),
        InstanceMethod("invalidate", &SemanticCache::Invalidate), // 🚀 Added here!
        InstanceMethod("clearAll", &SemanticCache::ClearAll)
    });

    Napi::FunctionReference* constructor = new Napi::FunctionReference();
    *constructor = Napi::Persistent(func);
    env.SetInstanceData(constructor);

    exports.Set("SemanticCache", func);
    return exports;
}

SemanticCache::SemanticCache(const Napi::CallbackInfo& info) : Napi::ObjectWrap<SemanticCache>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected vector dimension").ThrowAsJavaScriptException();
        return;
    }
    
    dim_ = info[0].As<Napi::Number>().Uint32Value();
    current_label_ = 0;

    // Initialize HNSW using Inner Product (which is Cosine Distance since our vectors are L2 Normalized)
    space_ = new hnswlib::InnerProductSpace(dim_);
    
    // Max elements: 100,000 (can be resized). M=16 (links per node). ef_construction=200.
    size_t max_elements = 100000;
    alg_hnsw_ = new hnswlib::HierarchicalNSW<float>(space_, max_elements, 16, 200);
}

SemanticCache::~SemanticCache() {
    delete alg_hnsw_;
    delete space_;
}

Napi::Value SemanticCache::Add(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsString()) return env.Null();

    Napi::Float32Array arr = info[0].As<Napi::Float32Array>();
    std::string db_id = info[1].As<Napi::String>().Utf8Value();

    // Store the current label before incrementing
    size_t label_to_return = current_label_;

    // 1. Add to HNSW Graph
    alg_hnsw_->addPoint(arr.Data(), label_to_return);
    
    // 2. Map the integer label to the String UUID
    id_map_[label_to_return] = db_id;
    current_label_++;

    // 🚀 NEW: Return the numeric label back to Node.js!
    return Napi::Number::New(env, static_cast<double>(label_to_return));
}

// 🚀 FIXED: Added SemanticCache:: and fixed the lookup logic
Napi::Value SemanticCache::Invalidate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // 🚀 NEW: Expect a Number (the vector label) instead of a String ID
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Numeric vector label expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    size_t target_label = info[0].As<Napi::Number>().Uint32Value();

    try {
        // Instantly sever the label from the HNSW graph search results
        alg_hnsw_->markDelete(target_label);
    } catch (const std::exception& e) {
        // If HNSW throws an error (e.g., label doesn't exist), safely ignore it
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value SemanticCache::ClearAll(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        try {
            // Delete the old graph from RAM to prevent memory leaks
            delete alg_hnsw_;
            
            // Instantly spin up a fresh, empty graph (assuming your max elements is 100000)
            alg_hnsw_ = new hnswlib::HierarchicalNSW<float>(space_, 100000);
            
            return Napi::Boolean::New(env, true);
        } catch (const std::exception& e) {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
            return env.Null();
        }
    }

Napi::Value SemanticCache::Search(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsNumber()) return env.Null();

    Napi::Float32Array query = info[0].As<Napi::Float32Array>();
    
    // JS passes Similarity (e.g., 0.85). HNSW uses Distance (0.0 to 2.0).
    // Distance = 1.0 - Similarity.
    float similarity_threshold = info[1].As<Napi::Number>().FloatValue();
    float distance_threshold = 1.0f - similarity_threshold; 

    // If cache is empty, return null safely
    if (current_label_ == 0) return env.Null();

    // Search the Graph for the 1 nearest neighbor
    std::priority_queue<std::pair<float, hnswlib::labeltype>> result = alg_hnsw_->searchKnn(query.Data(), 1);
    
    if (result.empty()) return env.Null();

    float shortest_distance = result.top().first;
    hnswlib::labeltype best_label = result.top().second;

    // Check against inverted threshold
    if (shortest_distance <= distance_threshold) {
        std::string db_id = id_map_[best_label];
        return Napi::String::New(env, db_id);
    }

    return env.Null(); // Cache miss (not similar enough)
}