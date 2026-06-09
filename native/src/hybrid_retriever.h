#ifndef HYBRID_RETRIEVER_H
#define HYBRID_RETRIEVER_H

#include <napi.h>
#include <vector>
#include <string>
#include <unordered_map>
#include <algorithm>
#include <cmath>
#include "cache.h"

class HybridRetriever : public Napi::ObjectWrap<HybridRetriever>
{
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    HybridRetriever(const Napi::CallbackInfo &info);
    ~HybridRetriever();

    // Node.js-exposed methods MUST be public for InstanceMethod<> to access them
    Napi::Value AddDocument(const Napi::CallbackInfo &info);
    Napi::Value AddDocumentWithEmbedding(const Napi::CallbackInfo &info);
    Napi::Value HybridSearch(const Napi::CallbackInfo &info);
    Napi::Value SparseSearch(const Napi::CallbackInfo &info);
    Napi::Value RemoveDocument(const Napi::CallbackInfo &info);
    Napi::Value GetStats(const Napi::CallbackInfo &info);

private:
    struct BM25Doc
    {
        std::string id;
        std::string text;
        std::string breadcrumb;
        std::vector<std::string> tokens;
        std::unordered_map<std::string, int> termFreq;
        int docLength;
    };

    struct ScoredResult
    {
        std::string id;
        double denseScore;
        double sparseScore;
        double combinedScore;
    };

    std::vector<BM25Doc> documents_;
    std::unordered_map<std::string, double> idfCache_;
    std::unordered_map<std::string, size_t> docIndex_;
    double avgDocLen_;
    size_t totalDocs_;
    size_t totalDocLen_ = 0;

    SemanticCache *hnswIndex_;

    int dim_;
    float denseWeight_;

    std::vector<std::string> Tokenize(const std::string &text);
    double ComputeIDF(const std::string &term);
    double BM25Score(const BM25Doc &doc, const std::vector<std::string> &queryTokens);
    double CosineSimilarity(const float *a, const float *b, int dim);
    std::vector<float> L2Normalize(const float *vec, int dim);
    std::string GenerateBreadcrumb(const std::string &text);
    void addDocumentInternal(const std::string &id, const std::string &text);
};

#endif // HYBRID_RETRIEVER_H