#include "simhash.h"
#include <cctype>
#include <cstring>
#include <algorithm>

namespace contextforge {

// ─────────────────────────────────────────────
// FNV-1a constants (64-bit)
// ─────────────────────────────────────────────
static constexpr uint64_t FNV_OFFSET = 0xcbf29ce484222325ULL;
static constexpr uint64_t FNV_PRIME  = 0x100000001b3ULL;

// ─────────────────────────────────────────────
// Inline FNV-1a over exactly 4 bytes
// No branching, no allocation, no crypto overhead
// ─────────────────────────────────────────────
static inline uint64_t fnv1a_4gram(
  unsigned char a, unsigned char b,
  unsigned char c, unsigned char d
) {
  uint64_t h = FNV_OFFSET;
  h ^= a; h *= FNV_PRIME;
  h ^= b; h *= FNV_PRIME;
  h ^= c; h *= FNV_PRIME;
  h ^= d; h *= FNV_PRIME;
  return h;
}

// ─────────────────────────────────────────────
// simhash64
//
// Algorithm:
//   - Slide a 4-gram window over lowercased bytes
//   - Hash each 4-gram with FNV-1a (64-bit)
//   - Accumulate weighted bit votes into v[64]
//   - Final fingerprint: bit[i] = (v[i] > 0) ? 1 : 0
//
// Complexity: O(n) time, O(1) space (fixed 64-int array on stack)
// ─────────────────────────────────────────────
uint64_t simhash64(const char* text, size_t len) {
  // Stack-allocated vote array — no heap
  int32_t v[64] = {};

  if (len == 0) return 0ULL;

  // Lowercase buffer — reuse stack for small strings, heap for large
  // Threshold: 4KB on stack is safe across all major platforms
  constexpr size_t STACK_LIMIT = 4096;
  char stack_buf[STACK_LIMIT];
  char* lower = nullptr;
  bool heap_alloc = false;

  if (len <= STACK_LIMIT) {
    lower = stack_buf;
  } else {
    lower = new char[len];
    heap_alloc = true;
  }

  // Single-pass lowercase (tolower is branch-heavy; use arithmetic instead)
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)text[i];
    // Branchless ASCII lowercase: if 'A'<=c<='Z', add 32
    lower[i] = (char)(c + ((c - 'A' < 26u) ? 32u : 0u));
  }

  // Slide 4-gram window
  const size_t stop = len >= 4 ? len - 3 : 1;
  for (size_t i = 0; i < stop; i++) {
    uint64_t h = fnv1a_4gram(
      (unsigned char)lower[i],
      (unsigned char)lower[i+1],
      (unsigned char)lower[i+2],
      (unsigned char)lower[i+3]
    );

    // Unrolled bit vote — compiler can auto-vectorize with SIMD
    // We process 64 bits of h across the vote array
    for (int b = 0; b < 64; b++) {
      // Extract bit b from h: if set → +1, else → -1
      v[b] += (h >> b) & 1ULL ? 1 : -1;
    }
  }

  // Condense votes → fingerprint
  uint64_t fingerprint = 0ULL;
  for (int b = 0; b < 64; b++) {
    if (v[b] > 0) {
      fingerprint |= (1ULL << b);
    }
  }

  if (heap_alloc) delete[] lower;
  return fingerprint;
}

// ─────────────────────────────────────────────
// hammingDistance64
// Uses __builtin_popcountll (maps to POPCNT instruction on x86/ARM)
// Single CPU instruction — cannot be faster
// ─────────────────────────────────────────────
uint32_t hammingDistance64(uint64_t a, uint64_t b) {
#if defined(_MSC_VER)
  return (uint32_t)__popcnt64(a ^ b);
#else
  return (uint32_t)__builtin_popcountll(a ^ b);
#endif
}

// ─────────────────────────────────────────────
// countUniqueSimhash
// O(n * clusters) — clusters stays small in practice
// ─────────────────────────────────────────────
uint32_t countUniqueSimhash(
  const std::vector<std::string>& items,
  uint32_t threshold
) {
  if (items.empty()) return 0;

  std::vector<uint64_t> cluster_reps;
  cluster_reps.reserve(items.size()); // worst case: all unique

  for (const auto& item : items) {
    uint64_t fp = simhash64(item.data(), item.size());

    bool matched = false;
    for (uint64_t rep : cluster_reps) {
      if (hammingDistance64(fp, rep) <= threshold) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      cluster_reps.push_back(fp);
    }
  }

  return (uint32_t)cluster_reps.size();
}

// ─────────────────────────────────────────────
// N-API bindings
// ─────────────────────────────────────────────

// native.simhash(text: string) → BigInt
static Napi::Value JS_Simhash(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "simhash(text: string)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string text = info[0].As<Napi::String>().Utf8Value();
  uint64_t fp = simhash64(text.data(), text.size());

  // Return as BigInt — JS Number loses precision above 2^53
  return Napi::BigInt::New(env, fp);
}

// native.hammingDistance(a: BigInt, b: BigInt) → number
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

// native.countUniqueSimhash(items: string[], threshold?: number) → number
static Napi::Value JS_CountUniqueSimhash(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env,
      "countUniqueSimhash(items: string[], threshold?: number)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array arr = info[0].As<Napi::Array>();
  uint32_t threshold = (info.Length() > 1 && info[1].IsNumber())
    ? info[1].As<Napi::Number>().Uint32Value()
    : 3;

  std::vector<std::string> items;
  items.reserve(arr.Length());

  for (uint32_t i = 0; i < arr.Length(); i++) {
    Napi::Value val = arr.Get(i);
    if (val.IsString()) {
      items.push_back(val.As<Napi::String>().Utf8Value());
    } else {
      // Coerce to string via JS toString
      items.push_back(val.ToString().Utf8Value());
    }
  }

  uint32_t result = countUniqueSimhash(items, threshold);
  return Napi::Number::New(env, result);
}

// ─────────────────────────────────────────────
// Batch SimHash — fingerprint entire array at once
// Returns array of BigInt fingerprints
// Avoids N JS→C++ boundary crossings for N items
// ─────────────────────────────────────────────
static Napi::Value JS_SimhashBatch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "simhashBatch(items: string[]) → BigInt[]")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array arr = info[0].As<Napi::Array>();
  uint32_t len = arr.Length();
  Napi::Array out = Napi::Array::New(env, len);

  for (uint32_t i = 0; i < len; i++) {
    std::string text = arr.Get(i).ToString().Utf8Value();
    uint64_t fp = simhash64(text.data(), text.size());
    out.Set(i, Napi::BigInt::New(env, fp));
  }

  return out;
}

Napi::Object InitSimHash(Napi::Env env, Napi::Object exports) {
  exports.Set("simhash",
    Napi::Function::New(env, JS_Simhash));
  exports.Set("hammingDistance",
    Napi::Function::New(env, JS_HammingDistance));
  exports.Set("countUniqueSimhash",
    Napi::Function::New(env, JS_CountUniqueSimhash));
  exports.Set("simhashBatch",
    Napi::Function::New(env, JS_SimhashBatch));
  return exports;
}

} // namespace contextforge