// Positional weighting implementation — generates a U-shaped importance curve over context blocks.
// Blocks near the start and end of the context receive high weights (preserved), while blocks
// in the middle receive lower weights (candidates for aggressive compression).
// The curve shape is configurable via edgeBoost and middleFloor parameters.

#include "positional.h"
#include <cmath>

namespace contextforge {
namespace positional {

Vec computeWeights(size_t blockCount, double edgeBoost, double middleFloor) {
    // TODO: Implement U-shaped positional weighting curve
    // 1. For each position i in [0, blockCount):
    //    - Compute normalized position: x = i / (blockCount - 1), range [0.0, 1.0]
    //    - Apply U-curve: weight = middleFloor + (edgeBoost - middleFloor) * (2*x - 1)^2
    //    - This gives high weights at x=0 and x=1, low weight at x=0.5
    // 2. Normalize weights to sum to 1.0
    Vec weights(blockCount, 1.0);
    if (blockCount <= 1) return weights;

    for (size_t i = 0; i < blockCount; ++i) {
        double x = static_cast<double>(i) / static_cast<double>(blockCount - 1);
        double centered = 2.0 * x - 1.0; // Maps [0,1] → [-1,1]
        weights[i] = middleFloor + (edgeBoost - middleFloor) * centered * centered;
    }

    // Normalize
    double sum = 0.0;
    for (double w : weights) sum += w;
    if (sum > 0.0) {
        for (double& w : weights) w /= sum;
    }
    return weights;
}

// --- N-API Bindings ---

static Napi::Value ComputePositionalWeights(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected a number argument (blockCount)").ThrowAsJavaScriptException();
        return env.Null();
    }
    size_t blockCount = info[0].As<Napi::Number>().Uint32Value();
    double edgeBoost = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().DoubleValue() : 2.0;
    double middleFloor = info.Length() > 2 && info[2].IsNumber() ? info[2].As<Napi::Number>().DoubleValue() : 0.3;

    auto weights = computeWeights(blockCount, edgeBoost, middleFloor);
    Napi::Array result = Napi::Array::New(env, weights.size());
    for (size_t i = 0; i < weights.size(); ++i) {
        result.Set(i, Napi::Number::New(env, weights[i]));
    }
    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("computePositionalWeights", Napi::Function::New(env, ComputePositionalWeights));
    return exports;
}

} // namespace positional
} // namespace contextforge
