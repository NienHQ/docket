/**
 * Reference Embedder implementations, published under the "./embedders"
 * subpath. Both real adapters keep their dependencies optional: LocalEmbedder
 * dynamic-imports the transformers.js peer, OpenAiEmbedder uses global fetch.
 * HashEmbedder is re-exported for tests and offline determinism.
 */
export { LocalEmbedder, type LocalEmbedderOptions } from "./local.js";
export { OpenAiEmbedder, type OpenAiEmbedderOptions } from "./openai.js";
export { HashEmbedder } from "../indexer/embedder.js";
