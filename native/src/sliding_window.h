#ifndef CONTEXTFORGE_SLIDING_WINDOW_H
#define CONTEXTFORGE_SLIDING_WINDOW_H

// Sliding window deduplication — slides a fixed-size token window over long single-document
// contexts, detects repeated segments (common in logs, error traces, CSV data), and returns
// their positions and counts for replacement with summary markers.
// Exported to JS: detectRepeats(text, windowSize, similarityThreshold) → array of repeat regions

#include <napi.h>
#include "common.h"

namespace contextforge {
namespace sliding_window {

// A detected repeated region in the text
struct RepeatRegion {
    size_t startPos;    // Character offset where the repeated region starts
    size_t length;      // Length of the repeated region in characters
    size_t count;       // How many times this region is repeated
};

// Registers N-API exports: detectRepeats
Napi::Object Init(Napi::Env env, Napi::Object exports);

// Core algorithm: slides a window and finds repeated segments above the similarity threshold
std::vector<RepeatRegion> detectRepeats(const std::string& text, size_t windowSize = 256, double similarityThreshold = 0.9);

} // namespace sliding_window
} // namespace contextforge

#endif // CONTEXTFORGE_SLIDING_WINDOW_H
