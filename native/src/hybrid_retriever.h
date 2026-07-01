#pragma once

#include <napi.h>
#include <vector>
#include <string>
#include <unordered_map>
#include <queue>
#include <algorithm>
#include <cmath>
#include "cache.h"

class HybridRetriever : public Napi::ObjectWrap<HybridRetriever> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    HybridRetriever(const Napi::CallbackInfo& info);
    ~HybridRetriever();

    // NAPI-exposed methods must be public for InstanceMethod<> registration
    Napi::Value AddDocument(const Napi::CallbackInfo& info);
    Napi::Value AddDocumentWithEmbedding(const Napi::CallbackInfo& info);
    Napi::Value HybridSearch(const Napi::CallbackInfo& info);
    Napi::Value SparseSearch(const Napi::CallbackInfo& info);
    Napi::Value RemoveDocument(const Napi::CallbackInfo& info);
    Napi::Value GetStats(const Napi::CallbackInfo& info);

private:
    struct BM25Doc {
        std::string id;
        std::string text;
        std::string breadcrumb;
        std::vector<std::string>              tokens;
        std::unordered_map<std::string, int>  termFreq;
        int docLength;
    };

    struct ScoredResult {
        std::string id;
        double denseScore;
        double sparseScore;
        double combinedScore;
    };

    // ── BM25 state ────────────────────────────────────────────────────────
    std::vector<BM25Doc>                          documents_;
    std::unordered_map<std::string, double>       idfCache_;
    std::unordered_map<std::string, size_t>       docIndex_;

    // HR-5: Inverted index for O(terms) candidate pre-filter in SparseSearch.
    // Maps term → sorted list of document indices that contain the term.
    std::unordered_map<std::string, std::vector<size_t>> invertedIndex_;

    double avgDocLen_;
    size_t totalDocs_;
    size_t totalDocLen_;

    // ── Dense retrieval ───────────────────────────────────────────────────
    SemanticCache* hnswIndex_;
    int            dim_;
    float          denseWeight_;

    // ── Internal helpers ──────────────────────────────────────────────────
    std::vector<std::string> Tokenize(const std::string& text);
    double ComputeIDF(const std::string& term);
    double BM25Score(const BM25Doc& doc, const std::vector<std::string>& queryTokens);
    std::vector<float> L2Normalize(const float* vec, int dim);
    std::string GenerateBreadcrumb(const std::string& text);

    // HR-1: Core add/remove logic — O(1) swap-with-last instead of O(n) erase
    void addDocumentInternal(const std::string& id, const std::string& text);

    // HR-5: Inverted index maintenance — called by addDocumentInternal and RemoveDocument
    void addToInvertedIndex(size_t docIdx, const BM25Doc& doc);
    void removeFromInvertedIndex(size_t docIdx, const BM25Doc& doc);
    void rebuildInvertedIndex();

    // HR-9: CosineSimilarity removed — was defined but never called.
    // Dense similarity is computed as 1.0f - HNSW distance (IP space).
};