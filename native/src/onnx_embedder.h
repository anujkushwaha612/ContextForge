#pragma once

#include <napi.h>
#include <string>
#include <vector>
#include <memory>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <atomic>
#include <future>

#include "onnxruntime_c_api.h"
#include "embed_cache.h"

namespace contextforge {

// ─────────────────────────────────────────────
// Tokenizer output
// ─────────────────────────────────────────────
struct TokenizerOutput {
    std::vector<int64_t> input_ids;
    std::vector<int64_t> attention_mask;
    std::vector<int64_t> token_type_ids;
};

// ─────────────────────────────────────────────
// Inference request (sits in queue between JS
// thread and inference thread)
// ─────────────────────────────────────────────
struct EmbedRequest {
    std::vector<std::string>                              texts;
    std::promise<std::vector<std::vector<float>>>         promise;
};

// ─────────────────────────────────────────────
// OnnxEmbedder
//
// Threading model:
//   Main thread  → enqueues EmbedRequest, returns future
//   Infer thread → owns ONNX session, dequeues, fulfills promise
//   No ONNX call ever touches the Node.js event loop.
//
// Removed:
//   embedAsync()  — dead code (NAPI uses AsyncWorker → embedBatchSync)
//   warmup()      — dead code (JS warmup goes through Embed NAPI method)
// ─────────────────────────────────────────────
class OnnxEmbedder {
public:
    explicit OnnxEmbedder(
        const std::string& model_path,
        const std::string& vocab_path,
        int                dim           = 384,
        size_t             cache_size    = 512,
        int                batch_wait_ms = 1
    );
    ~OnnxEmbedder();

    // Embed a batch — blocks the calling thread (AsyncWorker::Execute)
    // until the inference thread fulfills the promise.
    // Never call from the Node.js event loop thread directly.
    std::vector<std::vector<float>> embedBatchSync(
        const std::vector<std::string>& texts);

    // Stats for observability
    struct Stats {
        uint64_t requests_processed;  // cache_hits + cache_misses (total work)
        uint64_t batches_run;
        uint64_t cache_hits;
        uint64_t cache_misses;        // OE-7: was misleadingly named stat_requests_
        double   avg_batch_size;
        double   avg_inference_ms;
    };
    Stats getStats() const;

    bool isReady() const { return ready_.load(); }

private:
    // ── ONNX Runtime ──────────────────────────────────────────────────────
    const OrtApi*      ort_api_;
    OrtEnv*            ort_env_      = nullptr;
    OrtSession*        ort_session_  = nullptr;
    OrtSessionOptions* ort_opts_     = nullptr;
    OrtMemoryInfo*     ort_mem_info_ = nullptr;

    int dim_;
    int max_seq_len_ = 512;

    // ── Tokenizer ─────────────────────────────────────────────────────────
    struct Vocab {
        std::unordered_map<std::string, int32_t> token_to_id;
        int32_t cls_id = 101;
        int32_t sep_id = 102;
        int32_t pad_id = 0;
        int32_t unk_id = 100;
    };
    Vocab vocab_;
    void  loadVocab(const std::string& vocab_path);

    TokenizerOutput          tokenize(const std::string& text) const;
    std::vector<std::string> wordpieceTokenize(const std::string& word) const;

    // ── Inference (inference thread only) ────────────────────────────────
    std::vector<float> runInference(const TokenizerOutput& tokens);
    std::vector<float> meanPool(
        const float*                    token_embeddings,
        const std::vector<int64_t>&     attention_mask,
        int                             seq_len);
    static std::vector<float> l2Normalize(const std::vector<float>& v);

    // ── Cache ─────────────────────────────────────────────────────────────
    EmbedCache cache_;

    // ── Inference thread ──────────────────────────────────────────────────
    std::thread              infer_thread_;
    std::mutex               queue_mutex_;
    std::condition_variable  queue_cv_;
    std::queue<EmbedRequest> request_queue_;
    std::atomic<bool>        shutdown_ { false };
    std::atomic<bool>        ready_    { false };
    int                      batch_wait_ms_;

    void inferenceLoop();

    // ── Statistics ────────────────────────────────────────────────────────
    mutable std::mutex stats_mutex_;
    
    // OE-7: Renamed from stat_requests_ — counts cache misses (inference runs).
    // Total requests_processed = stat_cache_hits_ + stat_cache_misses_.
    uint64_t stat_cache_misses_       = 0;
    double   stat_total_inference_ms_ = 0.0;
};

// ─────────────────────────────────────────────
// EmbedAsyncWorker
// Bridges ONNX inference thread → JS Promise.
// Execute() runs on libuv thread pool (safe to block).
// OnOK() resolves the promise back on the event loop.
// ─────────────────────────────────────────────
class EmbedAsyncWorker : public Napi::AsyncWorker {
public:
    EmbedAsyncWorker(
        Napi::Env                env,
        OnnxEmbedder*            embedder,
        std::string              text,
        Napi::Promise::Deferred  deferred);

    void Execute()                        override;
    void OnOK()                           override;
    void OnError(const Napi::Error& err)  override;

private:
    OnnxEmbedder*           embedder_;
    std::string             text_;
    Napi::Promise::Deferred deferred_;
    std::vector<float>      result_;
};

// ─────────────────────────────────────────────
// N-API ObjectWrap
// ─────────────────────────────────────────────
class OnnxEmbedderNAPI : public Napi::ObjectWrap<OnnxEmbedderNAPI> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    explicit OnnxEmbedderNAPI(const Napi::CallbackInfo& info);
    ~OnnxEmbedderNAPI();

private:
    std::unique_ptr<OnnxEmbedder> embedder_;

    Napi::Value Embed(const Napi::CallbackInfo& info);
    Napi::Value EmbedBatch(const Napi::CallbackInfo& info);
    Napi::Value GetStats(const Napi::CallbackInfo& info);
    Napi::Value IsReady(const Napi::CallbackInfo& info);
};

} // namespace contextforge