// simhash.h
#pragma once
#include <napi.h>
#include <cstdint>

namespace contextforge {

// FNV-1a 64-bit SimHash over 4-grams.
// Used by semanticDedup.js to fingerprint tool result content.
uint64_t simhash64(const char* text, size_t len);

// Hamming distance between two 64-bit fingerprints.
// Maps to a single POPCNT instruction on x86/ARM.
uint32_t hammingDistance64(uint64_t a, uint64_t b);

// N-API registration — exports: simhash, hammingDistance
Napi::Object InitSimHash(Napi::Env env, Napi::Object exports);

} // namespace contextforge