// simhash.cpp
#include "simhash.h"
#include <memory>

namespace contextforge {

static constexpr uint64_t FNV_OFFSET = 0xcbf29ce484222325ULL;
static constexpr uint64_t FNV_PRIME  = 0x100000001b3ULL;

static inline uint64_t fnv1a_4gram(
    unsigned char a, unsigned char b,
    unsigned char c, unsigned char d)
{
    uint64_t h = FNV_OFFSET;
    h ^= a; h *= FNV_PRIME;
    h ^= b; h *= FNV_PRIME;
    h ^= c; h *= FNV_PRIME;
    h ^= d; h *= FNV_PRIME;
    return h;
}

uint64_t simhash64(const char* text, size_t len) {
    int32_t v[64] = {};

    if (len == 0) return 0ULL;

    constexpr size_t STACK_LIMIT = 4096;
    char stack_buf[STACK_LIMIT];

    // SH-2: RAII for heap buffer — no manual delete, exception-safe
    std::unique_ptr<char[]> heap_buf;
    char* lower;

    if (len <= STACK_LIMIT) {
        lower = stack_buf;
    } else {
        heap_buf = std::make_unique<char[]>(len);
        lower    = heap_buf.get();
    }

    // Branchless ASCII lowercase
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)text[i];
        lower[i] = (char)(c + ((c - 'A' < 26u) ? 32u : 0u));
    }

    // SH-1: Handle strings shorter than one 4-gram
    if (len < 4) {
        uint64_t h = FNV_OFFSET;
        for (size_t i = 0; i < len; i++) {
            h ^= (unsigned char)lower[i];
            h *= FNV_PRIME;
        }
        return h;
    }

    // Slide 4-gram window and accumulate bit votes
    const size_t stop = len - 3;
    for (size_t i = 0; i < stop; i++) {
        uint64_t h = fnv1a_4gram(
            (unsigned char)lower[i],
            (unsigned char)lower[i + 1],
            (unsigned char)lower[i + 2],
            (unsigned char)lower[i + 3]);

        for (int b = 0; b < 64; b++) {
            v[b] += ((h >> b) & 1ULL) ? 1 : -1;
        }
    }

    // Condense votes → fingerprint
    uint64_t fingerprint = 0ULL;
    for (int b = 0; b < 64; b++) {
        if (v[b] > 0) fingerprint |= (1ULL << b);
    }

    return fingerprint;
}

uint32_t hammingDistance64(uint64_t a, uint64_t b) {
#if defined(_MSC_VER)
    return (uint32_t)__popcnt64(a ^ b);
#else
    return (uint32_t)__builtin_popcountll(a ^ b);
#endif
}

// ─────────────────────────────────────────────
// N-API bindings — only simhash and hammingDistance
// are called from JS (semanticDedup.js).
// countUniqueSimhash and simhashBatch were registered
// but never called — removed.
// ─────────────────────────────────────────────

static Napi::Value JS_Simhash(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "simhash(text: string)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string text = info[0].As<Napi::String>().Utf8Value();
    uint64_t fp = simhash64(text.data(), text.size());

    // BigInt — JS Number loses precision above 2^53
    return Napi::BigInt::New(env, fp);
}

static Napi::Value JS_HammingDistance(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsBigInt() || !info[1].IsBigInt()) {
        Napi::TypeError::New(env, "hammingDistance(a: BigInt, b: BigInt)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    bool lossless_a, lossless_b;
    uint64_t a = info[0].As<Napi::BigInt>().Uint64Value(&lossless_a);
    uint64_t b = info[1].As<Napi::BigInt>().Uint64Value(&lossless_b);

    return Napi::Number::New(env, hammingDistance64(a, b));
}

Napi::Object InitSimHash(Napi::Env env, Napi::Object exports) {
    exports.Set("simhash",        Napi::Function::New(env, JS_Simhash));
    exports.Set("hammingDistance", Napi::Function::New(env, JS_HammingDistance));
    return exports;
}

} // namespace contextforge