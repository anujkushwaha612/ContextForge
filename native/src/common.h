#ifndef CONTEXTFORGE_COMMON_H
#define CONTEXTFORGE_COMMON_H

// Shared types and utility functions used across all ContextForge native modules.
// Provides: string view helpers, vector math operations (dot product, cosine similarity, L2 norm),
// and common type aliases for consistency across the codebase.

#include <napi.h>
#include <vector>
#include <string>
#include <string_view>
#include <cmath>
#include <cstdint>
#include <algorithm>
#include <numeric>
#include <unordered_map>

namespace contextforge {

// Type aliases for readability
using Vec = std::vector<double>;
using TokenList = std::vector<std::string>;

// --- Vector Math Utilities ---

// Computes the dot product of two equal-length vectors
inline double dotProduct(const Vec& a, const Vec& b) {
    double result = 0.0;
    for (size_t i = 0; i < a.size() && i < b.size(); ++i) {
        result += a[i] * b[i];
    }
    return result;
}

// Computes the L2 (Euclidean) norm of a vector
inline double l2Norm(const Vec& v) {
    double sum = 0.0;
    for (double val : v) {
        sum += val * val;
    }
    return std::sqrt(sum);
}

// Computes cosine similarity between two vectors — returns 0.0 if either vector is zero-length
inline double cosineSimilarity(const Vec& a, const Vec& b) {
    double normA = l2Norm(a);
    double normB = l2Norm(b);
    if (normA < 1e-10 || normB < 1e-10) return 0.0;
    return dotProduct(a, b) / (normA * normB);
}

// --- String Utilities ---

// Splits a string into tokens by whitespace
inline TokenList tokenize(const std::string& text) {
    TokenList tokens;
    std::string current;
    for (char c : text) {
        if (std::isspace(static_cast<unsigned char>(c))) {
            if (!current.empty()) {
                tokens.push_back(std::move(current));
                current.clear();
            }
        } else {
            current += c;
        }
    }
    if (!current.empty()) {
        tokens.push_back(std::move(current));
    }
    return tokens;
}

// Generates character n-grams from a string
inline std::vector<std::string> charNgrams(const std::string& text, size_t n) {
    std::vector<std::string> grams;
    if (text.size() < n) return grams;
    grams.reserve(text.size() - n + 1);
    for (size_t i = 0; i <= text.size() - n; ++i) {
        grams.emplace_back(text.substr(i, n));
    }
    return grams;
}

} // namespace contextforge

#endif // CONTEXTFORGE_COMMON_H
