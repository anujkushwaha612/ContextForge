/**
 * Thin JS wrapper around native.OnnxEmbedder.
 * The real work is in C++.
 */

export class NativeEmbedder {
  constructor(nativeEmbedder) {
    this._emb = nativeEmbedder;
    this.dim  = 384;
  }

  // Returns Promise<Float32Array>
  embed(text) {
    if (!text?.trim()) {
      return Promise.resolve(new Float32Array(this.dim));
    }
    return this._emb.embed(text);
  }

  // Returns Promise<Float32Array[]>
  embedBatch(texts) {
    return this._emb.embedBatch(texts);
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