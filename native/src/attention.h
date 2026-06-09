#ifndef CONTEXTFORGE_ATTENTION_H
#define CONTEXTFORGE_ATTENTION_H

// Attention pattern simulator — a single lightweight attention layer (<5M effective parameters)
// that predicts where a larger LLM's attention would focus. Sections receiving <1% attention
// weight are candidates for pruning. This is NOT an LLM — it's a fast linear attention approximation.
// Exported to JS: simulateAttention(query, contextBlocks) → array of {index, weight}

#include <napi.h>
#include "common.h"

namespace contextforge {
namespace attention {

// An attention weight assigned to a context block
struct AttentionWeight {
    size_t index;
    double weight;  // Normalized weight in [0.0, 1.0], all weights sum to 1.0
};

// Registers N-API exports: simulateAttention
Napi::Object Init(Napi::Env env, Napi::Object exports);

// Core algorithm: computes attention weights for each context block relative to the query
std::vector<AttentionWeight> simulateAttention(const std::string& query, const std::vector<std::string>& contextBlocks);

} // namespace attention
} // namespace contextforge

#endif // CONTEXTFORGE_ATTENTION_H
