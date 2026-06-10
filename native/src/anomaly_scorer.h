// native/src/anomaly_scorer.h
#pragma once

#include <napi.h>
#include <vector>
#include <cstdint>
#include <cmath>
#include <algorithm>
#include <numeric>

namespace contextforge {

// ─────────────────────────────────────────────
// Descriptive statistics over a float array
// All computed in a single O(n) pass (except IQR which needs sort)
// ─────────────────────────────────────────────

struct FieldStats {
  double mean;
  double stddev;
  double min;
  double max;
  double p25;    // 25th percentile
  double p75;    // 75th percentile
  double iqr;    // p75 - p25
  size_t count;  // number of valid (non-NaN) values
};

FieldStats computeStats(const std::vector<double>& values);

// Z-score for each value: (v - mean) / std
// Returns empty vector if std == 0
std::vector<double> computeZScores(
  const std::vector<double>& values,
  const FieldStats& stats
);

// CUSUM changepoint detection
// Returns indices where a distributional shift was detected
// threshold: sensitivity (default 3.0 = detect 3-sigma shifts)
std::vector<size_t> detectChangepoints(
  const std::vector<double>& values,
  double threshold
);

// Master anomaly detector — combines z-score + IQR + changepoints
// Returns set of indices flagged as anomalous
// z_threshold: flag if |z| > z_threshold (default 2.0)
// iqr_multiplier: flag if value > p75 + multiplier*IQR or < p25 - multiplier*IQR
std::vector<size_t> detectAnomalies(
  const std::vector<double>& values,
  double z_threshold,
  double iqr_multiplier
);

// N-API registration
Napi::Object InitAnomalyScorer(Napi::Env env, Napi::Object exports);

} // namespace contextforge