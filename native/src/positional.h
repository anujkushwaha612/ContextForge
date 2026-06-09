#ifndef CONTEXTFORGE_POSITIONAL_H
#define CONTEXTFORGE_POSITIONAL_H

// Positional importance weighting — implements the "lost in the middle" mitigation strategy.
// LLMs attend most to the beginning and end of their context window. This module computes
// decay weights that allow aggressive compression of middle sections while preserving edges.
// Exported to JS: computePositionalWeights(blockCount) → array of weights

#include <napi.h>
#include "common.h"

namespace contextforge {
namespace positional {

// Registers N-API exports: computePositionalWeights
Napi::Object Init(Napi::Env env, Napi::Object exports);

// Core algorithm: generates a weight curve (U-shaped) for blockCount positions — high at edges, low in the middle
Vec computeWeights(size_t blockCount, double edgeBoost = 2.0, double middleFloor = 0.3);

} // namespace positional
} // namespace contextforge

#endif // CONTEXTFORGE_POSITIONAL_H
