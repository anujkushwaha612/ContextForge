#include <napi.h>
#include "cache.h"
#include "hybrid_retriever.h"
#include "ast_compressor.h"
#include "simhash.h"
#include "persistent_memory.h"
#include "onnx_embedder.h"

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    // ── Vector index + retrieval ──────────────────────────────────────────
    SemanticCache::Init(env, exports);
    HybridRetriever::Init(env, exports);

    // ── AST compression ───────────────────────────────────────────────────
    contextforge::ASTCompressorNAPI::Init(env, exports);

    // ── SimHash (used by semanticDedup.js) ────────────────────────────────
    contextforge::InitSimHash(env, exports);

    // ── Persistent memory ─────────────────────────────────────────────────
    contextforge::PersistentMemoryStoreNAPI::Init(env, exports);

    // ── ONNX embedding ────────────────────────────────────────────────────
    contextforge::OnnxEmbedderNAPI::Init(env, exports);

    return exports;
}

NODE_API_MODULE(contextforge_native, Init)