#pragma once
#include <napi.h>
#include <string>
#include <vector>
#include <cstdint>

namespace contextforge {

// ─────────────────────────────────────────────
// Core SimHash — FNV-1a 4-grams, 64-bit fingerprint
// ~200x faster than JS crypto.createHash MD5
// ─────────────────────────────────────────────

uint64_t simhash64(const char* text, size_t len);

uint32_t hammingDistance64(uint64_t a, uint64_t b);

// Count unique items using SimHash clustering
uint32_t countUniqueSimhash(
  const std::vector<std::string>& items,
  uint32_t threshold = 3
);

// N-API registration
Napi::Object InitSimHash(Napi::Env env, Napi::Object exports);

} // namespace contextforge