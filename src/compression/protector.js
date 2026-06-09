// src/compression/protector.js

/**
 * ContextProtector
 * Safely masks and restores fragile syntax blocks (code, JSON, etc.)
 * during structural compression.
 *
 * Each instance is request-scoped to avoid cross-contamination.
 */
export class ContextProtector {
  constructor() {
    this.store = new Map();
    this._counter = 0;
  }

  /**
   * Extracts and replaces code blocks with unique placeholders.
   * Supports:
   *   - Triple-backtick blocks: ```python\n...\n```
   *   - Inline backticks: `x = 1`
   *
   * @param {string} text
   * @returns {string} Masked text
   */
  mask(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return text;
    }

    // Match: ```optional-lang\ncontent\n``` OR `inline content`
    // Use non-greedy match with [\s\S] to span newlines
    const codeBlockRegex = /(```[\s\S]*?```|`[^`]*`)/g;

    let match;
    let lastIndex = 0;
    let maskedText = '';

    // Use exec loop for full control and safety
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const fullMatch = match[0];
      const start = match.index;
      const end = start + fullMatch.length;

      // Append non-matched text before this match
      maskedText += text.slice(lastIndex, start);

      // Generate a fast counter-based token (no crypto overhead)
      const token = `__CF_P${this._counter++}__`;

      // Store original
      this.store.set(token, fullMatch);

      // Append token
      maskedText += token;

      lastIndex = end;
    }

    // Append remaining text after last match
    maskedText += text.slice(lastIndex);

    return maskedText;
  }

  /**
   * Restores all protected blocks from placeholders.
   * @param {string} maskedText
   * @returns {string} Fully restored text
   */
  restore(maskedText) {
    if (typeof maskedText !== 'string' || maskedText.length === 0 || this.store.size === 0) {
      return maskedText;
    }

    let restored = maskedText;

    // Replace all tokens with originals using fast string replacement
    for (const [token, original] of this.store.entries()) {
      restored = restored.replaceAll(token, original);
    }

    return restored;
  }
}