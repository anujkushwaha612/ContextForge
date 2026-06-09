// native/src/static_embed.cpp
#include <napi.h>
#include <unordered_map>
#include <vector>
#include <string>
#include <fstream>
#include <sstream>
#include <cmath>
#include <algorithm>
#include <cstring>

// Global embedding store (loaded once at startup)
static std::unordered_map<std::string, std::vector<float>> g_wordVectors;
static size_t g_embeddingDim = 0;
static bool g_loaded = false;

// Helper: Load GloVe text format (e.g., glove.6B.50d.txt)
void loadGloveFromFile(const std::string& filepath) {
    std::ifstream file(filepath);
    if (!file.is_open()) {
        throw std::runtime_error("Failed to open embedding file: " + filepath);
    }

    std::string line;
    size_t lineCount = 0;

    while (std::getline(file, line)) {
        if (line.empty()) continue;

        std::istringstream iss(line);
        std::string word;
        iss >> word;

        std::vector<float> vec;
        float val;
        while (iss >> val) {
            vec.push_back(val);
        }

        if (g_embeddingDim == 0) {
            g_embeddingDim = vec.size();
        } else if (vec.size() != g_embeddingDim) {
            throw std::runtime_error("Inconsistent embedding dimension at word: " + word);
        }

        // Normalize word: lowercase
        std::transform(word.begin(), word.end(), word.begin(), ::tolower);
        g_wordVectors[word] = std::move(vec);
        lineCount++;
    }

    file.close();
    g_loaded = true;
    printf("[StaticEmbed] Loaded %zu words, dim=%zu from %s\n", g_wordVectors.size(), g_embeddingDim, filepath.c_str());
}

// N-API: Initialize the embedding store
Napi::Value LoadStaticEmbeddings(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected filepath string").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string path = info[0].As<Napi::String>().Utf8Value();
    try {
        loadGloveFromFile(path);
        return Napi::Boolean::New(env, true);
    } catch (const std::exception& e) {
        Napi::Error::New(env, std::string("Load failed: ") + e.what()).ThrowAsJavaScriptException();
        return env.Null();
    }
}

// N-API: Compute cosine similarity between two Float32Arrays
Napi::Number CosineSimilarityStatic(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (
        info.Length() < 2 ||
        !info[0].IsTypedArray() ||
        !info[1].IsTypedArray()
    ) {
        Napi::TypeError::New(
            env,
            "Expected two Float32Arrays"
        ).ThrowAsJavaScriptException();

        return Napi::Number::New(env, 0.0);
    }

    Napi::Float32Array arr1 =
        info[0].As<Napi::Float32Array>();

    Napi::Float32Array arr2 =
        info[1].As<Napi::Float32Array>();

    const size_t len1 =
        arr1.ElementLength();

    const size_t len2 =
        arr2.ElementLength();

    if (len1 != len2 || len1 == 0) {
        return Napi::Number::New(env, 0.0);
    }

    const float* a = arr1.Data();
    const float* b = arr2.Data();

    double dot = 0.0;
    double magA = 0.0;
    double magB = 0.0;

    for (size_t i = 0; i < len1; ++i) {
        const double av =
            static_cast<double>(a[i]);

        const double bv =
            static_cast<double>(b[i]);

        dot += av * bv;
        magA += av * av;
        magB += bv * bv;
    }

    if (magA <= 0.0 || magB <= 0.0) {
        return Napi::Number::New(env, 0.0);
    }

    double cosine =
        dot /
        (std::sqrt(magA) *
         std::sqrt(magB));

    cosine =
        std::max(-1.0,
        std::min(1.0, cosine));

    return Napi::Number::New(env, cosine);
}

// Optional: Expose embedding dim
Napi::Number GetEmbeddingDim(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Number::New(env, static_cast<double>(g_embeddingDim));
}

// Optional: Check if loaded
Napi::Boolean IsEmbeddingLoaded(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, g_loaded);
}