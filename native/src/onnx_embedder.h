#pragma once

#include <napi.h>
#include <string>
#include <vector>
#include <memory>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <functional>
#include <atomic>
#include <future>

// ONNX Runtime C API — header-only include
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
// Inference request (sits in queue)
// ─────────────────────────────────────────────
struct EmbedRequest {
  std::vector<std::string>          texts;       // batch of texts
  std::promise<std::vector<std::vector<float>>> promise;
};

// ─────────────────────────────────────────────
// OnnxEmbedder
//
// Architecture:
//   - ONNX session created ONCE in constructor
//   - Dedicated inference thread owns the session
//   - JS calls embed() → enqueues request → returns promise
//   - Inference thread processes queue → fulfills promise
//   - 1ms batch accumulation window
//   - LRU embedding cache (SimHash-keyed)
//
// Threading model:
//   Main thread  → enqueues EmbedRequest
//   Infer thread → dequeues, runs ONNX, fulfills promise
//   No ONNX call ever touches the Node.js event loop
// ─────────────────────────────────────────────
class OnnxEmbedder {
public:
  explicit OnnxEmbedder(
    const std::string& model_path,
    const std::string& vocab_path,
    int                dim           = 384,
    size_t             cache_size    = 512,
    int                batch_wait_ms = 1     // accumulation window
  );

  ~OnnxEmbedder();

  // Embed a single text — resolves via inference thread
  // Returns a future; caller awaits via Napi::AsyncWorker
  std::future<std::vector<float>> embedAsync(const std::string& text);

  // Embed a batch synchronously (called FROM inference thread only)
  std::vector<std::vector<float>> embedBatchSync(
    const std::vector<std::string>& texts
  );

  // Stats for observability
  struct Stats {
    uint64_t requests_processed;
    uint64_t batches_run;
    uint64_t cache_hits;
    uint64_t cache_misses;
    double   avg_batch_size;
    double   avg_inference_ms;
  };
  Stats getStats() const;

  // Warm up — run one inference to compile ONNX graph
  void warmup();

  bool isReady() const { return ready_.load(); }

  // N-API registration
  static Napi::Object Init(Napi::Env env, Napi::Object exports);

private:
  // ── ONNX Runtime ──
  const OrtApi*     ort_api_;
  OrtEnv*           ort_env_      = nullptr;
  OrtSession*       ort_session_  = nullptr;
  OrtSessionOptions* ort_opts_    = nullptr;
  OrtMemoryInfo*    ort_mem_info_ = nullptr;

  int    dim_;
  int    max_seq_len_ = 512;  // MiniLM max

  // ── Tokenizer ──
  // WordPiece tokenizer — loaded from tokenizer.json
  struct Vocab {
    std::unordered_map<std::string, int32_t> token_to_id;
    int32_t cls_id   = 101;
    int32_t sep_id   = 102;
    int32_t pad_id   = 0;
    int32_t unk_id   = 100;
  };
  Vocab vocab_;
  void  loadVocab(const std::string& vocab_path);

  // ── Tokenization ──
  TokenizerOutput tokenize(const std::string& text) const;
  std::vector<std::string> wordpieceTokenize(const std::string& word) const;

  // ── Inference ──
  // Called only from inference thread
  std::vector<float> runInference(const TokenizerOutput& tokens);
  std::vector<float> meanPool(
    const float* token_embeddings,
    const std::vector<int64_t>& attention_mask,
    int seq_len
  );
  static std::vector<float> l2Normalize(const std::vector<float>& v);

  // ── Cache ──
  EmbedCache cache_;

  // ── Inference thread ──
  std::thread               infer_thread_;
  std::mutex                queue_mutex_;
  std::condition_variable   queue_cv_;
  std::queue<EmbedRequest>  request_queue_;
  std::atomic<bool>         shutdown_  { false };
  std::atomic<bool>         ready_     { false };

  int batch_wait_ms_;

  void inferenceLoop();  // runs on infer_thread_

  // ── Statistics ──
  mutable std::mutex  stats_mutex_;
  uint64_t stat_requests_  = 0;
  uint64_t stat_batches_   = 0;
  uint64_t stat_cache_hits_ = 0;
  double   stat_total_inference_ms_ = 0.0;

  // ── N-API wrapper methods ──
  Napi::Value JS_Embed(const Napi::CallbackInfo& info);
  Napi::Value JS_EmbedBatch(const Napi::CallbackInfo& info);
  Napi::Value JS_GetStats(const Napi::CallbackInfo& info);
  Napi::Value JS_IsReady(const Napi::CallbackInfo& info);
};

// ─────────────────────────────────────────────
// AsyncWorker: bridges ONNX future → JS Promise
// Runs on libuv thread pool — zero event loop blocking
// ─────────────────────────────────────────────
class EmbedAsyncWorker : public Napi::AsyncWorker {
public:
  EmbedAsyncWorker(
    Napi::Env                          env,
    OnnxEmbedder*                      embedder,
    std::string                        text,
    Napi::Promise::Deferred            deferred
  );

  void Execute() override;
  void OnOK() override;
  void OnError(const Napi::Error& err) override;

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

  // embed(text: string) → Promise<Float32Array>
  Napi::Value Embed(const Napi::CallbackInfo& info);

  // embedBatch(texts: string[]) → Promise<Float32Array[]>
  Napi::Value EmbedBatch(const Napi::CallbackInfo& info);

  // getStats() → object
  Napi::Value GetStats(const Napi::CallbackInfo& info);

  // isReady() → boolean
  Napi::Value IsReady(const Napi::CallbackInfo& info);
};

} // namespace contextforge