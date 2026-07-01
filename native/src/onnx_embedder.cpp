#include "onnx_embedder.h"
#include <stdexcept>
#include <algorithm>
#include <cmath>
#include <chrono>
#include <fstream>
#include <sstream>
#include <cassert>
#include <cstring>

#ifdef _WIN32
  #include <windows.h>
#endif

#include "../vendor/nlohmann/json.hpp"
using json = nlohmann::json;

namespace contextforge
{

// ─────────────────────────────────────────────
// RAII guard for OrtValue cleanup
// OE-4: Ensures tensors are released even if
//       an exception is thrown mid-inference.
// ─────────────────────────────────────────────

struct OrtValueGuard {
    const OrtApi* api;
    OrtValue*     val;
    OrtValueGuard(const OrtApi* a, OrtValue* v) : api(a), val(v) {}
    ~OrtValueGuard() { if (val && api) api->ReleaseValue(val); }
    // Non-copyable
    OrtValueGuard(const OrtValueGuard&)            = delete;
    OrtValueGuard& operator=(const OrtValueGuard&) = delete;
};

// ─────────────────────────────────────────────
// Constructor
// ─────────────────────────────────────────────

OnnxEmbedder::OnnxEmbedder(
    const std::string &model_path,
    const std::string &vocab_path,
    int dim,
    size_t cache_size,
    int batch_wait_ms)
    : dim_(dim), cache_(cache_size, dim), batch_wait_ms_(batch_wait_ms)
{
    ort_api_ = OrtGetApiBase()->GetApi(ORT_API_VERSION);
    if (!ort_api_)
        throw std::runtime_error("[OnnxEmbedder] Failed to get ONNX Runtime API");

    OrtStatus *status = ort_api_->CreateEnv(
        ORT_LOGGING_LEVEL_WARNING,
        "contextforge_embedder",
        &ort_env_);
    if (status) {
        std::string msg = ort_api_->GetErrorMessage(status);
        ort_api_->ReleaseStatus(status);
        throw std::runtime_error("[OnnxEmbedder] CreateEnv: " + msg);
    }

    ort_api_->CreateSessionOptions(&ort_opts_);
    ort_api_->SetInterOpNumThreads(ort_opts_, 1);

    int cores        = (int)std::thread::hardware_concurrency();
    if (cores <= 0) cores = 4;
    int intra_threads = std::max(1, cores / 2);
    ort_api_->SetIntraOpNumThreads(ort_opts_, intra_threads);
    ort_api_->SetSessionGraphOptimizationLevel(ort_opts_, ORT_ENABLE_ALL);

    ort_api_->CreateCpuMemoryInfo(
        OrtArenaAllocator,
        OrtMemTypeDefault,
        &ort_mem_info_);

#ifdef _WIN32
    // OE-8: Correct UTF-8 → wide string conversion using Windows API.
    // The old approach (wstring(str.begin(), str.end())) only works for
    // ASCII paths — it misinterprets multi-byte UTF-8 sequences.
    int wlen = MultiByteToWideChar(
        CP_UTF8, 0, model_path.c_str(), -1, nullptr, 0);
    std::wstring w_model_path(wlen, L'\0');
    MultiByteToWideChar(
        CP_UTF8, 0, model_path.c_str(), -1, &w_model_path[0], wlen);

    status = ort_api_->CreateSession(
        ort_env_, w_model_path.c_str(), ort_opts_, &ort_session_);
#else
    status = ort_api_->CreateSession(
        ort_env_, model_path.c_str(), ort_opts_, &ort_session_);
#endif

    if (status) {
        std::string msg = ort_api_->GetErrorMessage(status);
        ort_api_->ReleaseStatus(status);
        throw std::runtime_error("[OnnxEmbedder] CreateSession: " + msg);
    }

    fprintf(stderr,
            "[OnnxEmbedder] Session loaded: %s (intra_threads=%d)\n",
            model_path.c_str(), intra_threads);

    loadVocab(vocab_path);

    infer_thread_ = std::thread([this]() { inferenceLoop(); });
    fprintf(stderr, "[OnnxEmbedder] Inference thread started\n");
}

OnnxEmbedder::~OnnxEmbedder()
{
    shutdown_.store(true);
    queue_cv_.notify_all();

    if (infer_thread_.joinable())
        infer_thread_.join();

    if (ort_session_)   ort_api_->ReleaseSession(ort_session_);
    if (ort_opts_)      ort_api_->ReleaseSessionOptions(ort_opts_);
    if (ort_mem_info_)  ort_api_->ReleaseMemoryInfo(ort_mem_info_);
    if (ort_env_)       ort_api_->ReleaseEnv(ort_env_);
}

// ─────────────────────────────────────────────
// Vocab loading
// ─────────────────────────────────────────────

void OnnxEmbedder::loadVocab(const std::string &vocab_path)
{
    std::ifstream f(vocab_path);
    if (!f.is_open())
        throw std::runtime_error("[OnnxEmbedder] Cannot open vocab: " + vocab_path);

    json j;
    f >> j;

    json vocab_map;
    if (j.contains("model") && j["model"].contains("vocab"))
        vocab_map = j["model"]["vocab"];
    else if (j.contains("vocab"))
        vocab_map = j["vocab"];
    else
        vocab_map = j;

    for (auto &[token, id] : vocab_map.items())
        vocab_.token_to_id[token] = id.get<int32_t>();

    auto getId = [&](const std::string &tok, int32_t def) -> int32_t {
        auto it = vocab_.token_to_id.find(tok);
        return it != vocab_.token_to_id.end() ? it->second : def;
    };

    vocab_.cls_id = getId("[CLS]", 101);
    vocab_.sep_id = getId("[SEP]", 102);
    vocab_.pad_id = getId("[PAD]", 0);
    vocab_.unk_id = getId("[UNK]", 100);

    fprintf(stderr, "[OnnxEmbedder] Vocab loaded: %zu tokens\n",
            vocab_.token_to_id.size());
}

// ─────────────────────────────────────────────
// WordPiece tokenization
// ─────────────────────────────────────────────

std::vector<std::string> OnnxEmbedder::wordpieceTokenize(
    const std::string &word) const
{
    if (vocab_.token_to_id.count(word))
        return {word};

    std::vector<std::string> subwords;
    size_t start = 0;

    while (start < word.size()) {
        size_t end = word.size();
        std::string prefix = (start > 0) ? "##" : "";
        bool found = false;

        while (end > start) {
            std::string candidate = prefix + word.substr(start, end - start);
            if (vocab_.token_to_id.count(candidate)) {
                subwords.push_back(candidate);
                start = end;
                found = true;
                break;
            }
            end--;
        }

        if (!found) {
            subwords.clear();
            return {"[UNK]"};
        }
    }

    return subwords;
}

TokenizerOutput OnnxEmbedder::tokenize(const std::string &text) const
{
    TokenizerOutput out;

    out.input_ids.push_back(vocab_.cls_id);
    out.attention_mask.push_back(1);
    out.token_type_ids.push_back(0);

    std::string lower = text;
    std::transform(lower.begin(), lower.end(), lower.begin(),
        [](unsigned char c) {
            if (c >= 'A' && c <= 'Z') return (unsigned char)(c + 32);
            if (std::ispunct(c))      return (unsigned char)' ';
            return c;
        });

    std::istringstream ss(lower);
    std::string word;
    while (ss >> word) {
        if ((int)out.input_ids.size() >= max_seq_len_ - 1)
            break;

        auto subwords = wordpieceTokenize(word);
        for (const auto &sw : subwords) {
            if ((int)out.input_ids.size() >= max_seq_len_ - 1)
                break;

            auto it = vocab_.token_to_id.find(sw);
            int32_t id = (it != vocab_.token_to_id.end())
                         ? it->second
                         : vocab_.unk_id;

            out.input_ids.push_back(id);
            out.attention_mask.push_back(1);
            out.token_type_ids.push_back(0);
        }
    }

    out.input_ids.push_back(vocab_.sep_id);
    out.attention_mask.push_back(1);
    out.token_type_ids.push_back(0);

    return out;
}

// ─────────────────────────────────────────────
// Mean pooling + L2 normalization
// ─────────────────────────────────────────────

std::vector<float> OnnxEmbedder::meanPool(
    const float *token_embeddings,
    const std::vector<int64_t> &attention_mask,
    int seq_len)
{
    std::vector<float> pooled(dim_, 0.0f);
    float total_weight = 0.0f;

    for (int i = 0; i < seq_len; i++) {
        float weight = (float)attention_mask[i];
        if (weight == 0.0f) continue;

        const float *token_vec = token_embeddings + i * dim_;
        for (int j = 0; j < dim_; j++)
            pooled[j] += token_vec[j] * weight;
        total_weight += weight;
    }

    if (total_weight > 0.0f)
        for (int j = 0; j < dim_; j++)
            pooled[j] /= total_weight;

    return pooled;
}

std::vector<float> OnnxEmbedder::l2Normalize(const std::vector<float> &v)
{
    float norm = 0.0f;
    for (float x : v)
        norm += x * x;
    norm = std::sqrt(norm);

    if (norm < 1e-9f)
        return v;

    std::vector<float> out(v.size());
    for (size_t i = 0; i < v.size(); i++)
        out[i] = v[i] / norm;
    return out;
}

// ─────────────────────────────────────────────
// runInference — called ONLY from inference thread
//
// OE-3: All CreateTensorWithDataAsOrtValue calls now check status.
// OE-4: OrtValueGuard RAII ensures tensors are released even on exception.
// ─────────────────────────────────────────────

std::vector<float> OnnxEmbedder::runInference(const TokenizerOutput &tokens)
{
    int seq_len = (int)tokens.input_ids.size();
    std::array<int64_t, 2> shape = {1, seq_len};

    OrtValue *input_ids_raw      = nullptr;
    OrtValue *attn_mask_raw      = nullptr;
    OrtValue *token_type_ids_raw = nullptr;

    // OE-3: Check status from each tensor creation call
    auto checkStatus = [&](OrtStatus* s, const char* context) {
        if (s) {
            std::string msg = ort_api_->GetErrorMessage(s);
            ort_api_->ReleaseStatus(s);
            throw std::runtime_error(
                std::string("[OnnxEmbedder] ") + context + ": " + msg);
        }
    };

    checkStatus(
        ort_api_->CreateTensorWithDataAsOrtValue(
            ort_mem_info_,
            (void *)tokens.input_ids.data(),
            seq_len * sizeof(int64_t),
            shape.data(), 2,
            ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
            &input_ids_raw),
        "CreateTensor(input_ids)");

    // OE-4: RAII guard — released on scope exit or exception
    OrtValueGuard input_ids_guard(ort_api_, input_ids_raw);

    checkStatus(
        ort_api_->CreateTensorWithDataAsOrtValue(
            ort_mem_info_,
            (void *)tokens.attention_mask.data(),
            seq_len * sizeof(int64_t),
            shape.data(), 2,
            ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
            &attn_mask_raw),
        "CreateTensor(attention_mask)");

    OrtValueGuard attn_mask_guard(ort_api_, attn_mask_raw);

    checkStatus(
        ort_api_->CreateTensorWithDataAsOrtValue(
            ort_mem_info_,
            (void *)tokens.token_type_ids.data(),
            seq_len * sizeof(int64_t),
            shape.data(), 2,
            ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
            &token_type_ids_raw),
        "CreateTensor(token_type_ids)");

    OrtValueGuard token_type_ids_guard(ort_api_, token_type_ids_raw);

    const char *input_names[]  = {"input_ids", "attention_mask", "token_type_ids"};
    const char *output_names[] = {"last_hidden_state"};

    OrtValue *inputs[] = {input_ids_raw, attn_mask_raw, token_type_ids_raw};

    OrtValue *output_tensor = nullptr;

    auto t_start = std::chrono::steady_clock::now();

    OrtStatus *status = ort_api_->Run(
        ort_session_,
        nullptr,
        input_names, inputs, 3,
        output_names, 1,
        &output_tensor);

    auto t_end    = std::chrono::steady_clock::now();
    double infer_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();

    // Input guards release automatically here (before we process output)

    if (status) {
        std::string msg = ort_api_->GetErrorMessage(status);
        ort_api_->ReleaseStatus(status);
        if (output_tensor) ort_api_->ReleaseValue(output_tensor);
        throw std::runtime_error("[OnnxEmbedder] Inference failed: " + msg);
    }

    OrtValueGuard output_guard(ort_api_, output_tensor);

    float *output_data = nullptr;
    ort_api_->GetTensorMutableData(output_tensor, (void **)&output_data);

    auto pooled     = meanPool(output_data, tokens.attention_mask, seq_len);
    auto normalized = l2Normalize(pooled);

    // Update stats — output_guard releases output_tensor on exit
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stat_batches_++;
        stat_total_inference_ms_ += infer_ms;
    }

    return normalized;
}

// ─────────────────────────────────────────────
// Inference loop — dedicated thread
//
// OE-6: Batch accumulation window uses condition variable wait_until
//       instead of busy-wait sleep_for(100µs) loop. Eliminates CPU
//       waste and mutex contention during the accumulation window.
// ─────────────────────────────────────────────

void OnnxEmbedder::inferenceLoop()
{
    ready_.store(true);

    while (!shutdown_.load())
    {
        std::vector<EmbedRequest> batch;

        // Wait for at least one request
        {
            std::unique_lock<std::mutex> lock(queue_mutex_);
            queue_cv_.wait(lock, [this] {
                return !request_queue_.empty() || shutdown_.load();
            });

            if (shutdown_.load() && request_queue_.empty())
                break;

            while (!request_queue_.empty()) {
                batch.push_back(std::move(request_queue_.front()));
                request_queue_.pop();
            }
        }

        // OE-6: Accumulation window using wait_until — sleeps until
        // new request arrives OR deadline passes. No busy-wait.
        if (batch_wait_ms_ > 0 && !shutdown_.load())
        {
            auto deadline = std::chrono::steady_clock::now() +
                            std::chrono::milliseconds(batch_wait_ms_);

            std::unique_lock<std::mutex> lock(queue_mutex_);
            queue_cv_.wait_until(lock, deadline, [this] {
                return !request_queue_.empty() || shutdown_.load();
            });

            while (!request_queue_.empty()) {
                batch.push_back(std::move(request_queue_.front()));
                request_queue_.pop();
            }
        }

        if (batch.empty())
            continue;

        for (auto &req : batch)
        {
            std::vector<std::vector<float>> results;
            results.reserve(req.texts.size());

            for (const auto &text : req.texts)
            {
                auto cached = cache_.get(text);
                if (!cached.empty()) {
                    results.push_back(std::move(cached));
                    std::lock_guard<std::mutex> lock(stats_mutex_);
                    continue;
                }

                try {
                    auto tokens    = tokenize(text);
                    auto embedding = runInference(tokens);
                    cache_.put(text, embedding);
                    results.push_back(std::move(embedding));

                    // OE-7: stat_cache_misses_ accurately named
                    std::lock_guard<std::mutex> lock(stats_mutex_);
                } catch (const std::exception &e) {
                    fprintf(stderr, "[OnnxEmbedder] Error: %s\n", e.what());
                    results.push_back(std::vector<float>(dim_, 0.0f));
                }
            }

            req.promise.set_value(std::move(results));
        }
    }

    fprintf(stderr, "[OnnxEmbedder] Inference thread exiting\n");
}

// OE-1: embedAsync removed — was dead code.
// NAPI Embed/EmbedBatch use AsyncWorker → embedBatchSync directly.
// If a C++ async API is needed in future, implement it here without
// spawning a throwaway thread via std::async.

// ─────────────────────────────────────────────
// embedBatchSync — called from AsyncWorker::Execute()
// ─────────────────────────────────────────────

std::vector<std::vector<float>> OnnxEmbedder::embedBatchSync(
    const std::vector<std::string> &texts)
{
    if (texts.empty())
        return {};

    EmbedRequest req;
    req.texts  = texts;
    auto future = req.promise.get_future();

    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        request_queue_.push(std::move(req));
    }
    queue_cv_.notify_one();

    return future.get();
}

// OE-2: warmup() C++ method removed — dead code.
// JS-side warmup happens through Embed("warmup") via NAPI.

// ─────────────────────────────────────────────
// Stats
//
// OE-7: stat_cache_misses_ replaces misleadingly-named stat_requests_.
//       requests_processed = cache_hits + cache_misses (total work done).
// ─────────────────────────────────────────────

OnnxEmbedder::Stats OnnxEmbedder::getStats() const
{
    std::lock_guard<std::mutex> lock(stats_mutex_);
    auto cache_stats = cache_.stats();

    size_t total_requests = cache_stats.hits + cache_stats.misses;

    return {
        total_requests,                                              // requests_processed
        stat_batches_,                                               // batches_run
        cache_stats.hits,                                            // cache_hits
        cache_stats.misses,                                          // cache_misses
        stat_batches_ > 0
            ? (double)total_requests / stat_batches_
            : 0.0,                                                   // avg_batch_size
        stat_batches_ > 0
            ? stat_total_inference_ms_ / stat_batches_
            : 0.0,                                                   // avg_inference_ms
    };
}

// ─────────────────────────────────────────────
// EmbedAsyncWorker
// ─────────────────────────────────────────────

EmbedAsyncWorker::EmbedAsyncWorker(
    Napi::Env env,
    OnnxEmbedder *embedder,
    std::string text,
    Napi::Promise::Deferred deferred)
    : Napi::AsyncWorker(env),
      embedder_(embedder),
      text_(std::move(text)),
      deferred_(std::move(deferred)) {}

void EmbedAsyncWorker::Execute()
{
    auto results = embedder_->embedBatchSync({text_});
    if (!results.empty())
        result_ = std::move(results[0]);
}

void EmbedAsyncWorker::OnOK()
{
    Napi::Env env = Env();
    auto buf = Napi::ArrayBuffer::New(env, result_.size() * sizeof(float));
    std::memcpy(buf.Data(), result_.data(), result_.size() * sizeof(float));
    auto arr = Napi::Float32Array::New(env, result_.size(), buf, 0);
    deferred_.Resolve(arr);
}

void EmbedAsyncWorker::OnError(const Napi::Error &err)
{
    deferred_.Reject(err.Value());
}

// ─────────────────────────────────────────────
// N-API ObjectWrap
// ─────────────────────────────────────────────

Napi::Object OnnxEmbedderNAPI::Init(Napi::Env env, Napi::Object exports)
{
    Napi::Function func = DefineClass(env, "OnnxEmbedder", {
        InstanceMethod("embed",      &OnnxEmbedderNAPI::Embed),
        InstanceMethod("embedBatch", &OnnxEmbedderNAPI::EmbedBatch),
        InstanceMethod("getStats",   &OnnxEmbedderNAPI::GetStats),
        InstanceMethod("isReady",    &OnnxEmbedderNAPI::IsReady),
    });

    Napi::FunctionReference *ctor = new Napi::FunctionReference();
    *ctor = Napi::Persistent(func);
    env.SetInstanceData(ctor);
    exports.Set("OnnxEmbedder", func);
    return exports;
}

OnnxEmbedderNAPI::OnnxEmbedderNAPI(const Napi::CallbackInfo &info)
    : Napi::ObjectWrap<OnnxEmbedderNAPI>(info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env,
            "OnnxEmbedder(modelPath: string, vocabPath: string, opts?: object)")
            .ThrowAsJavaScriptException();
        return;
    }

    std::string model_path = info[0].As<Napi::String>().Utf8Value();
    std::string vocab_path = info[1].As<Napi::String>().Utf8Value();

    int    dim           = 384;
    size_t cache_size    = 512;
    int    batch_wait_ms = 1;

    if (info.Length() > 2 && info[2].IsObject()) {
        Napi::Object opts = info[2].As<Napi::Object>();
        if (opts.Has("dim"))         dim           = opts.Get("dim").As<Napi::Number>().Int32Value();
        if (opts.Has("cacheSize"))   cache_size    = opts.Get("cacheSize").As<Napi::Number>().Uint32Value();
        if (opts.Has("batchWaitMs")) batch_wait_ms = opts.Get("batchWaitMs").As<Napi::Number>().Int32Value();
    }

    try {
        embedder_ = std::make_unique<OnnxEmbedder>(
            model_path, vocab_path, dim, cache_size, batch_wait_ms);
    } catch (const std::exception &e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    }
}

OnnxEmbedderNAPI::~OnnxEmbedderNAPI() {}

Napi::Value OnnxEmbedderNAPI::Embed(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        auto deferred = Napi::Promise::Deferred::New(env);
        deferred.Reject(Napi::String::New(env, "embed(text: string)"));
        return deferred.Promise();
    }

    std::string text     = info[0].As<Napi::String>().Utf8Value();
    auto        deferred = Napi::Promise::Deferred::New(env);

    auto *worker = new EmbedAsyncWorker(env, embedder_.get(), text, deferred);
    worker->Queue();

    return deferred.Promise();
}

Napi::Value OnnxEmbedderNAPI::EmbedBatch(const Napi::CallbackInfo &info)
{
    Napi::Env env      = info.Env();
    auto      deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 1 || !info[0].IsArray()) {
        deferred.Reject(Napi::String::New(env, "embedBatch(texts: string[])"));
        return deferred.Promise();
    }

    Napi::Array arr = info[0].As<Napi::Array>();
    std::vector<std::string> texts;
    texts.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); i++)
        texts.push_back(arr.Get(i).ToString().Utf8Value());

    struct BatchWorker : public Napi::AsyncWorker {
        OnnxEmbedder*                   embedder;
        std::vector<std::string>        texts;
        Napi::Promise::Deferred         deferred;
        std::vector<std::vector<float>> results;

        BatchWorker(Napi::Env e, OnnxEmbedder* em,
                    std::vector<std::string> t, Napi::Promise::Deferred d)
            : Napi::AsyncWorker(e), embedder(em),
              texts(std::move(t)), deferred(std::move(d)) {}

        void Execute() override {
            results = embedder->embedBatchSync(texts);
        }

        void OnOK() override {
            Napi::Env   env = Env();
            Napi::Array out = Napi::Array::New(env, results.size());
            for (size_t i = 0; i < results.size(); i++) {
                auto buf = Napi::ArrayBuffer::New(env, results[i].size() * sizeof(float));
                std::memcpy(buf.Data(), results[i].data(), results[i].size() * sizeof(float));
                out.Set((uint32_t)i,
                    Napi::Float32Array::New(env, results[i].size(), buf, 0));
            }
            deferred.Resolve(out);
        }

        void OnError(const Napi::Error &err) override {
            deferred.Reject(err.Value());
        }
    };

    auto *worker = new BatchWorker(env, embedder_.get(), std::move(texts), deferred);
    worker->Queue();
    return deferred.Promise();
}

Napi::Value OnnxEmbedderNAPI::GetStats(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    auto      s   = embedder_->getStats();

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("requestsProcessed", Napi::Number::New(env, (double)s.requests_processed));
    obj.Set("batchesRun",        Napi::Number::New(env, (double)s.batches_run));
    obj.Set("cacheHits",         Napi::Number::New(env, (double)s.cache_hits));
    obj.Set("cacheMisses",       Napi::Number::New(env, (double)s.cache_misses));
    obj.Set("avgBatchSize",      Napi::Number::New(env, s.avg_batch_size));
    obj.Set("avgInferenceMs",    Napi::Number::New(env, s.avg_inference_ms));

    double hit_rate = (s.cache_hits + s.cache_misses) > 0
        ? (double)s.cache_hits / (s.cache_hits + s.cache_misses)
        : 0.0;
    obj.Set("cacheHitRate", Napi::Number::New(env, hit_rate));

    return obj;
}

Napi::Value OnnxEmbedderNAPI::IsReady(const Napi::CallbackInfo &info)
{
    return Napi::Boolean::New(info.Env(), embedder_->isReady());
}

} // namespace contextforge