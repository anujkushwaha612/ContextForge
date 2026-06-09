#include "onnx_embedder.h"
#include <stdexcept>
#include <algorithm>
#include <cmath>
#include <chrono>
#include <fstream>
#include <sstream>
#include <cassert>
#include <cstring>

// JSON parser for tokenizer.json — use nlohmann/json (header-only)
#include "../vendor/nlohmann/json.hpp"
using json = nlohmann::json;

namespace contextforge
{

    // ─────────────────────────────────────────────
    // Constructor — initializes ONNX, loads vocab,
    // starts inference thread
    // ─────────────────────────────────────────────

    OnnxEmbedder::OnnxEmbedder(
        const std::string &model_path,
        const std::string &vocab_path,
        int dim,
        size_t cache_size,
        int batch_wait_ms) : dim_(dim), cache_(cache_size, dim), batch_wait_ms_(batch_wait_ms)
    {

        // ── ONNX Runtime initialization ──
        ort_api_ = OrtGetApiBase()->GetApi(ORT_API_VERSION);
        if (!ort_api_)
        {
            throw std::runtime_error("[OnnxEmbedder] Failed to get ONNX Runtime API");
        }

        // Create environment (one per process)
        OrtStatus *status = ort_api_->CreateEnv(
            ORT_LOGGING_LEVEL_WARNING,
            "contextforge_embedder",
            &ort_env_);
        if (status)
        {
            std::string msg = ort_api_->GetErrorMessage(status);
            ort_api_->ReleaseStatus(status);
            throw std::runtime_error("[OnnxEmbedder] CreateEnv: " + msg);
        }

        // Session options
        ort_api_->CreateSessionOptions(&ort_opts_);

        // Performance tuning:
        // Inter-op: parallelism between graph nodes → 1 (we batch instead)
        // Intra-op: parallelism within a node → physical cores
        ort_api_->SetInterOpNumThreads(ort_opts_, 1);

        // Detect physical core count for intra-op threads
        int cores = (int)std::thread::hardware_concurrency();
        if (cores <= 0)
            cores = 4;
        // Use half the cores — leave room for Node.js event loop
        // and libuv thread pool. Prevents CPU starvation.
        int intra_threads = std::max(1, cores / 2);
        ort_api_->SetIntraOpNumThreads(ort_opts_, intra_threads);

        // Enable graph optimizations (fold constants, eliminate dead nodes)
        ort_api_->SetSessionGraphOptimizationLevel(
            ort_opts_, ORT_ENABLE_ALL);

        // Memory info for CPU tensors
        ort_api_->CreateCpuMemoryInfo(
            OrtArenaAllocator,
            OrtMemTypeDefault,
            &ort_mem_info_);

// Create session — loads and compiles the ONNX model
// This is the slow part (~200ms) — happens once in constructor
#ifdef _WIN32

        std::wstring w_model_path(
            model_path.begin(),
            model_path.end());

        status = ort_api_->CreateSession(
            ort_env_,
            w_model_path.c_str(),
            ort_opts_,
            &ort_session_);

#else

        status = ort_api_->CreateSession(
            ort_env_,
            model_path.c_str(),
            ort_opts_,
            &ort_session_);

#endif
        if (status)
        {
            std::string msg = ort_api_->GetErrorMessage(status);
            ort_api_->ReleaseStatus(status);
            throw std::runtime_error("[OnnxEmbedder] CreateSession: " + msg);
        }

        fprintf(stderr,
                "[OnnxEmbedder] Session loaded: %s (intra_threads=%d)\n",
                model_path.c_str(), intra_threads);

        // ── Load vocabulary ──
        loadVocab(vocab_path);

        // ── Start inference thread ──
        // This thread owns the ONNX session forever.
        // It never touches the Node.js event loop.
        infer_thread_ = std::thread([this]()
                                    { inferenceLoop(); });

        fprintf(stderr, "[OnnxEmbedder] Inference thread started\n");
    }

    OnnxEmbedder::~OnnxEmbedder()
    {
        // Signal shutdown and wake inference thread
        shutdown_.store(true);
        queue_cv_.notify_all();

        if (infer_thread_.joinable())
        {
            infer_thread_.join();
        }

        // Release ONNX resources
        if (ort_session_)
            ort_api_->ReleaseSession(ort_session_);
        if (ort_opts_)
            ort_api_->ReleaseSessionOptions(ort_opts_);
        if (ort_mem_info_)
            ort_api_->ReleaseMemoryInfo(ort_mem_info_);
        if (ort_env_)
            ort_api_->ReleaseEnv(ort_env_);
    }

    // ─────────────────────────────────────────────
    // Vocab loading — parses tokenizer.json
    // HuggingFace format: {"model": {"vocab": {"[CLS]": 101, ...}}}
    // ─────────────────────────────────────────────

    void OnnxEmbedder::loadVocab(const std::string &vocab_path)
    {
        std::ifstream f(vocab_path);
        if (!f.is_open())
        {
            throw std::runtime_error(
                "[OnnxEmbedder] Cannot open vocab: " + vocab_path);
        }

        json j;
        f >> j;

        // Handle both tokenizer.json and vocab.json formats
        json vocab_map;
        if (j.contains("model") && j["model"].contains("vocab"))
        {
            vocab_map = j["model"]["vocab"];
        }
        else if (j.contains("vocab"))
        {
            vocab_map = j["vocab"];
        }
        else
        {
            // Direct token→id mapping
            vocab_map = j;
        }

        for (auto &[token, id] : vocab_map.items())
        {
            vocab_.token_to_id[token] = id.get<int32_t>();
        }

        // Standard BERT special token IDs
        auto getId = [&](const std::string &tok, int32_t def) -> int32_t
        {
            auto it = vocab_.token_to_id.find(tok);
            return it != vocab_.token_to_id.end() ? it->second : def;
        };

        vocab_.cls_id = getId("[CLS]", 101);
        vocab_.sep_id = getId("[SEP]", 102);
        vocab_.pad_id = getId("[PAD]", 0);
        vocab_.unk_id = getId("[UNK]", 100);

        fprintf(stderr,
                "[OnnxEmbedder] Vocab loaded: %zu tokens\n",
                vocab_.token_to_id.size());
    }

    // ─────────────────────────────────────────────
    // WordPiece tokenization
    // ─────────────────────────────────────────────

    std::vector<std::string> OnnxEmbedder::wordpieceTokenize(
        const std::string &word) const
    {
        // Try full word first
        if (vocab_.token_to_id.count(word))
        {
            return {word};
        }

        // WordPiece: find longest prefix in vocab, remainder becomes "##suffix"
        std::vector<std::string> subwords;
        size_t start = 0;

        while (start < word.size())
        {
            size_t end = word.size();
            std::string prefix = (start > 0) ? "##" : "";
            bool found = false;

            while (end > start)
            {
                std::string candidate = prefix + word.substr(start, end - start);
                if (vocab_.token_to_id.count(candidate))
                {
                    subwords.push_back(candidate);
                    start = end;
                    found = true;
                    break;
                }
                end--;
            }

            if (!found)
            {
                // Unknown — use [UNK] for the whole word
                subwords.clear();
                return {"[UNK]"};
            }
        }

        return subwords;
    }

    TokenizerOutput OnnxEmbedder::tokenize(const std::string &text) const
    {
        TokenizerOutput out;

        // Start with [CLS]
        out.input_ids.push_back(vocab_.cls_id);
        out.attention_mask.push_back(1);
        out.token_type_ids.push_back(0);

        // Lowercase and split on whitespace/punctuation
        std::string lower = text;
        std::transform(lower.begin(), lower.end(), lower.begin(),
                       [](unsigned char c)
                       {
                           // Lowercase ASCII
                           if (c >= 'A' && c <= 'Z')
                               return (unsigned char)(c + 32);
                           // Split punctuation by inserting spaces
                           if (std::ispunct(c))
                               return (unsigned char)' ';
                           return c;
                       });

        // Tokenize words
        std::istringstream ss(lower);
        std::string word;
        while (ss >> word)
        {
            if ((int)out.input_ids.size() >= max_seq_len_ - 1)
                break;

            auto subwords = wordpieceTokenize(word);
            for (const auto &sw : subwords)
            {
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

        // End with [SEP]
        out.input_ids.push_back(vocab_.sep_id);
        out.attention_mask.push_back(1);
        out.token_type_ids.push_back(0);

        return out;
    }

    // ─────────────────────────────────────────────
    // Mean pooling — average token embeddings
    // weighted by attention mask
    // ─────────────────────────────────────────────

    std::vector<float> OnnxEmbedder::meanPool(
        const float *token_embeddings,
        const std::vector<int64_t> &attention_mask,
        int seq_len)
    {
        std::vector<float> pooled(dim_, 0.0f);
        float total_weight = 0.0f;

        for (int i = 0; i < seq_len; i++)
        {
            float weight = (float)attention_mask[i];
            if (weight == 0.0f)
                continue;

            const float *token_vec = token_embeddings + i * dim_;
            for (int j = 0; j < dim_; j++)
            {
                pooled[j] += token_vec[j] * weight;
            }
            total_weight += weight;
        }

        if (total_weight > 0.0f)
        {
            for (int j = 0; j < dim_; j++)
            {
                pooled[j] /= total_weight;
            }
        }

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
    // Runs one tokenized input through ONNX session
    // ─────────────────────────────────────────────

    std::vector<float> OnnxEmbedder::runInference(const TokenizerOutput &tokens)
    {
        int seq_len = (int)tokens.input_ids.size();

        // Tensor shapes: [batch=1, seq_len]
        std::array<int64_t, 2> shape = {1, seq_len};

        // Create input tensors (zero-copy — data owned by tokens)
        OrtValue *input_ids_tensor = nullptr;
        OrtValue *attention_mask_tensor = nullptr;
        OrtValue *token_type_ids_tensor = nullptr;

        ort_api_->CreateTensorWithDataAsOrtValue(
            ort_mem_info_,
            (void *)tokens.input_ids.data(),
            seq_len * sizeof(int64_t),
            shape.data(), 2,
            ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
            &input_ids_tensor);

        ort_api_->CreateTensorWithDataAsOrtValue(
            ort_mem_info_,
            (void *)tokens.attention_mask.data(),
            seq_len * sizeof(int64_t),
            shape.data(), 2,
            ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
            &attention_mask_tensor);

        ort_api_->CreateTensorWithDataAsOrtValue(
            ort_mem_info_,
            (void *)tokens.token_type_ids.data(),
            seq_len * sizeof(int64_t),
            shape.data(), 2,
            ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
            &token_type_ids_tensor);

        // Input/output names for MiniLM
        const char *input_names[] = {"input_ids", "attention_mask", "token_type_ids"};
        const char *output_names[] = {"last_hidden_state"};

        OrtValue *inputs[] = {
            input_ids_tensor,
            attention_mask_tensor,
            token_type_ids_tensor};

        OrtValue *output_tensor = nullptr;

        auto t_start = std::chrono::steady_clock::now();

        OrtStatus *status = ort_api_->Run(
            ort_session_,
            nullptr, // RunOptions
            input_names, inputs, 3,
            output_names, 1,
            &output_tensor);

        auto t_end = std::chrono::steady_clock::now();
        double infer_ms = std::chrono::duration<double, std::milli>(
                              t_end - t_start)
                              .count();

        // Cleanup input tensors
        ort_api_->ReleaseValue(input_ids_tensor);
        ort_api_->ReleaseValue(attention_mask_tensor);
        ort_api_->ReleaseValue(token_type_ids_tensor);

        if (status)
        {
            std::string msg = ort_api_->GetErrorMessage(status);
            ort_api_->ReleaseStatus(status);
            if (output_tensor)
                ort_api_->ReleaseValue(output_tensor);
            throw std::runtime_error("[OnnxEmbedder] Inference failed: " + msg);
        }

        // Extract output: shape [1, seq_len, dim]
        float *output_data = nullptr;
        ort_api_->GetTensorMutableData(output_tensor, (void **)&output_data);

        // Mean pool → L2 normalize
        auto pooled = meanPool(output_data, tokens.attention_mask, seq_len);
        auto normalized = l2Normalize(pooled);

        ort_api_->ReleaseValue(output_tensor);

        // Update stats
        {
            std::lock_guard<std::mutex> lock(stats_mutex_);
            stat_batches_++;
            stat_total_inference_ms_ += infer_ms;
        }

        return normalized;
    }

    // ─────────────────────────────────────────────
    // Inference loop — runs on dedicated thread
    //
    // Design:
    //   1. Wait for requests (condition variable)
    //   2. Drain queue within batch_wait_ms window
    //   3. Separate cached vs uncached texts
    //   4. Run ONNX only on uncached texts
    //   5. Fulfill all promises
    // ─────────────────────────────────────────────

    void OnnxEmbedder::inferenceLoop()
    {
        ready_.store(true);

        while (!shutdown_.load())
        {
            std::vector<EmbedRequest> batch;

            // ── Wait for at least one request ──
            {
                std::unique_lock<std::mutex> lock(queue_mutex_);
                queue_cv_.wait(lock, [this]
                               { return !request_queue_.empty() || shutdown_.load(); });

                if (shutdown_.load() && request_queue_.empty())
                    break;

                // Drain immediately available requests
                while (!request_queue_.empty())
                {
                    batch.push_back(std::move(request_queue_.front()));
                    request_queue_.pop();
                }
            }

            // ── Batch accumulation window ──
            // Wait batch_wait_ms for more requests to arrive
            if (batch_wait_ms_ > 0 && !shutdown_.load())
            {
                auto deadline = std::chrono::steady_clock::now() +
                                std::chrono::milliseconds(batch_wait_ms_);

                while (std::chrono::steady_clock::now() < deadline)
                {
                    std::this_thread::sleep_for(std::chrono::microseconds(100));

                    std::lock_guard<std::mutex> lock(queue_mutex_);
                    while (!request_queue_.empty())
                    {
                        batch.push_back(std::move(request_queue_.front()));
                        request_queue_.pop();
                    }
                }
            }

            if (batch.empty())
                continue;

            // ── Process each request ──
            // Each EmbedRequest may contain multiple texts (batch embed call)
            for (auto &req : batch)
            {
                std::vector<std::vector<float>> results;
                results.reserve(req.texts.size());

                for (const auto &text : req.texts)
                {
                    // Check cache first
                    auto cached = cache_.get(text);
                    if (!cached.empty())
                    {
                        results.push_back(std::move(cached));
                        std::lock_guard<std::mutex> lock(stats_mutex_);
                        stat_cache_hits_++;
                        continue;
                    }

                    // Cache miss — run inference
                    try
                    {
                        auto tokens = tokenize(text);
                        auto embedding = runInference(tokens);

                        // Store in cache
                        cache_.put(text, embedding);

                        results.push_back(std::move(embedding));

                        std::lock_guard<std::mutex> lock(stats_mutex_);
                        stat_requests_++;
                    }
                    catch (const std::exception &e)
                    {
                        // Return zero vector on error — fail open
                        fprintf(stderr, "[OnnxEmbedder] Error: %s\n", e.what());
                        results.push_back(std::vector<float>(dim_, 0.0f));
                    }
                }

                req.promise.set_value(std::move(results));
            }
        }

        fprintf(stderr, "[OnnxEmbedder] Inference thread exiting\n");
    }

    // ─────────────────────────────────────────────
    // embedAsync — called from any thread
    // Enqueues request, returns future
    // ─────────────────────────────────────────────

    std::future<std::vector<float>> OnnxEmbedder::embedAsync(
        const std::string &text)
    {
        // Create a shared promise that the inference thread will fulfill
        auto shared_promise = std::make_shared<
            std::promise<std::vector<float>>>();
        auto future = shared_promise->get_future();

        // Wrap in an EmbedRequest that resolves the outer promise
        EmbedRequest req;
        req.texts = {text};

        // We need a wrapper — inference loop fulfills vector<vector<float>>
        // but embedAsync should return vector<float>
        // Simplest fix: use embedBatchSync wrapper

        return std::async(std::launch::async, [this, text]()
                          {
        auto results = embedBatchSync({text});
        return results.empty() ? std::vector<float>(dim_, 0.0f) : results[0]; });
    }

    // ─────────────────────────────────────────────
    // embedBatchSync — called from AsyncWorker::Execute()
    // (already on libuv thread, not event loop)
    // Posts to inference thread, blocks until done
    // ─────────────────────────────────────────────

    std::vector<std::vector<float>> OnnxEmbedder::embedBatchSync(
        const std::vector<std::string> &texts)
    {
        if (texts.empty())
            return {};

        EmbedRequest req;
        req.texts = texts;
        auto future = req.promise.get_future();

        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            request_queue_.push(std::move(req));
        }
        queue_cv_.notify_one();

        // Block AsyncWorker thread (NOT event loop) until inference completes
        return future.get();
    }

    // ─────────────────────────────────────────────
    // Warmup
    // ─────────────────────────────────────────────

    void OnnxEmbedder::warmup()
    {
        auto results = embedBatchSync({"warmup contextforge embedder"});
        fprintf(stderr,
                "[OnnxEmbedder] Warmup complete (dim=%d)\n",
                dim_);
        ready_.store(true);
    }

    // ─────────────────────────────────────────────
    // Stats
    // ─────────────────────────────────────────────

    OnnxEmbedder::Stats OnnxEmbedder::getStats() const
    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        auto cache_stats = cache_.stats();

        return {
            stat_requests_,
            stat_batches_,
            cache_stats.hits,
            cache_stats.misses,
            stat_batches_ > 0 ? (double)stat_requests_ / stat_batches_ : 0.0,
            stat_batches_ > 0 ? stat_total_inference_ms_ / stat_batches_ : 0.0,
        };
    }

    // ─────────────────────────────────────────────
    // EmbedAsyncWorker
    // Bridges ONNX (inference thread) → JS Promise
    // Execute() runs on libuv thread pool
    // OnOK() runs back on event loop
    // ─────────────────────────────────────────────

    EmbedAsyncWorker::EmbedAsyncWorker(
        Napi::Env env,
        OnnxEmbedder *embedder,
        std::string text,
        Napi::Promise::Deferred deferred) : Napi::AsyncWorker(env),
                                            embedder_(embedder),
                                            text_(std::move(text)),
                                            deferred_(std::move(deferred)) {}

    void EmbedAsyncWorker::Execute()
    {
        // Running on libuv thread pool — safe to block
        auto results = embedder_->embedBatchSync({text_});
        if (!results.empty())
        {
            result_ = std::move(results[0]);
        }
    }

    void EmbedAsyncWorker::OnOK()
    {
        Napi::Env env = Env();

        // Convert to Float32Array — zero copy path
        auto buf = Napi::ArrayBuffer::New(
            env,
            result_.size() * sizeof(float));
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
                                                                   InstanceMethod("embed", &OnnxEmbedderNAPI::Embed),
                                                                   InstanceMethod("embedBatch", &OnnxEmbedderNAPI::EmbedBatch),
                                                                   InstanceMethod("getStats", &OnnxEmbedderNAPI::GetStats),
                                                                   InstanceMethod("isReady", &OnnxEmbedderNAPI::IsReady),
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

        if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString())
        {
            Napi::TypeError::New(env,
                                 "OnnxEmbedder(modelPath: string, vocabPath: string, opts?: object)")
                .ThrowAsJavaScriptException();
            return;
        }

        std::string model_path = info[0].As<Napi::String>().Utf8Value();
        std::string vocab_path = info[1].As<Napi::String>().Utf8Value();

        int dim = 384;
        size_t cache_size = 512;
        int batch_wait_ms = 1;

        if (info.Length() > 2 && info[2].IsObject())
        {
            Napi::Object opts = info[2].As<Napi::Object>();
            if (opts.Has("dim"))
                dim = opts.Get("dim").As<Napi::Number>().Int32Value();
            if (opts.Has("cacheSize"))
                cache_size = opts.Get("cacheSize").As<Napi::Number>().Uint32Value();
            if (opts.Has("batchWaitMs"))
                batch_wait_ms = opts.Get("batchWaitMs").As<Napi::Number>().Int32Value();
        }

        try
        {
            embedder_ = std::make_unique<OnnxEmbedder>(
                model_path, vocab_path, dim, cache_size, batch_wait_ms);
        }
        catch (const std::exception &e)
        {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        }
    }

    OnnxEmbedderNAPI::~OnnxEmbedderNAPI() {}

    // embed(text) → Promise<Float32Array>
    Napi::Value OnnxEmbedderNAPI::Embed(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();

        if (info.Length() < 1 || !info[0].IsString())
        {
            auto deferred = Napi::Promise::Deferred::New(env);
            deferred.Reject(Napi::String::New(env, "embed(text: string)"));
            return deferred.Promise();
        }

        std::string text = info[0].As<Napi::String>().Utf8Value();
        auto deferred = Napi::Promise::Deferred::New(env);

        // AsyncWorker: Execute() on libuv pool → blocks on inference thread
        // OnOK() resolves promise back on event loop
        auto *worker = new EmbedAsyncWorker(env, embedder_.get(), text, deferred);
        worker->Queue();

        return deferred.Promise();
    }

    // embedBatch(texts[]) → Promise<Float32Array[]>
    Napi::Value OnnxEmbedderNAPI::EmbedBatch(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);

        if (info.Length() < 1 || !info[0].IsArray())
        {
            deferred.Reject(Napi::String::New(env, "embedBatch(texts: string[])"));
            return deferred.Promise();
        }

        Napi::Array arr = info[0].As<Napi::Array>();
        std::vector<std::string> texts;
        texts.reserve(arr.Length());
        for (uint32_t i = 0; i < arr.Length(); i++)
        {
            texts.push_back(arr.Get(i).ToString().Utf8Value());
        }

        // Run on AsyncWorker
        struct BatchWorker : public Napi::AsyncWorker
        {
            OnnxEmbedder *embedder;
            std::vector<std::string> texts;
            Napi::Promise::Deferred deferred;
            std::vector<std::vector<float>> results;

            BatchWorker(Napi::Env e, OnnxEmbedder *em,
                        std::vector<std::string> t, Napi::Promise::Deferred d)
                : Napi::AsyncWorker(e), embedder(em),
                  texts(std::move(t)), deferred(std::move(d)) {}

            void Execute() override
            {
                results = embedder->embedBatchSync(texts);
            }

            void OnOK() override
            {
                Napi::Env env = Env();
                Napi::Array out = Napi::Array::New(env, results.size());
                for (size_t i = 0; i < results.size(); i++)
                {
                    auto buf = Napi::ArrayBuffer::New(env, results[i].size() * sizeof(float));
                    std::memcpy(buf.Data(), results[i].data(), results[i].size() * sizeof(float));
                    out.Set((uint32_t)i, Napi::Float32Array::New(env, results[i].size(), buf, 0));
                }
                deferred.Resolve(out);
            }

            void OnError(const Napi::Error &e) override
            {
                deferred.Reject(e.Value());
            }
        };

        auto *worker = new BatchWorker(env, embedder_.get(), std::move(texts), deferred);
        worker->Queue();
        return deferred.Promise();
    }

    Napi::Value OnnxEmbedderNAPI::GetStats(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        auto s = embedder_->getStats();

        Napi::Object obj = Napi::Object::New(env);
        obj.Set("requestsProcessed", Napi::Number::New(env, (double)s.requests_processed));
        obj.Set("batchesRun", Napi::Number::New(env, (double)s.batches_run));
        obj.Set("cacheHits", Napi::Number::New(env, (double)s.cache_hits));
        obj.Set("cacheMisses", Napi::Number::New(env, (double)s.cache_misses));
        obj.Set("avgBatchSize", Napi::Number::New(env, s.avg_batch_size));
        obj.Set("avgInferenceMs", Napi::Number::New(env, s.avg_inference_ms));

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