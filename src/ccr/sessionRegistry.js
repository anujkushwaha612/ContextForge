import crypto from "node:crypto";

// ─────────────────────────────────────────────
// Session state per sessionId
// ─────────────────────────────────────────────

class SessionState {
  constructor(workspaceKey) {
    this.workspaceKey = workspaceKey;
    this.turnNumber = 0;
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();

    // Vault IDs discovered in any message in this session.
    // Used to avoid re-scanning old messages.
    this.discoveredVaultIds = new Set();

    // Vault IDs the LLM has SUCCESSFULLY retrieved via contextforge_retrieve.
    // These are excluded from injection — content is already in context.
    // FIX: Replaces hasDoneCCR (permanent boolean) and knownVaultIds
    // (used to force inject=true forever). Now tracks per-vault retrieval
    // so injection only fires for genuinely unretrieved stubs.
    this.retrievedVaultIds = new Set();
  }

  // Called when a [CF_VAULT:] stub is found in a message
  addDiscoveredVaultId(vaultId) {
    if (vaultId) this.discoveredVaultIds.add(vaultId);
  }

  // Called when the LLM successfully retrieves a vault
  markVaultRetrieved(vaultId) {
    if (vaultId) {
      this.retrievedVaultIds.add(vaultId);
      this.discoveredVaultIds.add(vaultId); // keep in sync
    }
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
  constructor({ sessionTtlMs = 2 * 60 * 60 * 1000 } = {}) {
    this._sessions = new Map();
    this._sessionTtlMs = sessionTtlMs;

    this._cleanupInterval = setInterval(
      () => this._cleanup(),
      30 * 60 * 1000,
    );
    this._cleanupInterval.unref();
  }

  getOrCreate(sessionId, workspaceKey) {
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, new SessionState(workspaceKey));
    }
    const session = this._sessions.get(sessionId);
    session.lastActiveAt = Date.now();
    return session;
  }

  static deriveSessionId(payload) {
    const messages = payload.messages || [];
    for (const msg of messages) {
      if (msg.role === "user") {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
        return crypto
          .createHash("sha256")
          .update(content.slice(0, 500))
          .digest("hex")
          .slice(0, 16);
      }
    }
    return crypto.randomBytes(8).toString("hex");
  }

  static deriveWorkspaceKey(payload) {
    const messages = payload.messages || [];
    for (const msg of messages) {
      if (msg.role === "system") {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);

        const cwdMatch = content.match(
          /(?:cwd|working.?dir(?:ectory)?)[:\s]+([^\n]+)/i,
        );
        if (cwdMatch) {
          return crypto
            .createHash("sha256")
            .update(cwdMatch[1].trim())
            .digest("hex")
            .slice(0, 16);
        }

        return crypto
          .createHash("sha256")
          .update(content.slice(0, 200))
          .digest("hex")
          .slice(0, 16);
      }
    }
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
      activeSessions: this._sessions.size,
      sessionsWithRetrievals: [...this._sessions.values()].filter(
        (s) => s.retrievedVaultIds.size > 0,
      ).length,
    };
  }
}

export const sessionRegistry = new SessionRegistry();