import type { Embedder } from "../types.js";

export interface LocalEmbedderOptions {
  /** transformers.js model id, default "Xenova/all-MiniLM-L6-v2" */
  model?: string;
  /** expected vector width, default 384 */
  dim?: number;
}

interface TensorLike {
  data: Float32Array | number[];
  dims: number[];
}

type FeaturePipeline = (
  input: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<TensorLike>;

const NOT_INSTALLED_MSG =
  "@huggingface/transformers is not installed; add it to use LocalEmbedder" +
  " (optional peer dependency)";

/**
 * In-process embeddings via transformers.js (ONNX, no network at query time
 * once the model is cached). The dependency is an optional peer: it is only
 * loaded on first embed(), and a missing install fails with a clear message
 * instead of at import time.
 */
export class LocalEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private pipelinePromise: Promise<FeaturePipeline> | undefined;

  constructor(opts?: LocalEmbedderOptions) {
    this.model = opts?.model ?? "Xenova/all-MiniLM-L6-v2";
    this.dim = opts?.dim ?? 384;
  }

  private loadPipeline(): Promise<FeaturePipeline> {
    if (this.pipelinePromise === undefined) {
      const model = this.model;
      this.pipelinePromise = (async () => {
        // non-literal specifier keeps typecheck independent of the optional peer
        const specifier = "@huggingface/transformers";
        let mod: { pipeline: (task: string, model: string) => Promise<FeaturePipeline> };
        try {
          mod = (await import(specifier)) as typeof mod;
        } catch {
          throw new Error(NOT_INSTALLED_MSG);
        }
        return mod.pipeline("feature-extraction", model);
      })();
      // a failed load stays retryable (e.g. the package gets installed later)
      this.pipelinePromise.catch(() => {
        this.pipelinePromise = undefined;
      });
    }
    return this.pipelinePromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const pipe = await this.loadPipeline();
    const out = await pipe(texts, { pooling: "mean", normalize: true });

    const dims = out.dims;
    const width = dims[dims.length - 1] ?? 0;
    const rows = dims.length >= 2 ? dims[0] ?? 0 : 1;
    if (width !== this.dim) {
      throw new Error(
        `model ${this.model} produced vectors of dim ${width}, expected ${this.dim}`,
      );
    }
    if (rows !== texts.length) {
      throw new Error(
        `model ${this.model} returned ${rows} vectors for ${texts.length} inputs`,
      );
    }

    const flat =
      out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      vectors.push(flat.slice(i * this.dim, (i + 1) * this.dim));
    }
    return vectors;
  }
}
