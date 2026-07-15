# Docket v0.1 specification

Status: D0 draft (2026-07-15). This document is the contract between modules.
Change it first, code second.

Docket is an embeddable, local-first retrieval and memory engine for business
correspondence: email threads and their attachments, retrieved months or years
later, with every answer traceable to frozen source bytes. TypeScript, SQLite
via better-sqlite3, no cloud dependency, no server required.

Design basis: the whole engine exists to score well on PaperTrail-Bench
(github.com/NienHQ/papertrail-bench) for honest reasons, so each layer maps to
an evidenced retrieval finding rather than a product trend.

## 1. Principles

1. **Evidence permanent, index disposable.** Raw RFC822 bytes and attachments
   are immutable, content-addressed blobs. Everything derived from them
   (fragments, chunks, embeddings, thread assignments) is cache that can be
   rebuilt with `reindex()`. Deleting the index never touches evidence.
2. **Citations resolve forever.** A chunk id is `chk_<blobHash>_<index>` for
   message chunks and `chk_<blobHash>_m<messageHash>_<index>` for attachment
   chunks (attachment blobs are deduplicated across messages, so their chunks
   are scoped per owning message). Every chunk carries a span into the decoded
   text of its blob. Because blobs are immutable, a citation held by an agent
   last year still resolves today.
3. **Superseded, never deleted.** Facts carry validity intervals. A new value
   for the same (entity, relation) key closes the old fact and opens a new one.
   The old fact remains queryable as of any past date.
4. **No single top-k call in the public API.** Retrieval is a set of tools an
   agent iterates with: filter, search, thread, timeline, source. The API shape
   teaches agentic retrieval because fixed top-k similarity provably collapses
   on bounded, self-correlated corpora.
5. **Deterministic by default.** With no embedder configured, Docket is fully
   deterministic (BM25 only). Embedders and contextualizers are pluggable and
   optional.

## 2. Storage layout

One directory holds the whole appliance state:

```
<dir>/
  docket.db          SQLite: all tables (schema.ts is the single source of DDL)
  objects/ab/cdef..  content-addressed store, git style, sha256 hex
```

Blob writes are atomic (write to temp, rename). A blob is never modified;
erasure for compliance is a tombstone row plus object file removal, recorded
in the audit log table.

**Concurrency contract: one writer, many readers.** SQLite runs in WAL mode,
so any number of read-only opens (`Docket.open(dir, { readonly: true })`)
may coexist with a single writer process; readers see consistent snapshots
and never block the writer. Two concurrent writers are NOT supported and are
the caller's responsibility to prevent. All connections set a 5 second
busy_timeout so brief lock contention retries instead of failing. A
read-only open requires the database to exist at the current schema version
(a writer must have migrated it first); every write surface on a read-only
instance throws. The MCP server opens read-only by default; pass --write to
enable the fact and entity write tools.

## 3. Layers and module boundaries

| layer | dir | owns |
|---|---|---|
| evidence store | `src/store/` | CAS objects, `blobs`, `documents`, tombstones, audit log |
| ingestion | `src/ingest/` | EML/mbox parsing, JWZ threading, quote/signature stripping, `messages`, `threads`, `attachments`, `fragments` |
| index | `src/indexer/` | chunking, contextual prefixes, `chunks`, FTS, `embeddings`, hybrid search, rerank |
| fact ledger | `src/ledger/` | `facts`, structural keying, as-of queries, event-time backfill |
| entities | `src/entities/` | `parties`, `party_addresses`, address resolution, timelines |
| tools + facade | `src/docket.ts`, `src/tools.ts` | the public API, wiring |
| MCP server | `src/mcp/` | tools exposed over MCP stdio |

Shared contracts live in `src/types.ts`. The full DDL lives in `src/schema.ts`.
Modules communicate only through the interfaces in types.ts and the database.

### 3.1 Evidence store (`src/store/`)

- `putBlob(bytes, meta)`: sha256, write CAS object if new, upsert `blobs` row.
  Returns hash. Duplicate content across N messages is one blob, N references.
- `getBlob(hash)`: bytes or null (tombstoned or missing).
- `tombstone(hash, reason)`: marks the row, deletes the object file, appends an
  `audit_log` row. Derived rows for that blob are purged.
- Logical documents: `documents` maps a business record (a lease, a PO chain)
  to a version chain of blob hashes with `supersedes` links. Optional layer:
  ingestion does not populate it; callers or downstream extractors do.

### 3.2 Ingestion (`src/ingest/`)

Pipeline per message: parse RFC822 (postal-mime), store raw bytes and each
attachment in the CAS, upsert `messages` + `message_recipients` +
`attachments`, thread it, strip quotes/signatures into `fragments`.

- **Threading is JWZ reconciliation, not parsing.** Group by Message-ID,
  In-Reply-To and References with empty-container placeholders, then a subject
  fallback pass (strip Re:/Fwd: prefixes, case-insensitive). References headers
  are treated as unreliable and possibly truncated. Threads get stable ids
  `thr_<hash of root message id>`.
- **Quote/signature stripping is heuristic and lossy.** Line-based heuristics
  (quote markers, "On ... wrote:" attribution lines, signature separators,
  trailing sign-off blocks). Fragments are typed `new | quote | signature`.
  Retrieval indexes `new` fragments; quotes are kept for provenance, and
  near-duplicate text is deduplicated downstream at the chunk layer.
- Out-of-order ingestion is expected (multi-year backfills). Threading must
  converge to the same thread assignments regardless of ingest order; the JWZ
  container pass runs over headers stored in the database, not in-memory state.
- Batch ingest never throws on bad input: inputs that fail to parse, are
  degenerate (no Message-ID, no From, no Date, empty body), or exceed the size
  cap are quarantined in `ingest_errors` (raw bytes still stored in the CAS
  when possible) and the batch continues. `BatchOptions.onError` surfaces each
  quarantine to the caller; the table is queryable via `sqlFilter`. The
  single-message `emlBytes` path still throws on parse failure (a programming
  error at that call site, not archive noise).

### 3.3 Index (`src/indexer/`)

- **Chunks.** Message chunks come from `new` fragments (length-capped,
  paragraph-aligned). Attachment chunks come from decoded attachment text when
  the mime type is textual, or from a registered `AttachmentParser` (e.g. the
  PDF text extractor) otherwise. Parsed text is a derived artifact cached in
  `parse_cache` keyed (blob hash, tool, tool version): reindex reuses it,
  tombstone purges it, bumping the parser version invalidates it. Spans of
  parser-derived chunks index into the parsed text (reproducible for the same
  tool and version over the frozen blob); message and text-attachment chunk
  spans index into the decoded source text. Scanned PDFs with no text layer
  yield empty text and are skipped (OCR stays pluggable, not shipped).
- **Contextual prefixes.** Every chunk gets a `context` string prepended at
  index time (stored separately, never mixed into the source text). The default
  contextualizer is deterministic metadata: sender, recipient, date, subject,
  attachment filename. An async LLM contextualizer can be plugged in; when it
  declares `cacheable: true` its output is cached in `context_cache` keyed
  (chunk id, tool, tool version), so reindex never re-pays LLM cost and a
  version bump invalidates. Tombstone and replaced-message purges remove
  cached context along with the content.
- **FTS** over `context || text` via SQLite FTS5 (porter tokenizer), BM25.
- **Vectors** are optional. If an `Embedder` is configured, chunk embeddings
  go to the `embeddings` table (float32 blob). Vector search uses sqlite-vec
  when loadable, else a linear scan fallback (fine at SME scale).
- **Hybrid search**: BM25 list + vector list merged with reciprocal rank
  fusion, then feature reranked. Rerank features, equal weighted: fused RRF
  score, query-token overlap with context+text, recency, and thread coherence
  (does the chunk's thread contain other candidates). Hybrid without rerank is
  known to underperform, so `hybridSearch` always reranks.
- Filters are first-class: party, address, date range, thread, source kind
  (message vs attachment), mime prefix. Filtering happens in SQL before
  ranking, not after.
- **Near-duplicate suppression** (on by default, `dedupe: false` opts out):
  after reranking, candidates whose normalized text is near-identical
  (shingle Jaccard) collapse into one hit. The primary is the EARLIEST
  message's chunk (provenance points at the original assertion, not a quoted
  copy); it inherits the cluster's best score, and the folded copies are
  listed in `duplicates`. Deterministic: same corpus, same query, same
  clusters.

### 3.4 Fact ledger (`src/ledger/`)

Bi-temporal, append-only:

- Event time: `valid_from`, `valid_to` (null = still valid).
- Ingestion time: `created_at`, `expired_at` (null = current belief).

`assert({entity, relation, value, validFrom, source})` uses structural keying:
same (entity, relation) closes the previous open fact (sets `valid_to` and
expires the superseded belief) and inserts the new one. `asOf(entity, relation,
date)` answers point-in-time queries. `backfill(facts[])` sorts by event time
before asserting, which is the correct behavior for out-of-order archives.
Every fact must carry a source: a chunk id or message id. Facts without
provenance are rejected.

### 3.5 Entities (`src/entities/`)

Deterministic address book: `parties` (companies/people we care about) and
`party_addresses` (address to party mappings with validity windows, because
people change companies). `resolve(address, date?)` returns the party.
`timeline(partyId)` is a SQL view merge: facts, documents, message activity,
ordered by time. No knowledge graph.

### 3.6 Tools and facade

```ts
const dk = await Docket.open(dir, { embedder?, contextualizer? })
await dk.ingest.emlBytes(bytes)
await dk.ingest.mboxFile(path)
await dk.ingest.dir(path)            // *.eml files
await dk.reindex()                    // rebuild all derived state from blobs

dk.tools.sqlFilter({ table, where, limit })     // structured, injection-safe
dk.tools.hybridSearch({ query, k, filter })     // always reranked
dk.tools.getThread(threadId)                    // ordered messages + fragments
dk.tools.getEntityTimeline(partyId, range?)
dk.tools.getSource(chunkId)                     // frozen bytes + span + meta

dk.facts.assert(...) / dk.facts.asOf(...) / dk.facts.history(entity, relation)
dk.entities.addParty(...) / dk.entities.mapAddress(...) / dk.entities.resolve(...)
```

`sqlFilter` accepts a whitelisted table name and structured conditions
(column, op, value) compiled to a prepared statement. Raw SQL is never
accepted from callers.

`hybridSearch` accepts `expand: "thread"` to attach bounded surrounding
context to each hit (the email-shaped version of parent-document
retrieval): up to 2 messages each side of the hit's message within its
thread, ordered by sent time, the hit's own message excluded, each
entry's stripped new text capped at 1200 chars. Default is `"none"`;
agents that need the full thread still call `getThread`.

### 3.7 MCP server (`src/mcp/`)

Stdio MCP server exposing the five tools plus fact queries, one Docket dir per
server process. Tool inputs validated with zod. Start with:
`node dist/mcp/server.js --dir <path>`.

## 4. Explicit non-goals (v0.1)

Knowledge graph, UI, cloud/multi-tenant service, extract-and-compress memory,
PDF/OCR parsing (interface exists, implementation later), write access to any
external system.

## 5. Invariants (enforced by tests)

1. Ingest is idempotent: re-ingesting the same bytes changes nothing.
2. Threading is ingest-order independent.
3. `reindex()` after index-table wipe reproduces identical chunk ids and spans.
4. `getSource(chunkId)` returns bytes whose decoded span equals the chunk text.
5. Fact ledger: per key, intervals non-overlapping, at most one open interval,
   superseded facts remain queryable as of past dates.
6. Tombstoned blobs are unreadable, their derived rows gone, and the audit log
   records the erasure.
7. With no embedder configured, all tool outputs are deterministic.

## 6. Bench tie-in

The e2e test ingests a small PaperTrail-Bench corpus (committed fixture) and
answers sampled category 1 to 3 questions using only the public tools, checking
answers and citation spans against the corpus ground truth. This is the D1
target moved into CI at fixture scale.
