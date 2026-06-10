#include <napi.h>
#include "simhash.h"
#include <cmath>
#include "tfidf.h"
#include "cache.h"
#include "hybrid_retriever.h"
#include "ast_compressor.h"
#include "persistent_memory.h"
#include "onnx_embedder.h"
#include "anomaly_scorer.h"

Napi::Number NativeCosineSimilarity(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    // 1. Validate arguments
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray())
    {
        Napi::TypeError::New(env, "Expected two Float64Arrays").ThrowAsJavaScriptException();
        return Napi::Number::New(env, 0);
    }

    // 2. Cast to Float64Array
    Napi::Float64Array arrA = info[0].As<Napi::Float64Array>();
    Napi::Float64Array arrB = info[1].As<Napi::Float64Array>();

    size_t length = arrA.ElementLength();
    if (length != arrB.ElementLength())
    {
        Napi::TypeError::New(env, "Arrays must be same length").ThrowAsJavaScriptException();
        return Napi::Number::New(env, 0);
    }

    // 3. Get raw memory pointers (ZERO COPY)
    double *A = arrA.Data();
    double *B = arrB.Data();

    // 4. Compute Math
    double dot = 0.0, magA = 0.0, magB = 0.0;
    for (size_t i = 0; i < length; i++)
    {
        dot += A[i] * B[i];
        magA += A[i] * A[i];
        magB += B[i] * B[i];
    }

    double denom = std::sqrt(magA) * std::sqrt(magB);
    double result = (denom == 0.0) ? 0.0 : (dot / denom);

    // 5. Return to JS
    return Napi::Number::New(env, result);
}

// Declare functions
Napi::Value LoadStaticEmbeddings(const Napi::CallbackInfo &info);
Napi::Number CosineSimilarityStatic(const Napi::CallbackInfo &info);
Napi::Number GetEmbeddingDim(const Napi::CallbackInfo &info);
Napi::Boolean IsEmbeddingLoaded(const Napi::CallbackInfo &info);

// TF-IDF and other functions...
extern Napi::Number NativeTfIdfCosine(const Napi::CallbackInfo &info);
extern Napi::Number NativeCosineSimilarity(const Napi::CallbackInfo &info);

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    exports.Set("tfidfCosine", Napi::Function::New(env, NativeTfIdfCosine));
    exports.Set("cosineSimilarity", Napi::Function::New(env, NativeCosineSimilarity));

    exports.Set("loadStaticEmbeddings", Napi::Function::New(env, LoadStaticEmbeddings));
    exports.Set("cosineSimilarityStatic", Napi::Function::New(env, CosineSimilarityStatic));
    exports.Set("getEmbeddingDim", Napi::Function::New(env, GetEmbeddingDim));
    exports.Set("isEmbeddingLoaded", Napi::Function::New(env, IsEmbeddingLoaded));

    SemanticCache::Init(env, exports);
    HybridRetriever::Init(env, exports);

    // ADD THIS
    contextforge::ASTCompressorNAPI::Init(env, exports);
    contextforge::InitSimHash(env, exports);
    contextforge::PersistentMemoryStoreNAPI::Init(env, exports); // ← ADD

    contextforge::OnnxEmbedderNAPI::Init(env, exports);

    contextforge::InitAnomalyScorer(env, exports);  // ← ADD THIS
    return exports;
}
NODE_API_MODULE(contextforge_native, Init)
