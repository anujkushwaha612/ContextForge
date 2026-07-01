/**
 * compressionDecision.js
 *
 * Canonical "should this request be compressed?" gate.
 *
 * Fixes:
 *   CD-1: Minimum token threshold raised from 500 → 2000 to align with
 *         the planner's own bypass threshold (2 * toolInjectionCost ≈ 4000).
 *         Between 500 and 2000 tokens, the pipeline ran but the planner
 *         bypassed tool injection — producing pipeline overhead with no
 *         compression benefit. 2000 is still well below the threshold where
 *         any meaningful tool result content appears.
 *
 *   CD-2: getOptimizeFlag evaluated once at module load — process.env is a
 *         C++ binding call, not a free property read. Previously re-evaluated
 *         on every request.
 *
 *   CD-3: Documented that shouldCompress=true does not guarantee compression
 *         stages run — server.js has a separate hasCompressibleContent check
 *         that skips stages 2-8 when no tool result content is present.
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
// Minimum token threshold
//
// CD-1 FIX: Raised from 500 → 2000.
//
// Rationale: The planner bypasses tool injection when payload is below
// 2 * toolInjectionCost (~4000 tokens). Between 500 and ~4000 tokens,
// the pipeline ran but produced no compression benefit — only overhead.
// 2000 is a conservative midpoint that skips the pipeline for clearly
// trivial payloads (ping requests, token counting calls, short CHAT turns)
// while still engaging compression for anything with real tool result content.
//
// A payload with one user message + system prompt typically reaches 2000
// tokens only when the system prompt itself is substantial, at which point
// deduplication and minimization have real work to do.
// ─────────────────────────────────────────────
const MIN_TOKENS_TO_COMPRESS = 2000;

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
   * Precedence (highest first):
   *   1. bypass_header        — x-contextforge-bypass: true
   *   2. compression_disabled — CF_OPTIMIZE=false env var
   *   3. no_messages          — empty/missing messages array
   *   4. token_minimum        — below MIN_TOKENS_TO_COMPRESS (2000)
   *   5. otherwise            — compress
   *
   * CD-3 NOTE: shouldCompress=true means the pipeline STARTS. It does not
   * guarantee compression stages run. server.js has a separate
   * hasCompressibleContent check that skips stages 2-8 (scrub, tag,
   * semantic dedup, AST compress, vault intercept) when no tool result
   * content is present. Always-on stages (memory inject, CCR, minimize
   * tools, memory context) still run.
   *
   * @param {object} headers             - Inbound request headers
   * @param {boolean} optimize           - From getOptimizeFlag()
   * @param {Array}   messages           - messages array from payload
   * @param {object}  payload            - Full payload (fallback token count)
   * @param {number}  [precomputedTokens] - Pass trueBaselineTokens to avoid
   *                                       redundant O(n) recount.
   */
  static decide({ headers, optimize = true, messages, payload, precomputedTokens }) {
    const bypass   = isBypassEnabled(headers);
    const configOk = Boolean(optimize);
    const hasMsgs  = Array.isArray(messages) && messages.length > 0;

    // Check cheap conditions first — O(1) before O(n) token count
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

    // Use precomputed token count if available — avoids redundant O(n) recount
    const tokenCount =
      typeof precomputedTokens === "number" && precomputedTokens > 0
        ? precomputedTokens
        : countTokens(payload);

    if (tokenCount < MIN_TOKENS_TO_COMPRESS) {
      return new CompressionDecision({
        shouldCompress:        false,
        passthroughReason:     `${tokenCount} tokens below minimum (${MIN_TOKENS_TO_COMPRESS})`,
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
// getOptimizeFlag
//
// CD-2 FIX: Evaluated once at module load via IIFE.
// process.env access is a C++ binding call — not free.
// CF_OPTIMIZE never changes at runtime so there is no reason
// to re-read it on every request.
// ─────────────────────────────────────────────

const OFF_VALUES = new Set(["false", "0", "off", "no", "disabled"]);

export const getOptimizeFlag = (() => {
  const val  = (process.env.CF_OPTIMIZE || "true").trim().toLowerCase();
  const flag = !OFF_VALUES.has(val);
  return () => flag;
})();