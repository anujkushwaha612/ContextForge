// native/src/anomaly_scorer.cpp
#include "anomaly_scorer.h"
#include <stdexcept>
#include <unordered_set>

namespace contextforge {

// ─────────────────────────────────────────────
// computeStats
// Single pass for mean + variance (Welford's algorithm)
// Second pass for percentiles (requires sort — unavoidable)
// Total: O(n log n) due to sort, O(n) everything else
// ─────────────────────────────────────────────

FieldStats computeStats(const std::vector<double>& values) {
  FieldStats stats{};

  if (values.empty()) return stats;

  // Filter NaN/Inf — don't corrupt the statistics
  std::vector<double> valid;
  valid.reserve(values.size());
  for (double v : values) {
    if (std::isfinite(v)) valid.push_back(v);
  }

  stats.count = valid.size();
  if (valid.empty()) return stats;

  // ── Welford's online mean + variance (numerically stable) ──
  double mean = 0.0;
  double M2   = 0.0;  // sum of squared deviations

  for (size_t i = 0; i < valid.size(); i++) {
    double delta  = valid[i] - mean;
    mean         += delta / static_cast<double>(i + 1);
    double delta2 = valid[i] - mean;
    M2           += delta * delta2;
  }

  stats.mean   = mean;
  stats.stddev = valid.size() > 1
    ? std::sqrt(M2 / static_cast<double>(valid.size() - 1))  // sample std
    : 0.0;

  // ── Min / Max ──
  auto [minIt, maxIt] = std::minmax_element(valid.begin(), valid.end());
  stats.min = *minIt;
  stats.max = *maxIt;

  // ── Percentiles (requires sort) ──
  std::vector<double> sorted = valid;
  std::sort(sorted.begin(), sorted.end());

  auto percentile = [&](double p) -> double {
    if (sorted.size() == 1) return sorted[0];
    double idx = p * static_cast<double>(sorted.size() - 1);
    size_t lo  = static_cast<size_t>(idx);
    size_t hi  = lo + 1;
    if (hi >= sorted.size()) return sorted[lo];
    double frac = idx - static_cast<double>(lo);
    return sorted[lo] * (1.0 - frac) + sorted[hi] * frac;
  };

  stats.p25 = percentile(0.25);
  stats.p75 = percentile(0.75);
  stats.iqr = stats.p75 - stats.p25;

  return stats;
}

// ─────────────────────────────────────────────
// computeZScores
// Returns z-score per value: (v - mean) / std
// NaN/Inf values get z-score of 0.0 (treated as normal)
// ─────────────────────────────────────────────

std::vector<double> computeZScores(
  const std::vector<double>& values,
  const FieldStats& stats
) {
  std::vector<double> zscores(values.size(), 0.0);

  if (stats.stddev < 1e-10) {
    // Zero variance — all values identical, no anomalies possible
    return zscores;
  }

  for (size_t i = 0; i < values.size(); i++) {
    if (std::isfinite(values[i])) {
      zscores[i] = (values[i] - stats.mean) / stats.stddev;
    }
  }

  return zscores;
}

// ─────────────────────────────────────────────
// detectChangepoints — CUSUM algorithm
//
// CUSUM tracks cumulative sum of deviations from mean.
// A changepoint occurs when the cumulative sum exceeds a threshold,
// indicating the distribution has shifted.
//
// This catches cases where an API starts returning different values
// mid-array — e.g. latency spikes after index 200 in a 500-item array.
//
// Returns indices of detected changepoints (not anomalous items —
// caller uses these to expand context around the shift)
// ─────────────────────────────────────────────

std::vector<size_t> detectChangepoints(
  const std::vector<double>& values,
  double threshold
) {
  std::vector<size_t> changepoints;

  if (values.size() < 10) return changepoints;  // too small for CUSUM

  // Filter to finite values, track original indices
  std::vector<std::pair<size_t, double>> finite_vals;
  finite_vals.reserve(values.size());
  for (size_t i = 0; i < values.size(); i++) {
    if (std::isfinite(values[i])) {
      finite_vals.emplace_back(i, values[i]);
    }
  }

  if (finite_vals.size() < 10) return changepoints;

  // Compute mean of first half as the "expected" baseline
  size_t half = finite_vals.size() / 2;
  double baseline = 0.0;
  for (size_t i = 0; i < half; i++) {
    baseline += finite_vals[i].second;
  }
  baseline /= static_cast<double>(half);

  // CUSUM: accumulate deviations, reset on sign change
  double cusum_pos = 0.0;  // cumulative positive deviation
  double cusum_neg = 0.0;  // cumulative negative deviation
  double slack     = 0.5;  // allowance before counting deviation

  // Estimate scale from data range
  double range = 0.0;
  for (auto& [idx, v] : finite_vals) {
    range = std::max(range, std::abs(v - baseline));
  }
  if (range < 1e-10) return changepoints;  // constant array

  const double scale = range;

  for (auto& [orig_idx, v] : finite_vals) {
    double normalized = (v - baseline) / scale;
    cusum_pos = std::max(0.0, cusum_pos + normalized - slack);
    cusum_neg = std::max(0.0, cusum_neg - normalized - slack);

    if (cusum_pos > threshold || cusum_neg > threshold) {
      changepoints.push_back(orig_idx);
      // Reset after detecting changepoint
      cusum_pos = 0.0;
      cusum_neg = 0.0;
      // Update baseline to new level (adaptive CUSUM)
      baseline = v;
    }
  }

  return changepoints;
}

// ─────────────────────────────────────────────
// detectAnomalies — master function
//
// Combines three detection methods:
//   1. Z-score: flags values > z_threshold standard deviations from mean
//   2. IQR fence: flags values outside [p25 - k*IQR, p75 + k*IQR]
//   3. CUSUM changepoints: flags items at distribution shift boundaries
//
// Union of all three → final anomaly set
// ─────────────────────────────────────────────

std::vector<size_t> detectAnomalies(
  const std::vector<double>& values,
  double z_threshold,
  double iqr_multiplier
) {
  std::unordered_set<size_t> anomaly_set;

  if (values.size() < 5) {
    // Too few items for meaningful statistics
    return {};
  }

  const FieldStats stats = computeStats(values);

  if (stats.count < 5) return {};

  // ── Method 1: Z-score ──
  const auto zscores = computeZScores(values, stats);
  for (size_t i = 0; i < zscores.size(); i++) {
    if (std::abs(zscores[i]) > z_threshold) {
      anomaly_set.insert(i);
    }
  }

  // ── Method 2: IQR fence ──
  // Only meaningful when IQR > 0 (distribution has spread)
  if (stats.iqr > 1e-10) {
    const double lower_fence = stats.p25 - iqr_multiplier * stats.iqr;
    const double upper_fence = stats.p75 + iqr_multiplier * stats.iqr;

    for (size_t i = 0; i < values.size(); i++) {
      if (!std::isfinite(values[i])) continue;
      if (values[i] < lower_fence || values[i] > upper_fence) {
        anomaly_set.insert(i);
      }
    }
  }

  // ── Method 3: CUSUM changepoints ──
  // threshold=3.0: detect 3-sigma shifts in running distribution
  const auto changepoints = detectChangepoints(values, 3.0);
  for (size_t cp : changepoints) {
    // Flag the changepoint and its immediate neighbors
    anomaly_set.insert(cp);
    if (cp > 0)                    anomaly_set.insert(cp - 1);
    if (cp + 1 < values.size())   anomaly_set.insert(cp + 1);
  }

  // Convert set to sorted vector
  std::vector<size_t> result(anomaly_set.begin(), anomaly_set.end());
  std::sort(result.begin(), result.end());
  return result;
}

// ─────────────────────────────────────────────
// N-API bindings
// ─────────────────────────────────────────────

// native.computeFieldStats(values: number[]) → FieldStats object
static Napi::Value JS_ComputeFieldStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "computeFieldStats(values: number[])")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array arr = info[0].As<Napi::Array>();
  std::vector<double> values;
  values.reserve(arr.Length());

  for (uint32_t i = 0; i < arr.Length(); i++) {
    Napi::Value v = arr.Get(i);
    if (v.IsNumber()) {
      values.push_back(v.As<Napi::Number>().DoubleValue());
    } else {
      values.push_back(std::numeric_limits<double>::quiet_NaN());
    }
  }

  const FieldStats stats = computeStats(values);

  Napi::Object result = Napi::Object::New(env);
  result.Set("mean",   Napi::Number::New(env, stats.mean));
  result.Set("stddev", Napi::Number::New(env, stats.stddev));
  result.Set("min",    Napi::Number::New(env, stats.min));
  result.Set("max",    Napi::Number::New(env, stats.max));
  result.Set("p25",    Napi::Number::New(env, stats.p25));
  result.Set("p75",    Napi::Number::New(env, stats.p75));
  result.Set("iqr",    Napi::Number::New(env, stats.iqr));
  result.Set("count",  Napi::Number::New(env, static_cast<double>(stats.count)));

  return result;
}

// native.detectAnomalies(values: number[], zThreshold?: number, iqrMultiplier?: number)
//   → number[]  (indices of anomalous items)
static Napi::Value JS_DetectAnomalies(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "detectAnomalies(values: number[], zThreshold?, iqrMultiplier?)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array arr = info[0].As<Napi::Array>();
  std::vector<double> values;
  values.reserve(arr.Length());

  for (uint32_t i = 0; i < arr.Length(); i++) {
    Napi::Value v = arr.Get(i);
    values.push_back(v.IsNumber()
      ? v.As<Napi::Number>().DoubleValue()
      : std::numeric_limits<double>::quiet_NaN()
    );
  }

  const double z_threshold    = (info.Length() > 1 && info[1].IsNumber())
    ? info[1].As<Napi::Number>().DoubleValue() : 2.0;
  const double iqr_multiplier = (info.Length() > 2 && info[2].IsNumber())
    ? info[2].As<Napi::Number>().DoubleValue() : 1.5;

  const auto anomalies = detectAnomalies(values, z_threshold, iqr_multiplier);

  Napi::Array result = Napi::Array::New(env, anomalies.size());
  for (size_t i = 0; i < anomalies.size(); i++) {
    result.Set(static_cast<uint32_t>(i),
      Napi::Number::New(env, static_cast<double>(anomalies[i])));
  }

  return result;
}

// native.detectChangepoints(values: number[], threshold?: number) → number[]
static Napi::Value JS_DetectChangepoints(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "detectChangepoints(values: number[], threshold?)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array arr = info[0].As<Napi::Array>();
  std::vector<double> values;
  values.reserve(arr.Length());

  for (uint32_t i = 0; i < arr.Length(); i++) {
    Napi::Value v = arr.Get(i);
    values.push_back(v.IsNumber()
      ? v.As<Napi::Number>().DoubleValue()
      : std::numeric_limits<double>::quiet_NaN()
    );
  }

  const double threshold = (info.Length() > 1 && info[1].IsNumber())
    ? info[1].As<Napi::Number>().DoubleValue() : 3.0;

  const auto changepoints = detectChangepoints(values, threshold);

  Napi::Array result = Napi::Array::New(env, changepoints.size());
  for (size_t i = 0; i < changepoints.size(); i++) {
    result.Set(static_cast<uint32_t>(i),
      Napi::Number::New(env, static_cast<double>(changepoints[i])));
  }

  return result;
}

// Batch variant: process multiple fields in one C++ call
// Input: { fieldName: number[] } object
// Output: { fieldName: { anomalyIndices: number[], stats: FieldStats } }
static Napi::Value JS_DetectAnomaliesBatch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env,
      "detectAnomaliesBatch(fields: {[name]: number[]}, zThreshold?, iqrMultiplier?)")
      .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const double z_threshold    = (info.Length() > 1 && info[1].IsNumber())
    ? info[1].As<Napi::Number>().DoubleValue() : 2.0;
  const double iqr_multiplier = (info.Length() > 2 && info[2].IsNumber())
    ? info[2].As<Napi::Number>().DoubleValue() : 1.5;

  Napi::Object fields_obj = info[0].As<Napi::Object>();
  Napi::Array  field_names = fields_obj.GetPropertyNames();

  Napi::Object result = Napi::Object::New(env);

  for (uint32_t fi = 0; fi < field_names.Length(); fi++) {
    std::string field_name = field_names.Get(fi).As<Napi::String>().Utf8Value();
    Napi::Value field_val  = fields_obj.Get(field_name);

    if (!field_val.IsArray()) continue;

    Napi::Array arr = field_val.As<Napi::Array>();
    std::vector<double> values;
    values.reserve(arr.Length());

    for (uint32_t i = 0; i < arr.Length(); i++) {
      Napi::Value v = arr.Get(i);
      values.push_back(v.IsNumber()
        ? v.As<Napi::Number>().DoubleValue()
        : std::numeric_limits<double>::quiet_NaN()
      );
    }

    // Compute stats
    const FieldStats stats     = computeStats(values);
    const auto anomaly_indices = detectAnomalies(values, z_threshold, iqr_multiplier);

    // Build stats object
    Napi::Object stats_obj = Napi::Object::New(env);
    stats_obj.Set("mean",   Napi::Number::New(env, stats.mean));
    stats_obj.Set("stddev", Napi::Number::New(env, stats.stddev));
    stats_obj.Set("min",    Napi::Number::New(env, stats.min));
    stats_obj.Set("max",    Napi::Number::New(env, stats.max));
    stats_obj.Set("p25",    Napi::Number::New(env, stats.p25));
    stats_obj.Set("p75",    Napi::Number::New(env, stats.p75));
    stats_obj.Set("iqr",    Napi::Number::New(env, stats.iqr));
    stats_obj.Set("count",  Napi::Number::New(env, static_cast<double>(stats.count)));

    // Build anomaly indices array
    Napi::Array anomaly_arr = Napi::Array::New(env, anomaly_indices.size());
    for (size_t i = 0; i < anomaly_indices.size(); i++) {
      anomaly_arr.Set(static_cast<uint32_t>(i),
        Napi::Number::New(env, static_cast<double>(anomaly_indices[i])));
    }

    // Build per-field result
    Napi::Object field_result = Napi::Object::New(env);
    field_result.Set("anomalyIndices", anomaly_arr);
    field_result.Set("stats", stats_obj);

    result.Set(field_name, field_result);
  }

  return result;
}

// ─────────────────────────────────────────────
// Module registration
// ─────────────────────────────────────────────

Napi::Object InitAnomalyScorer(Napi::Env env, Napi::Object exports) {
  exports.Set("computeFieldStats",
    Napi::Function::New(env, JS_ComputeFieldStats));
  exports.Set("detectAnomalies",
    Napi::Function::New(env, JS_DetectAnomalies));
  exports.Set("detectChangepoints",
    Napi::Function::New(env, JS_DetectChangepoints));
  exports.Set("detectAnomaliesBatch",
    Napi::Function::New(env, JS_DetectAnomaliesBatch));
  return exports;
}

} // namespace contextforge