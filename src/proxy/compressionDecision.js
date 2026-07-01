/**
 * compressionDecision.js
 *
 * Canonical "should this request be compressed?" gate.
 *
 * Pre-this-module, compression ran unconditionally on every request.
 * This caused:
 * - Token counting pings (empty messages) running through full pipeline
 * - No way to bypass compression for debugging
 * - No observability into WHY a request was not compressed
 *
 * Precedence (highest first):
 *   1. bypass_header        — x-contextforge-bypass: true
 *   2. compression_disabled — CF_OPTIMIZE=false env var
 *   3. no_messages          — empty/missing messages array
 *   4. token_minimum        — below 500 tokens (ping/trivial request)
 *   5. otherwise            — compress
 *
 * Fixes applied:
 *   CD-2: bypass header checked BEFORE token counting — header check is O(1),
 *         countTokens is O(n). Bypassed requests no longer pay token count cost.
 *
 *   CD-3: precomputedTokens now accepted and used — server.js computes
 *         trueBaselineTokens before this call and passes it. Previously
 *         ignored, causing a redundant O(n) token count on every request.
 *
 *   CD-6: JSDoc updated to document precomputedTokens parameter.
 */

import { countTokens } from "../compression/compressionHelper.js";

// ─────────────────────────────────────────────
// Bypass header detection
// ─────────────────────────────────────────────

export function isBypassEnabled(headers) {
  const bypass = headers["x-contextforge-bypass"] || "";
  if (["true", "1", "yes", "on"].includes(bypass.toLowerCase().trim())) {
    return true;
  }

  const mode = headers["x-contextforge-mode"] || "";
  if (mode.toLowerCase().trim() === "passthrough") {
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────
// CompressionDecision value object
// ─────────────────────────────────────────────

export class CompressionDecision {
  constructor({
    shouldCompress,
    passthroughReason,
    bypassHeaderSet,
    configOptimizeEnabled,
    hasMessages,
  }) {
    this.shouldCompress        = shouldCompress;
    this.passthroughReason     = passthroughReason;
    this.bypassHeaderSet       = bypassHeaderSet;
    this.configOptimizeEnabled = configOptimizeEnabled;
    this.hasMessages           = hasMessages;
    Object.freeze(this);
  }

  /**
   * Factory — the only correct way to create a CompressionDecision.
   *
   * @param {object}      headers            - Inbound request headers
   * @param {boolean}     optimize           - From CF_OPTIMIZE env var
   * @param {Array}       messages           - messages array from payload
   * @param {object}      payload            - Full payload (fallback for token count)
   * @param {number}      [precomputedTokens] - Token count already computed upstream.
   *                                           Pass trueBaselineTokens to avoid
   *                                           redundant O(n) recount.
   */
  static decide({ headers, optimize = true, messages, payload, precomputedTokens }) {
    // CD-2: Check cheap conditions first — bypass header is O(1).
    // Previously countTokens ran before bypass check, wasting O(n) on
    // every bypassed request.

    const bypass   = isBypassEnabled(headers);
    const configOk = Boolean(optimize);
    const hasMsgs  = Array.isArray(messages) && messages.length > 0;

    if (bypass) {
      return new CompressionDecision({
        shouldCompress:        false,
        passthroughReason:     "bypass_header",
        bypassHeaderSet:       true,
        configOptimizeEnabled: configOk,
        hasMessages:           hasMsgs,
      });
    }

    if (!configOk) {
      return new CompressionDecision({
        shouldCompress:        false,
        passthroughReason:     "compression_disabled",
        bypassHeaderSet:       false,
        configOptimizeEnabled: false,
        hasMessages:           hasMsgs,
      });
    }

    if (!hasMsgs) {
      return new CompressionDecision({
        shouldCompress:        false,
        passthroughReason:     "no_messages",
        bypassHeaderSet:       false,
        configOptimizeEnabled: configOk,
        hasMessages:           false,
      });
    }

    // CD-3: Use precomputed token count if available — avoids redundant O(n)
    // recount. server.js computes trueBaselineTokens before this call and
    // passes it as precomputedTokens. Only fall back to countTokens if not provided.
    const tokenCount = (typeof precomputedTokens === "number" && precomputedTokens > 0)
      ? precomputedTokens
      : countTokens(payload);

    if (tokenCount < 500) {
      return new CompressionDecision({
        shouldCompress:        false,
        passthroughReason:     `${tokenCount} tokens below minimum (500)`,
        bypassHeaderSet:       false,
        configOptimizeEnabled: configOk,
        hasMessages:           hasMsgs,
      });
    }

    return new CompressionDecision({
      shouldCompress:        true,
      passthroughReason:     null,
      bypassHeaderSet:       false,
      configOptimizeEnabled: configOk,
      hasMessages:           hasMsgs,
    });
  }

  applyToTags(tags) {
    if (this.passthroughReason !== null) {
      tags.passthrough_reason = this.passthroughReason;
    }
  }

  toString() {
    if (this.shouldCompress) return "CompressionDecision(COMPRESS)";
    return `CompressionDecision(PASSTHROUGH reason=${this.passthroughReason})`;
  }
}

// ─────────────────────────────────────────────
// Read optimize flag from environment
// ─────────────────────────────────────────────

const OFF_VALUES = new Set(["false", "0", "off", "no", "disabled"]);

export function getOptimizeFlag() {
  const val = (process.env.CF_OPTIMIZE || "true").trim().toLowerCase();
  return !OFF_VALUES.has(val);
}