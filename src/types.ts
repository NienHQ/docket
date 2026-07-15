/**
 * Shared contracts between modules. Implementation agents code against these;
 * breaking changes here require updating docs/spec.md first.
 */

// ---------------------------------------------------------------- primitives

/** sha256 hex of raw bytes */
export type BlobHash = string;
/** chk_<blobHash>_<index> */
export type ChunkId = string;
/** thr_<hash> */
export type ThreadId = string;
/** RFC5322 Message-ID with angle brackets stripped */
export type MessageId = string;

export interface Span {
  start: number;
  end: number; // exclusive, char offsets into decoded text
}

// ------------------------------------------------------------ evidence store

export interface BlobMeta {
  mime: string;
  source:
    | { kind: "message"; messageId: MessageId }
    | { kind: "attachment"; messageId: MessageId; attIndex: number; filename?: string };
}

export interface EvidenceStore {
  putBlob(bytes: Uint8Array, meta: BlobMeta): BlobHash;
  getBlob(hash: BlobHash): Uint8Array | null;
  hasBlob(hash: BlobHash): boolean;
  /** Erase content for compliance: tombstone row, delete object, audit entry. */
  tombstone(hash: BlobHash, reason: string): void;
}

// ----------------------------------------------------------------- ingestion

export interface IngestResult {
  messageId: MessageId;
  threadId: ThreadId;
  blobHash: BlobHash;
  attachments: number;
  /** false when the exact message id + bytes were already present */
  fresh: boolean;
}

export interface IngestError {
  blobHash: BlobHash | null;
  reason: "parse_error" | "degenerate" | "oversize";
  detail: string;
}

export interface BatchOptions {
  /** messages per write transaction, default 500 */
  batchSize?: number;
  /** called after each committed batch */
  onProgress?: (done: number, total: number) => void;
  /** called for each quarantined input; the row also lands in ingest_errors */
  onError?: (error: IngestError) => void;
}

export interface Ingestor {
  emlBytes(bytes: Uint8Array): Promise<IngestResult>;
  emlFile(path: string): Promise<IngestResult>;
  mboxFile(path: string, opts?: BatchOptions): Promise<IngestResult[]>;
  /** ingest every *.eml under a directory (recursive, sorted for determinism) */
  dir(path: string, opts?: BatchOptions): Promise<IngestResult[]>;
}

export type FragmentKind = "new" | "quote" | "signature";

export interface Fragment {
  fragmentId: string;
  messageId: MessageId;
  kind: FragmentKind;
  span: Span; // into messages.body_text
  text: string;
}

// --------------------------------------------------------------------- index

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface ChunkDraft {
  blobHash: BlobHash;
  chunkIndex: number;
  sourceKind: "message" | "attachment";
  messageId?: MessageId;
  span: Span;
  text: string;
  meta: Record<string, string>;
}

/**
 * Turns non-text attachment bytes into indexable text. Results are cached in
 * parse_cache keyed (blob hash, tool, version); bumping version invalidates.
 * Spans of chunks built from parsed attachments index into the parsed text,
 * which is reproducible given the same (tool, version) over the frozen blob.
 */
export interface AttachmentParser {
  readonly tool: string;
  readonly version: string;
  /** exact mime types this parser handles, e.g. ["application/pdf"] */
  readonly mimes: string[];
  parse(bytes: Uint8Array): Promise<{ text: string; meta?: Record<string, string> }>;
}

/** Produces the contextual prefix stored alongside (never inside) chunk text. */
export interface Contextualizer {
  readonly tool: string;
  readonly version: string;
  contextualize(chunk: ChunkDraft): Promise<string>;
}

export interface SearchFilter {
  fromAddress?: string;
  partyId?: string;
  threadId?: ThreadId;
  after?: string; // ISO date, inclusive
  before?: string; // ISO date, exclusive
  sourceKind?: "message" | "attachment";
  mime?: string; // prefix match on the source blob's mime type
}

export interface SearchHit {
  chunkId: ChunkId;
  score: number;
  text: string;
  context: string;
  messageId?: MessageId | undefined;
  threadId?: ThreadId | undefined;
  sentAt?: string | undefined;
  features: Record<string, number>;
}

export interface Indexer {
  /** (re)index chunks + FTS + embeddings for one blob's decoded text */
  indexMessage(messageId: MessageId): Promise<void>;
  indexAttachment(messageId: MessageId, attIndex: number): Promise<void>;
  hybridSearch(q: {
    query: string;
    k?: number;
    filter?: SearchFilter;
  }): Promise<SearchHit[]>;
}

// -------------------------------------------------------------------- ledger

export type FactValue = string | number | boolean | Record<string, unknown>;

export interface FactInput {
  entity: string;
  relation: string;
  value: FactValue;
  validFrom: string; // ISO date, event time
  source: { chunkId?: ChunkId; messageId?: MessageId };
}

export interface FactRow {
  factId: number;
  entity: string;
  relation: string;
  value: FactValue;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  expiredAt: string | null;
  sourceChunk: ChunkId | null;
  sourceMessage: MessageId | null;
}

export interface FactLedger {
  assert(input: FactInput): FactRow;
  /** sorts by validFrom before asserting: correct under out-of-order backfill */
  backfill(inputs: FactInput[]): FactRow[];
  asOf(entity: string, relation: string, date: string): FactRow | null;
  history(entity: string, relation: string): FactRow[];
}

// ------------------------------------------------------------------ entities

export interface Party {
  partyId: string;
  name: string;
  kind: string;
}

export interface TimelineEntry {
  at: string;
  type: "fact" | "document" | "message";
  ref: string; // fact id, doc id or message id
  summary: string;
}

export interface Entities {
  addParty(party: Party): void;
  mapAddress(m: {
    address: string;
    partyId: string;
    person?: string;
    fromDate?: string;
    toDate?: string;
  }): void;
  resolve(address: string, date?: string): Party | null;
  timeline(partyId: string, range?: { after?: string; before?: string }): TimelineEntry[];
}

// --------------------------------------------------------------------- tools

export type FilterOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "like";

export interface SqlFilterQuery {
  table:
    | "messages"
    | "threads"
    | "documents"
    | "facts"
    | "attachments"
    | "parties"
    | "ingest_errors";
  where?: Array<{ column: string; op: FilterOp; value: string | number }>;
  orderBy?: { column: string; dir: "asc" | "desc" };
  limit?: number; // default 50, max 500
}

export interface ThreadView {
  threadId: ThreadId;
  subject: string;
  messages: Array<{
    messageId: MessageId;
    sentAt: string | null;
    fromName: string;
    fromAddress: string;
    newText: string; // concatenated 'new' fragments
    attachments: Array<{ attIndex: number; filename: string; blobHash: BlobHash }>;
  }>;
}

export interface SourceView {
  chunkId: ChunkId;
  blobHash: BlobHash;
  span: Span;
  text: string; // chunk text, equals decoded blob text at span
  mime: string;
  messageId?: MessageId | undefined;
  raw: Uint8Array; // frozen source bytes
}

export interface Tools {
  sqlFilter(q: SqlFilterQuery): Array<Record<string, unknown>>;
  hybridSearch(q: {
    query: string;
    k?: number;
    filter?: SearchFilter;
  }): Promise<SearchHit[]>;
  getThread(threadId: ThreadId): ThreadView | null;
  getEntityTimeline(
    partyId: string,
    range?: { after?: string; before?: string },
  ): TimelineEntry[];
  getSource(chunkId: ChunkId): SourceView | null;
}

export interface DocketOptions {
  embedder?: Embedder;
  contextualizer?: Contextualizer;
  /** attachment parsers for non-text mimes (e.g. the PDF text extractor) */
  parsers?: AttachmentParser[];
  /**
   * Open as a reader: no ingest, no facts/entities writes, no tombstone,
   * no reindex. Many readonly opens may coexist with one writer (WAL).
   * The database must already exist and be at the current schema version.
   */
  readonly?: boolean;
}
