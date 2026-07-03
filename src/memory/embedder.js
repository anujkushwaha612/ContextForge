/**
 * Thin JS wrapper around native.OnnxEmbedder.
 * The real work is in C++.
 *
 * Fixes applied:
 *   EB-1: embedBatch input validation — null/non-array previously flowed
 *         into the native binding and died with an unhelpful TypeError
 *         ("Cannot read properties of null"). Now rejects with a clear
 *         message, matching the native binding's own error style.
 *
 *   EB-2: empty/whitespace strings inside a batch are no longer sent to
 *         the native encoder. embed() already guarded single empty texts
 *         (zero vector), but embedBatch passed them through — the model
 *         embedded pure PAD-token noise which then got INDEXED (server.js
 *         workspace symbol indexing calls embedBatch). Empty slots now get
 *         the same zero-vector treatment, order and length preserved.
 */

export class NativeEmbedder {
  constructor(nativeEmbedder) {
    this._emb = nativeEmbedder;
    this.dim  = 384;
  }

  // Returns Promise<Float32Array>
  embed(text) {
    if (!text?.trim()) {
      console.warn(
        "[Embedder] ⚠️  Attempted to embed empty text — returning zero vector. " +
        "This will cause search misses if the text was intended to be searchable."
      );
      return Promise.resolve(new Float32Array(this.dim));
    }
    return this._emb.embed(text);
  }

  // Returns Promise<Float32Array[]>
  async embedBatch(texts) {
    // EB-1: validate before touching native
    if (!Array.isArray(texts)) {
      return Promise.reject(
        new TypeError("[Embedder] embedBatch(texts: string[]) — got " + typeof texts)
      );
    }
    if (texts.length === 0) return [];

    // EB-2: split empty and non-empty slots, embed only the real ones,
    // reassemble in original order.
    const nonEmptyIdx = [];
    const nonEmpty    = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (typeof t === "string" && t.trim()) {
        nonEmptyIdx.push(i);
        nonEmpty.push(t);
      }
    }

    // All-empty batch → all zero vectors, skip native entirely
    if (nonEmpty.length === 0) {
      console.warn(`[Embedder] ⚠️  embedBatch: all ${texts.length} texts empty — zero vectors.`);
      return texts.map(() => new Float32Array(this.dim));
    }

    const embedded = await this._emb.embedBatch(nonEmpty);

    if (nonEmpty.length === texts.length) return embedded; // fast path

    console.warn(
      `[Embedder] ⚠️  embedBatch: ${texts.length - nonEmpty.length}/${texts.length} ` +
      `texts empty — zero vectors substituted.`
    );
    const out = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) out[i] = new Float32Array(this.dim);
    for (let j = 0; j < nonEmptyIdx.length; j++) out[nonEmptyIdx[j]] = embedded[j];
    return out;
  }

  getStats() {
    return this._emb.getStats();
  }

  isReady() {
    return this._emb.isReady();
  }
}

// Singleton — set by server.js after native module loads
let _instance = null;

export function setEmbedder(nativeEmbedder) {
  _instance = new NativeEmbedder(nativeEmbedder);
}

export function getEmbedder() {
  if (!_instance) throw new Error("[Embedder] Not initialized — call setEmbedder() first");
  return _instance;
}
