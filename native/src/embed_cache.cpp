#include "embed_cache.h"
#include <cstring>

namespace contextforge {

// ─────────────────────────────────────────────
// FNV-1a 64-bit hash — same as simhash.cpp
// but applied to full text (not 4-grams)
// for exact-ish text matching
// ─────────────────────────────────────────────
static constexpr uint64_t FNV_OFFSET = 0xcbf29ce484222325ULL;
static constexpr uint64_t FNV_PRIME  = 0x100000001b3ULL;

EmbedCache::EmbedCache(size_t max_entries, int dim)
  : dim_(dim), max_entries_(max_entries) {}

uint64_t EmbedCache::computeKey(const std::string& text) const {
  // Normalize: lowercase, collapse whitespace
  uint64_t h = FNV_OFFSET;
  bool last_was_space = false;

  for (unsigned char c : text) {
    // Lowercase
    if (c >= 'A' && c <= 'Z') c += 32;
    // Collapse whitespace
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
      if (last_was_space) continue;
      last_was_space = true;
      c = ' ';
    } else {
      last_was_space = false;
    }
    h ^= c;
    h *= FNV_PRIME;
  }
  return h;
}

std::vector<float> EmbedCache::get(const std::string& text) {
  std::lock_guard<std::mutex> lock(mutex_);

  uint64_t key = computeKey(text);
  auto it = cache_.find(key);

  if (it == cache_.end()) {
    misses_++;
    return {}; // Cache miss — empty vector
  }

  // Move to front of LRU
  lru_order_.erase(it->second.lru_it);
  lru_order_.push_front(key);
  it->second.lru_it = lru_order_.begin();

  hits_++;
  return it->second.embedding; // Copy — caller owns result
}

void EmbedCache::put(const std::string& text, const std::vector<float>& embedding) {
  std::lock_guard<std::mutex> lock(mutex_);

  uint64_t key = computeKey(text);

  // Update existing entry
  auto it = cache_.find(key);
  if (it != cache_.end()) {
    lru_order_.erase(it->second.lru_it);
    lru_order_.push_front(key);
    it->second.lru_it  = lru_order_.begin();
    it->second.embedding = embedding;
    return;
  }

  // Evict LRU if at capacity
  if (cache_.size() >= max_entries_) {
    uint64_t evict_key = lru_order_.back();
    lru_order_.pop_back();
    cache_.erase(evict_key);
  }

  // Insert new entry
  lru_order_.push_front(key);
  cache_[key] = { embedding, lru_order_.begin() };
}

EmbedCache::Stats EmbedCache::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return { hits_, misses_, cache_.size(), max_entries_ };
}

void EmbedCache::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  cache_.clear();
  lru_order_.clear();
  hits_ = misses_ = 0;
}

} // namespace contextforge