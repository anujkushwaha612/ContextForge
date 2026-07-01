/**
 * memoryDecision.js
 *
 * Canonical "should we inject memory context?" gate.
 *
 * Decision-only: gates whether the request bytes get mutated
 * (memory context injected). Does NOT gate background memory storage —
 * the RAG indexer continues accumulating signal even under bypass.
 *
 * Precedence (highest first):
 *   1. bypass_header   — user's explicit "do not touch my bytes"
 *   2. no_handler      — no memory backend configured
 *   3. no_user_id      — per-request user_id missing
 *   4. mode_disabled   — CF_MEMORY_MODE=disabled
 *   5. mode_tool       — CF_MEMORY_MODE=tool (agent calls tools explicitly,
 *                        no auto-context injection but tools remain available)
 *   6. otherwise       — inject=true
 *
 * Fixes applied:
 *   MD-3: JSDoc corrected — memoryHandler receives MemoryHandler instance,
 *         not hybridRetriever.
 */

import { isBypassEnabled } from "./compressionDecision.js";

export class MemoryDecision {
  constructor({
    inject,
    skipReason,
    bypassHeaderSet,
    memoryHandlerPresent,
    memoryUserIdPresent,
    modeName,
  }) {
    this.inject               = inject;
    this.skipReason           = skipReason;
    this.bypassHeaderSet      = bypassHeaderSet;
    this.memoryHandlerPresent = memoryHandlerPresent;
    this.memoryUserIdPresent  = memoryUserIdPresent;
    this.modeName             = modeName;
    Object.freeze(this);
  }

  /**
   * Factory — the only correct way to create a MemoryDecision.
   *
   * @param {object}           headers       - Inbound request headers
   * @param {MemoryHandler|null} memoryHandler - MemoryHandler instance or null
   * @param {string|null}      memoryUserId  - x-contextforge-user-id header value
   * @param {string}           modeName      - "auto_tail" | "tool" | "disabled"
   */
  static decide({ headers, memoryHandler, memoryUserId, modeName = "auto_tail" }) {
    const bypass     = isBypassEnabled(headers);
    const hasHandler = memoryHandler !== null && memoryHandler !== undefined;
    const hasUser    = Boolean(memoryUserId && memoryUserId.trim());

    let reason = null;
    let inject = false;

    if (bypass) {
      reason = "bypass_header";
      inject = false;
    } else if (!hasHandler) {
      reason = "no_handler";
      inject = false;
    } else if (!hasUser) {
      reason = "no_user_id";
      inject = false;
    } else if (modeName === "disabled") {
      reason = "mode_disabled";
      inject = false;
    } else if (modeName === "tool") {
      // tool mode: LLM calls memory tools explicitly.
      // inject=false → skip auto-injection of "Relevant Memories" context block.
      // Memory tools are still injected separately by injectMemoryTools() in Stage 1.
      reason = "mode_tool";
      inject = false;
    } else {
      reason = null;
      inject = true;
    }

    return new MemoryDecision({
      inject,
      skipReason:           reason,
      bypassHeaderSet:      bypass,
      memoryHandlerPresent: hasHandler,
      memoryUserIdPresent:  hasUser,
      modeName,
    });
  }

  applyToTags(tags) {
    if (this.skipReason !== null) {
      tags.memory_skip_reason = this.skipReason;
    }
  }

  toString() {
    if (this.inject) return "MemoryDecision(INJECT)";
    return `MemoryDecision(SKIP reason=${this.skipReason})`;
  }
}

export function getMemoryMode() {
  const val = (process.env.CF_MEMORY_MODE || "auto_tail").trim().toLowerCase();
  if (["disabled", "tool", "auto_tail"].includes(val)) return val;
  return "auto_tail";
}