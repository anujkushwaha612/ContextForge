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
    this.discoveredVaultIds = new Set();
    this.retrievedVaultIds = new Set();
    // ── NEW: track which turn each vault was first discovered ──
    this.vaultDiscoveredTurn = new Map(); // vaultId → turnNumber
    // PC-1 (provider-cache audit): monotonic sticky flag. Once this
    // conversation has ever produced a compressed/vaulted payload, the
    // contextforge_retrieve tool stays in the tools array for the rest of
    // the session. Provider prompt caches key on the exact prefix bytes
    // (system + tools + history); a tools array that shrinks after the
    // model retrieves a vault changed the prefix every retrieval event and
    // busted the cache for the next turn. Availability is now
    // append-only: added once, never removed (a NEW conversation gets a
    // NEW session object, so stickiness never leaks across conversations).
    this.stickyRetrieve = false;
  }

  addDiscoveredVaultId(vaultId) {
    if (vaultId) {
      this.discoveredVaultIds.add(vaultId);
      // Only record discovery turn on first encounter
      if (!this.vaultDiscoveredTurn.has(vaultId)) {
        this.vaultDiscoveredTurn.set(vaultId, this.turnNumber);
      }
    }
  }

  // Convenience method called from applyCCRPipeline
  vaultDiscoveredAtTurn(vaultId) {
    if (vaultId && !this.vaultDiscoveredTurn.has(vaultId)) {
      this.vaultDiscoveredTurn.set(vaultId, this.turnNumber);
    }
  }

  markVaultRetrieved(vaultId) {
    if (vaultId) {
      this.retrievedVaultIds.add(vaultId);
      this.discoveredVaultIds.add(vaultId);
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

    this._cleanupInterval = setInterval(() => this._cleanup(), 30 * 60 * 1000);
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

  // CCR-4 FIX: the session id hashed the RAW first user message. That
  // content is not stable across turns: Claude Code injects mutable
  // <system-reminder> blocks into user messages, the memory handler
  // appends "## Relevant Memories" context, and the gemini extractor
  // restructures @-mention content. Any of those → different hash →
  // BRAND-NEW session → retrievedVaultIds lost → the retrieve tool
  // re-injected for vaults already in context (the exact sticky-injection
  // bug this module was rewritten to kill, back through the side door).
  // Fix: strip known injected/mutable spans before hashing.
  static _stableUserText(content) {
    let text;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
    } else {
      text = JSON.stringify(content ?? "");
    }
    return text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      .replace(/## Relevant Memories[\s\S]*?(?:\n---\n|$)/g, "")
      .replace(/--- Content from referenced files ---[\s\S]*?--- End of content ---/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  static deriveSessionId(payload) {
    const messages = payload.messages || [];
    for (const msg of messages) {
      if (msg.role === "user") {
        const stable = SessionRegistry._stableUserText(msg.content);
        if (!stable) continue; // reminder-only message — try next user msg
        return crypto.createHash("sha256").update(stable.slice(0, 500)).digest("hex").slice(0, 16);
      }
    }
    return crypto.randomBytes(8).toString("hex");
  }

  static deriveWorkspaceKey(payload) {
    const messages = payload.messages || [];
    for (const msg of messages) {
      if (msg.role === "system") {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

        const cwdMatch = content.match(/(?:cwd|working.?dir(?:ectory)?)[:\s]+([^\n]+)/i);
        if (cwdMatch) {
          return crypto.createHash("sha256").update(cwdMatch[1].trim()).digest("hex").slice(0, 16);
        }

        return crypto.createHash("sha256").update(content.slice(0, 200)).digest("hex").slice(0, 16);
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
        (s) => s.retrievedVaultIds.size > 0
      ).length,
    };
  }
}

export const sessionRegistry = new SessionRegistry();
