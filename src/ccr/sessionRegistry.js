/**
 * Session registry — tracks CCR state across requests for the same session.
 *
 * Solves two problems:
 * 1. Sticky-on tool injection (PR-B7): once CCR fires, tool stays forever
 * 2. Workspace scoping: prevents cross-project content leaks
 *
 * The workspace key is derived from the working directory of the project,
 * which is stable within a session but different across projects.
 */

import crypto from "node:crypto";

// ─────────────────────────────────────────────
// Session state per sessionId
// ─────────────────────────────────────────────

class SessionState {
  constructor(workspaceKey) {
    this.workspaceKey      = workspaceKey;
    this.hasDoneCCR        = false;  // sticky-on flag (PR-B7)
    this.turnNumber        = 0;
    this.createdAt         = Date.now();
    this.lastActiveAt      = Date.now();
    this.vaultIdsInjected  = new Set();
  }

  markCCRDone(vaultId) {
    this.hasDoneCCR = true;
    if (vaultId) this.vaultIdsInjected.add(vaultId);
    this.lastActiveAt = Date.now();
  }

  incrementTurn() {
    this.turnNumber++;
    this.lastActiveAt = Date.now();
    return this.turnNumber;
  }
}

// ─────────────────────────────────────────────
// SessionRegistry — singleton per proxy process
// ─────────────────────────────────────────────

export class SessionRegistry {
  constructor({ sessionTtlMs = 2 * 60 * 60 * 1000 } = {}) {  // 2 hours
    this._sessions = new Map();
    this._sessionTtlMs = sessionTtlMs;

    // Periodic cleanup every 30 minutes
    this._cleanupInterval = setInterval(() => this._cleanup(), 30 * 60 * 1000);
    this._cleanupInterval.unref(); // Don't prevent process exit
  }

  /**
   * Get or create session state for a request.
   *
   * Session ID is derived from the conversation structure —
   * specifically the hash of the first user message, which is stable
   * within a session but different across sessions.
   */
  getOrCreate(sessionId, workspaceKey) {
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, new SessionState(workspaceKey));
    }
    const session = this._sessions.get(sessionId);
    session.lastActiveAt = Date.now();
    return session;
  }

  /**
   * Derive a session ID from the payload.
   * Uses the first user message content as a stable identifier.
   */
  static deriveSessionId(payload) {
    const messages = payload.messages || [];
    // Find first user message
    for (const msg of messages) {
      if (msg.role === "user") {
        const content = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
        // Hash first 500 chars — stable within session, unique across sessions
        return crypto
          .createHash("sha256")
          .update(content.slice(0, 500))
          .digest("hex")
          .slice(0, 16);
      }
    }
    // Fallback: random (no session tracking possible)
    return crypto.randomBytes(8).toString("hex");
  }

  /**
   * Derive workspace key from payload.
   * Uses the system prompt content as a proxy for project identity.
   * In practice, Claude Code includes the project path in the system prompt.
   */
  static deriveWorkspaceKey(payload) {
    const messages = payload.messages || [];

    // Look for system message
    for (const msg of messages) {
      if (msg.role === "system") {
        const content = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);

        // Extract working directory hint from system prompt
        // Claude Code includes "cwd: /path/to/project" in its system prompt
        const cwdMatch = content.match(/(?:cwd|working.?dir(?:ectory)?)[:\s]+([^\n]+)/i);
        if (cwdMatch) {
          return crypto
            .createHash("sha256")
            .update(cwdMatch[1].trim())
            .digest("hex")
            .slice(0, 16);
        }

        // Fall back to hash of first 200 chars of system prompt
        return crypto
          .createHash("sha256")
          .update(content.slice(0, 200))
          .digest("hex")
          .slice(0, 16);
      }
    }

    // No system message — use process ID as workspace key
    // (means each server restart gets a fresh workspace, which is safe)
    return `pid_${process.pid}`;
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, session] of this._sessions) {
      if (now - session.lastActiveAt > this._sessionTtlMs) {
        this._sessions.delete(id);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupInterval);
    this._sessions.clear();
  }

  getStats() {
    return {
      activeSessions:  this._sessions.size,
      sessionsWithCCR: [...this._sessions.values()].filter((s) => s.hasDoneCCR).length,
    };
  }
}

// Process-wide singleton
export const sessionRegistry = new SessionRegistry();