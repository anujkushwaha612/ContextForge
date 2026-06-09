#pragma once
#include <napi.h>
#include <string>
#include <unordered_map>
#include "hnswlib/hnswlib/hnswlib.h"

class SemanticCache : public Napi::ObjectWrap<SemanticCache> {
    friend class HybridRetriever; 
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    SemanticCache(const Napi::CallbackInfo& info);
    ~SemanticCache(); // We need a destructor now to free the graph memory

private:
    Napi::Value Add(const Napi::CallbackInfo& info);
    Napi::Value Search(const Napi::CallbackInfo& info);
    Napi::Value Invalidate(const Napi::CallbackInfo& info);
    Napi::Value ClearAll(const Napi::CallbackInfo& info); 
    size_t dim_;
    
    // HNSW Core Objects
    hnswlib::SpaceInterface<float>* space_;
    hnswlib::HierarchicalNSW<float>* alg_hnsw_;
    
    // Translation Map: HNSW Label (Integer) -> SQLite ID (String)
    hnswlib::labeltype current_label_;
    std::unordered_map<hnswlib::labeltype, std::string> id_map_;
};