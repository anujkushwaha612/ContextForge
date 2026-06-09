#pragma once
#include <string>
#include <vector>
#include <unordered_map>
#include <list>
#include <cstdint>
#include <mutex>

namespace contextforge {

/**
 * EmbedCache — SimHash-keyed LRU cache for embedding vectors.
 *
 * Key insight: we don't need exact text match.
 * SimHash(text) as a 64-bit key means near-duplicate texts
 * (same content, different whitespace) hit the same cache entry.
 *
 * Thread-safe: mutex-protected for access from inference thread
 * and main thread simultaneously.
 */
class EmbedCache {
public:
  explicit EmbedCache(size_t max_entries = 512, int dim = 384);

  // Look up embedding by text. Returns empty vector on miss.
  std::vector<float> get(const std::string& text);

  // Store embedding for text.
  void put(const std::string& text, const std::vector<float>& embedding);

  // Cache statistics
  struct Stats {
    size_t hits;
    size_t misses;
    size_t size;
    size_t capacity;
  };
  Stats stats() const;

  void clear();

private:
  uint64_t computeKey(const std::string& text) const;

  int    dim_;
  size_t max_entries_;
  size_t hits_   = 0;
  size_t misses_ = 0;

  // LRU: list of keys in access order (front = most recent)
  std::list<uint64_t> lru_order_;

  // Map: key → (embedding, iterator into lru_order_)
  struct CacheEntry {
    std::vector<float>            embedding;
    std::list<uint64_t>::iterator lru_it;
  };
  std::unordered_map<uint64_t, CacheEntry> cache_;

  mutable std::mutex mutex_;
};

} // namespace contextforge