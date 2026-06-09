// Fidelity scorer implementation — compares original and compressed text using cosine similarity
// over term frequency vectors. Acts as the safety valve for the entire compression pipeline.
// If fidelity drops below the configured threshold, compression stages are backed off.

#include "fidelity.h"

namespace contextforge {
namespace fidelity {

double scoreFidelity(const std::string& original, const std::string& compressed) {
    // TODO: Implement fidelity scoring
    // 1. Tokenize both original and compressed text
    // 2. Build a unified vocabulary from both token sets
    // 3. Compute term frequency vectors for both texts
    // 4. Return cosineSimilarity(originalVec, compressedVec)
    // Edge cases:
    //   - If both are empty → return 1.0 (nothing lost)
    //   - If original is empty but compressed isn't → return 0.0
    //   - If compressed is empty → return 0.0 (everything lost)
    if (original.empty() && compressed.empty()) return 1.0;
    if (original.empty() || compressed.empty()) return 0.0;
    return 1.0; // Placeholder — always passes until implemented
}

// --- N-API Bindings ---

static Napi::Value ScoreFidelity(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected (string, string) arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string original = info[0].As<Napi::String>().Utf8Value();
    std::string compressed = info[1].As<Napi::String>().Utf8Value();
    return Napi::Number::New(env, scoreFidelity(original, compressed));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("scoreFidelity", Napi::Function::New(env, ScoreFidelity));
    return exports;
}

} // namespace fidelity
} // namespace contextforge
