import type { Embedder } from "../types.js";

export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic bag-of-words embedder for tests and offline use. Each token
 * adds 1.0 at fnv1a32(token) % dim, then the vector is L2 normalized.
 * Real embedders are plugged in by callers via DocketOptions.
 */
export class HashEmbedder implements Embedder {
  readonly model = "hash-64";
  readonly dim = 64;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const v = new Float32Array(this.dim);
      for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (!tok) continue;
        const i = fnv1a32(tok) % this.dim;
        v[i] = (v[i] ?? 0) + 1.0;
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
      }
      return v;
    });
  }
}
