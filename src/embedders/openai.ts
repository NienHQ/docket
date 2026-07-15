import type { Embedder } from "../types.js";

export interface OpenAiEmbedderOptions {
  /** model id sent to the API and stored on embeddings rows */
  model: string;
  /** expected vector width; every returned embedding is asserted against it */
  dim: number;
  /** bearer token; omitted for local servers that need no auth */
  apiKey?: string;
  /** default "https://api.openai.com/v1"; any OpenAI-compatible base works */
  baseUrl?: string;
  /** texts per POST, default 64, capped at 2048 */
  batchSize?: number;
  /** retries after the first attempt on 429/5xx/network errors, default 5 */
  maxRetries?: number;
}

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_BATCH = 2048;
const BASE_BACKOFF_MS = 250;
const MAX_WAIT_MS = 30_000;
const BODY_SNIPPET_CHARS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generic OpenAI-compatible /embeddings client over global fetch (Node 20+),
 * no SDK dependency. Batches sequentially, retries only transient failures
 * (429, 5xx, network) with deterministic exponential backoff, and honors a
 * Retry-After seconds header when present.
 */
export class OpenAiEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly maxRetries: number;

  constructor(opts: OpenAiEmbedderOptions) {
    this.model = opts.model;
    this.dim = opts.dim;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.batchSize = Math.max(1, Math.min(opts.batchSize ?? 64, MAX_BATCH));
    this.maxRetries = Math.max(0, opts.maxRetries ?? 5);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const vectors = await this.embedBatch(texts.slice(i, i + this.batchSize));
      for (const v of vectors) out.push(v);
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<Float32Array[]> {
    if (batch.length === 0) return [];
    const url = `${this.baseUrl}/embeddings`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== undefined) headers["authorization"] = `Bearer ${this.apiKey}`;
    const body = JSON.stringify({
      model: this.model,
      input: batch,
      encoding_format: "float",
    });

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers, body });
      } catch (err) {
        if (attempt >= this.maxRetries) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            `embeddings request to ${url} failed after ${attempt + 1} attempt(s): ${detail}`,
          );
        }
        await sleep(this.backoffMs(attempt, null));
        continue;
      }

      if (res.ok) {
        return this.toVectors((await res.json()) as EmbeddingsResponse, batch.length);
      }

      const snippet = (await res.text().catch(() => "")).slice(0, BODY_SNIPPET_CHARS);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) {
        throw new Error(
          `embeddings request to ${url} failed with status ${res.status}: ${snippet}`,
        );
      }
      if (attempt >= this.maxRetries) {
        throw new Error(
          `embeddings request to ${url} failed with status ${res.status}` +
            ` after ${attempt + 1} attempt(s): ${snippet}`,
        );
      }
      await sleep(this.backoffMs(attempt, res.headers.get("retry-after")));
    }
  }

  /** deterministic: 250ms * 2^attempt, Retry-After (seconds) wins, 30s cap */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    let ms = BASE_BACKOFF_MS * 2 ** attempt;
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1000;
    }
    return Math.min(ms, MAX_WAIT_MS);
  }

  private toVectors(json: EmbeddingsResponse, expected: number): Float32Array[] {
    const data = json.data;
    if (!Array.isArray(data) || data.length !== expected) {
      throw new Error(
        `embeddings response for model ${this.model} returned ` +
          `${Array.isArray(data) ? data.length : "no"} rows, expected ${expected}`,
      );
    }
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((row, i) => {
      const emb = row.embedding;
      if (!Array.isArray(emb)) {
        throw new Error(`embeddings response row ${i} has no embedding array`);
      }
      if (emb.length !== this.dim) {
        throw new Error(
          `embedding ${i} from model ${this.model} has dim ${emb.length}, expected ${this.dim}`,
        );
      }
      return Float32Array.from(emb);
    });
  }
}
