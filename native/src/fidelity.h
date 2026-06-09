#ifndef CONTEXTFORGE_FIDELITY_H
#define CONTEXTFORGE_FIDELITY_H

// Fidelity scorer — computes a semantic fidelity score (0.0–1.0) measuring how much meaning
// is preserved after compression. Uses cosine similarity between bag-of-words TF vectors
// of the original and compressed text. The default threshold is 0.95 — if compression
// would drop fidelity below this, the pipeline backs off.
// Exported to JS: scoreFidelity(originalText, compressedText) → number

#include <napi.h>
#include "common.h"

namespace contextforge {
namespace fidelity {

// Registers N-API exports: scoreFidelity
Napi::Object Init(Napi::Env env, Napi::Object exports);

// Core algorithm: computes semantic fidelity between original and compressed text
double scoreFidelity(const std::string& original, const std::string& compressed);

} // namespace fidelity
} // namespace contextforge

#endif // CONTEXTFORGE_FIDELITY_H
