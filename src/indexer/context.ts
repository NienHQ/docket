import type { ChunkDraft, Contextualizer } from "../types.js";

/**
 * Default deterministic contextualizer: metadata only, no model in the loop
 * (spec principle 5). Reads the meta the indexer put on the draft.
 */
export class MetaContextualizer implements Contextualizer {
  readonly tool = "meta";
  readonly version = "1";

  async contextualize(chunk: ChunkDraft): Promise<string> {
    const m = chunk.meta;
    if (chunk.sourceKind === "attachment") {
      return (
        `Attachment ${m["filename"] ?? ""} of email from ${m["from"] ?? ""} ` +
        `on ${m["date"] ?? ""}, subject: ${m["subject"] ?? ""}.`
      );
    }
    return (
      `Email from ${m["from"] ?? ""} to ${m["to"] ?? ""} ` +
      `on ${m["date"] ?? ""}, subject: ${m["subject"] ?? ""}.`
    );
  }
}
