import type { ChunkDraft, Contextualizer } from "../types.js";
import { MetaContextualizer } from "./context.js";

/** Longest excerpt slice included in the prompt. */
const EXCERPT_CAP = 1500;

/** Meta keys included in the prompt, in this order, when present and non-empty. */
const PROMPT_META: ReadonlyArray<{ key: string; label: string }> = [
  { key: "from", label: "From" },
  { key: "to", label: "To" },
  { key: "date", label: "Date" },
  { key: "subject", label: "Subject" },
  { key: "filename", label: "Filename" },
  { key: "parser", label: "Parser" },
  { key: "parserVersion", label: "Parser version" },
];

const INSTRUCTION =
  "Write one short sentence situating this excerpt from business correspondence" +
  " for retrieval. Mention the parties, date, document type and reference numbers" +
  " if present. Reply with the sentence only.";

export interface LlmContextualizerOptions {
  /** Model call, supplied by the caller; no vendor SDK lives in the engine. */
  complete: (prompt: string) => Promise<string>;
  /** Cache key component; bump to invalidate cached contexts. Default "1". */
  version?: string;
  /** Hard cap on the stored context, in chars. Default 240. */
  maxLength?: number;
}

/**
 * Model-backed contextualizer (spec 3.3). Builds a deterministic prompt from
 * the chunk draft, hands it to the caller-supplied complete(), and normalizes
 * the reply into a single capped line. Declares cacheable, so the indexer
 * stores results in context_cache keyed (chunk id, tool, version) and reindex
 * never re-pays the model cost. An empty reply falls back to the
 * deterministic MetaContextualizer output for the same chunk; the fallback is
 * cached too, by design: the model said nothing useful once, so it is not
 * asked again under the same version.
 */
export class LlmContextualizer implements Contextualizer {
  readonly tool = "llm-context";
  readonly version: string;
  readonly cacheable = true;

  private readonly complete: (prompt: string) => Promise<string>;
  private readonly maxLength: number;
  private readonly fallback = new MetaContextualizer();

  constructor(opts: LlmContextualizerOptions) {
    this.complete = opts.complete;
    this.version = opts.version ?? "1";
    this.maxLength = opts.maxLength ?? 240;
  }

  async contextualize(chunk: ChunkDraft): Promise<string> {
    const raw = await this.complete(this.buildPrompt(chunk));
    const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, this.maxLength).trimEnd();
    if (cleaned.length === 0) return this.fallback.contextualize(chunk);
    return cleaned;
  }

  /** Deterministic: same draft, same prompt, byte for byte. */
  private buildPrompt(chunk: ChunkDraft): string {
    const lines: string[] = [INSTRUCTION];
    for (const { key, label } of PROMPT_META) {
      const value = chunk.meta[key];
      if (value !== undefined && value.length > 0) lines.push(`${label}: ${value}`);
    }
    lines.push("Excerpt:");
    lines.push(chunk.text.slice(0, EXCERPT_CAP));
    return lines.join("\n");
  }
}
