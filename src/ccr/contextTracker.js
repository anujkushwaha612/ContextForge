// ─────────────────────────────────────────────
// Data structures
// ─────────────────────────────────────────────

class CompressedContext {
  constructor({
    vaultId,
    turnNumber,
    timestamp,
    toolName,
    originalItemCount,
    compressedItemCount,
    queryContext,
    sampleContent,
    workspaceKey,
  }) {
    this.vaultId = vaultId;
    this.turnNumber = turnNumber;
    this.timestamp = timestamp;
    this.toolName = toolName;
    this.originalItemCount = originalItemCount;
    this.compressedItemCount = compressedItemCount;
    this.queryContext = queryContext;
    this.sampleContent = sampleContent.slice(0, 2000);
    this.workspaceKey = workspaceKey;
  }
}

class ExpansionRecommendation {
  constructor({ vaultId, reason, relevanceScore, expandFull, searchQuery }) {
    this.vaultId = vaultId;
    this.reason = reason;
    this.relevanceScore = relevanceScore;
    this.expandFull = expandFull ?? true;
    this.searchQuery = searchQuery ?? null;
  }
}

// ─────────────────────────────────────────────
// ContextTracker
// ─────────────────────────────────────────────

export class ContextTracker {
  constructor({
    enabled = true,
    maxTrackedContexts = 100,
    relevanceThreshold = 0.3,
    maxContextAgeMs = 300_000, // 5 minutes
    proactiveExpansion = true,
    maxProactiveExpansions = 2,
  } = {}) {
    this.config = {
      enabled,
      maxTrackedContexts,
      relevanceThreshold,
      maxContextAgeMs,
      proactiveExpansion,
      maxProactiveExpansions,
    };

    // Map of vaultId → CompressedContext
    this._contexts = new Map();
    // Insertion order for LRU eviction
    this._insertionOrder = [];
    this._currentTurn = 0;
  }

  // ─────────────────────────────────────────────
  // Track a compression event
  // ─────────────────────────────────────────────

  trackCompression({
    vaultId,
    turnNumber,
    toolName = null,
    originalCount = 0,
    compressedCount = 0,
    workspaceKey,
    queryContext = "",
    sampleContent = "",
  }) {
    if (!this.config.enabled) return;

    if (!workspaceKey) {
      console.warn(
        "[ContextTracker] trackCompression called with empty workspaceKey — skipping. " +
          "This prevents cross-project leaks.",
      );
      return;
    }

    const ctx = new CompressedContext({
      vaultId,
      turnNumber,
      timestamp: Date.now(),
      toolName,
      originalItemCount: originalCount,
      compressedItemCount: compressedCount,
      queryContext,
      sampleContent,
      workspaceKey,
    });

    // Remove existing entry from order tracking if updating
    if (this._contexts.has(vaultId)) {
      const idx = this._insertionOrder.indexOf(vaultId);
      if (idx !== -1) this._insertionOrder.splice(idx, 1);
    }

    this._contexts.set(vaultId, ctx);
    this._insertionOrder.push(vaultId);

    // LRU eviction
    while (this._contexts.size > this.config.maxTrackedContexts) {
      const oldest = this._insertionOrder.shift();
      this._contexts.delete(oldest);
    }

    this._currentTurn = Math.max(this._currentTurn, turnNumber);

    console.log(
      `[ContextTracker] Tracked compression ${vaultId} ` +
        `(${originalCount} → ${compressedCount} items) workspace=${workspaceKey}`,
    );
  }

  // ─────────────────────────────────────────────
  // Analyze a query for expansion recommendations
  // ─────────────────────────────────────────────

  analyzeQuery(query, { currentTurn = null, workspaceKey } = {}) {
    if (!this.config.enabled || !this.config.proactiveExpansion) return [];

    // Fail closed on empty workspaceKey — prevents cross-project leaks
    if (!workspaceKey) {
      console.debug(
        "[ContextTracker] analyzeQuery called with empty workspaceKey — " +
          "returning no recommendations (fail-closed)",
      );
      return [];
    }

    if (currentTurn !== null) this._currentTurn = currentTurn;

    const recommendations = [];
    const now = Date.now();

    for (const [vaultId, ctx] of this._contexts) {
      // Workspace filter — the cross-project leak gate
      if (ctx.workspaceKey !== workspaceKey) continue;

      // Age check
      const age = now - ctx.timestamp;
      if (age > this.config.maxContextAgeMs) continue;

      // Calculate relevance
      let relevance = this._calculateRelevance(query, ctx);

      // Age discount: older contexts get lower scores
      const ageFactor = 1.0 - (age / this.config.maxContextAgeMs) * 0.5;
      relevance *= ageFactor;

      if (relevance >= this.config.relevanceThreshold) {
        const { expandFull, searchQuery } = this._determineExpansionType(
          query,
          ctx,
          relevance,
        );
        recommendations.push(
          new ExpansionRecommendation({
            vaultId,
            reason: this._generateReason(query, ctx, relevance),
            relevanceScore: relevance,
            expandFull,
            searchQuery,
          }),
        );
      }
    }

    // Sort by relevance, limit count
    recommendations.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return recommendations.slice(0, this.config.maxProactiveExpansions);
  }

  // ─────────────────────────────────────────────
  // Relevance scoring
  // ─────────────────────────────────────────────

  _calculateRelevance(query, ctx) {
    const queryLower = query.toLowerCase();
    const queryWords = new Set(this._extractKeywords(queryLower));

    if (queryWords.size === 0) return 0.0;

    let score = 0.0;

    // Sample content keyword overlap
    const sampleLower = ctx.sampleContent.toLowerCase();
    const sampleWords = new Set(this._extractKeywords(sampleLower));

    if (sampleWords.size > 0) {
      const overlap = [...queryWords].filter((w) => sampleWords.has(w));
      score += (overlap.length / queryWords.size) * 0.5;

      // Bonus for exact substring matches (4+ char words)
      for (const word of queryWords) {
        if (word.length >= 4 && sampleLower.includes(word)) {
          score += 0.2;
        }
      }
    }

    // Original query context overlap
    if (ctx.queryContext) {
      const ctxLower = ctx.queryContext.toLowerCase();
      const ctxWords = new Set(this._extractKeywords(ctxLower));
      if (ctxWords.size > 0) {
        const overlap = [...queryWords].filter((w) => ctxWords.has(w));
        score += (overlap.length / queryWords.size) * 0.3;
      }
    }

    // Tool name relevance
    if (ctx.toolName) {
      const toolLower = ctx.toolName.toLowerCase();
      if (
        ["find", "glob", "search", "grep", "ls", "bash"].some((w) =>
          toolLower.includes(w),
        )
      ) {
        if (
          ["file", "where", "find", "show", "list"].some((w) =>
            queryLower.includes(w),
          )
        ) {
          score += 0.1;
        }
      }
    }

    return Math.min(score, 1.0);
  }

  _extractKeywords(text) {
    const STOP_WORDS = new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "must",
      "shall",
      "can",
      "to",
      "of",
      "in",
      "for",
      "on",
      "with",
      "at",
      "by",
      "from",
      "as",
      "into",
      "and",
      "but",
      "if",
      "or",
      "this",
      "that",
      "these",
      "those",
      "what",
      "which",
      "who",
      "it",
      "its",
      "me",
      "my",
      "i",
      "you",
      "we",
      "they",
      "them",
      "their",
      "here",
      "there",
      "when",
      "where",
      "why",
      "how",
      "all",
      "each",
      "few",
      "more",
      "most",
      "just",
      "only",
      "own",
      "same",
      "so",
      "than",
      "too",
      "very",
      "not",
      "no",
      "nor",
      "such",
      "then",
      "once",
    ]);

    return (
      text.match(/\b[a-z][a-z0-9_./-]*[a-z0-9]\b|\b[a-z]{2,}\b/g) || []
    ).filter((w) => !STOP_WORDS.has(w) && w.length >= 2);
  }

  _determineExpansionType(query, ctx, relevance) {
    // High relevance or small dataset → full expansion
    if (relevance > 0.6 || ctx.originalItemCount <= 50) {
      return { expandFull: true, searchQuery: null };
    }

    const keywords = this._extractKeywords(query.toLowerCase());
    const specific = keywords.filter(
      (k) =>
        k.length >= 4 &&
        ![
          "file",
          "code",
          "show",
          "find",
          "list",
          "what",
          "more",
          "data",
        ].includes(k),
    );

    if (specific.length > 0) {
      return { expandFull: false, searchQuery: specific.slice(0, 3).join(" ") };
    }

    return { expandFull: true, searchQuery: null };
  }

  _generateReason(query, ctx, relevance) {
    const parts = [];
    if (ctx.toolName) parts.push(`from ${ctx.toolName}`);
    parts.push(
      `${ctx.originalItemCount} items compressed in turn ${ctx.turnNumber}`,
    );
    parts.push(relevance > 0.5 ? "high relevance" : "possible relevance");
    return parts.join(", ");
  }

  // ─────────────────────────────────────────────
  // Stats and lifecycle
  // ─────────────────────────────────────────────

  getTrackedVaultIds() {
    return [...this._contexts.keys()];
  }

  getStats() {
    return {
      trackedContexts: this._contexts.size,
      currentTurn: this._currentTurn,
      config: this.config,
      contexts: [...this._contexts.values()].map((ctx) => ({
        vaultId: ctx.vaultId,
        turn: ctx.turnNumber,
        tool: ctx.toolName,
        items: `${ctx.compressedItemCount}/${ctx.originalItemCount}`,
        workspace: ctx.workspaceKey,
      })),
    };
  }

  clear() {
    this._contexts.clear();
    this._insertionOrder = [];
    this._currentTurn = 0;
  }
}
