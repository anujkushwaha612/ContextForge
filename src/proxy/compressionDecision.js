/**
 * CompressionDecision — canonical "should this request be compressed?" gate.
 *
 * Port of headroom/proxy/compression_decision.py
 *
 * Pre-this-module, compression ran unconditionally on every request.
 * This caused:
 * - Token counting pings (empty messages) running through the full pipeline
 * - No way to bypass compression for debugging
 * - No observability into WHY a request was not compressed
 *
 * Precedence (highest first):
 *   1. bypass_header   — x-contextforge-bypass: true
 *   2. compression_disabled — CF_OPTIMIZE=false env var
 *   3. no_messages     — empty/missing messages array
 *   4. otherwise       — compress
 */

// ─────────────────────────────────────────────
// Bypass header detection
// ─────────────────────────────────────────────

/**
 * Check if the request has an explicit bypass header.
 * Mirrors headroom's _headroom_bypass_enabled helper.
 */
export function isBypassEnabled(headers) {
  // Direct bypass header
  const bypass = headers["x-contextforge-bypass"] ||
                 headers["x-headroom-bypass"] ||
                 "";
  if (["true", "1", "yes", "on"].includes(bypass.toLowerCase().trim())) {
    return true;
  }

  // Mode header
  const mode = headers["x-contextforge-mode"] ||
               headers["x-headroom-mode"] ||
               "";
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
    // Freeze so downstream code cannot mutate the decision
    this.shouldCompress        = shouldCompress;
    this.passthroughReason     = passthroughReason;     // null when compressing
    this.bypassHeaderSet       = bypassHeaderSet;
    this.configOptimizeEnabled = configOptimizeEnabled;
    this.hasMessages           = hasMessages;
    Object.freeze(this);
  }

  /**
   * Factory — the only correct way to create a CompressionDecision.
   *
   * @param {object} headers    - Inbound request headers object
   * @param {boolean} optimize  - From config/env (CF_OPTIMIZE env var)
   * @param {Array}   messages  - messages array from parsed payload
   */
  static decide({ headers, optimize = true, messages }) {
    const bypass    = isBypassEnabled(headers);
    const configOk  = Boolean(optimize);
    const hasMsgs   = Array.isArray(messages) && messages.length > 0;

    // Precedence: bypass > config > no_messages > compress
    let reason = null;
    let should = false;

    if (bypass) {
      reason = "bypass_header";
      should = false;
    } else if (!configOk) {
      reason = "compression_disabled";
      should = false;
    } else if (!hasMsgs) {
      reason = "no_messages";
      should = false;
    } else {
      reason = null;
      should = true;
    }

    return new CompressionDecision({
      shouldCompress:        should,
      passthroughReason:     reason,
      bypassHeaderSet:       bypass,
      configOptimizeEnabled: configOk,
      hasMessages:           hasMsgs,
    });
  }

  /**
   * Stamp the passthrough reason into a tags object for observability.
   * No-op when shouldCompress is true.
   */
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