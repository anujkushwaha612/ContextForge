#ifndef CONTEXTFORGE_TOKEN_COUNTER_H
#define CONTEXTFORGE_TOKEN_COUNTER_H

// Fast token counter — estimates token count for a given text without calling an external tokenizer.
// Uses a BPE-aware heuristic that's more accurate than simple word counting.
// Called on every request (multiple times per pipeline stage), so speed is critical.
// Exported to JS: countTokens(text) → number

#include <napi.h>
#include "common.h"

namespace contextforge {
namespace token_counter {

// Registers N-API exports: countTokens
Napi::Object Init(Napi::Env env, Napi::Object exports);

// Core algorithm: estimates token count using BPE-aware heuristics
size_t countTokens(const std::string& text);

} // namespace token_counter
} // namespace contextforge

#endif // CONTEXTFORGE_TOKEN_COUNTER_H
