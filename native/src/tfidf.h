#ifndef CONTEXTFORGE_TFIDF_H
#define CONTEXTFORGE_TFIDF_H

#include <napi.h>

// Computes TF-IDF optimized cosine similarity directly from JS typed arrays.
// Expects 3 arguments from JS: queryTF, docTF, idfs (all Float64Arrays).
// Returns a single scalar cosine similarity score clamped between [0, 1].
Napi::Number NativeTfIdfCosine(const Napi::CallbackInfo& info);
    
#endif // CONTEXTFORGE_TFIDF_H
