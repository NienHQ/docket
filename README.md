# Docket

An embeddable, local-first retrieval and memory engine for business
correspondence. Ingest years of email and attachments, then let agents query
them with provable provenance: every answer traces to frozen source bytes.

TypeScript, SQLite (better-sqlite3 + FTS5, optional sqlite-vec), runs fully
in-process. No Docker sidecar, no cloud, no server.

**Status: v0.1, early.** APIs will move. Built against
[PaperTrail-Bench](https://github.com/NienHQ/papertrail-bench).

## Install

```sh
pnpm add @nienhq/docket    # or: npm install @nienhq/docket
```

Not yet on npm: the first release is pending. Installing from a git
checkout works today:

```sh
git clone https://github.com/NienHQ/docket && cd docket
pnpm install && pnpm build && pnpm pack
# then, in your project:
pnpm add /path/to/docket/nienhq-docket-0.1.0.tgz
```

Requires Node >= 20. better-sqlite3 is a native dependency; prebuilt
binaries cover common platforms, otherwise a C++ toolchain is needed.

## Why

Engines in this space (RAGFlow, R2R) are Python services you deploy next to
your app. If your app is TypeScript and your data is one company's mail
archive, that is a heavy dependency for what is fundamentally a library
problem. Docket is `pnpm add @nienhq/docket` and a directory on disk.

The design encodes what the retrieval literature actually supports:

- **Evidence permanent, index disposable.** Raw RFC822 and attachment bytes
  are immutable, content-addressed blobs. Chunks, embeddings and thread
  assignments are rebuildable cache. Citations (`chk_<hash>_<n>` + span)
  resolve forever, which is what audit and compliance stories need.
- **Agentic retrieval, not top-k.** The public API is a set of tools an agent
  iterates with (filter, search, thread, timeline, source). Fixed top-k
  similarity search demonstrably collapses on bounded, self-correlated
  corpora like a mail archive.
- **Hybrid + rerank.** BM25 and vectors merged with reciprocal rank fusion,
  then feature-reranked. Hybrid without reranking underperforms; reranking is
  always on.
- **Contextual chunks.** Every chunk carries a metadata prefix (sender, date,
  subject, filename) indexed alongside the text: the cheapest known precision
  lever for this corpus shape.
- **Bi-temporal fact ledger.** Facts carry event-time validity and
  ingestion-time belief intervals. New values supersede, never delete. "What
  were the payment terms with X as of March 2025" is one query.
- **Threads are reconciled, not parsed.** JWZ threading over Message-ID,
  References and In-Reply-To with subject fallback, converging to the same
  result regardless of ingest order.
- **No knowledge graph.** Entity resolution is an address book with validity
  windows; timelines are SQL, not graph traversal.

## Quick start

```ts
import { Docket } from "@nienhq/docket";

const dk = await Docket.open("./mail-archive");

await dk.ingest.dir("./exports/2024");        // *.eml files
await dk.ingest.mboxFile("./exports/all.mbox");

// agent-facing tools
const hits = await dk.tools.hybridSearch({
  query: "payment terms Northgate",
  k: 8,
  filter: { after: "2024-01-01" },
});
const thread = dk.tools.getThread(hits[0].threadId);
const source = dk.tools.getSource(hits[0].chunkId); // frozen bytes + span

// fact ledger
dk.facts.assert({
  entity: "party:northgate",
  relation: "payment_terms",
  value: "NET45",
  validFrom: "2024-07-01",
  source: { chunkId: hits[0].chunkId },
});
dk.facts.asOf("party:northgate", "payment_terms", "2024-03-15"); // pre-change value
```

Vector search activates when you plug in an embedder (any model, local or
API); without one, Docket is deterministic BM25 and still useful.

```ts
const dk = await Docket.open(dir, { embedder: myEmbedder });
```

## MCP server

The package ships a `docket-mcp` bin (stdio) exposing the same tools to any
MCP client. It opens the directory read-only by default, so any number of
servers can sit next to one writer process; pass `--write` to also register
the fact and entity write tools:

```sh
docket-mcp --dir ./mail-archive           # read-only (default)
docket-mcp --dir ./mail-archive --write   # adds docket_fact_assert, docket_entity_map
```

From a git checkout, `node dist/mcp/server.js --dir ./mail-archive` is the
same thing.

## Storage

One directory holds everything: `docket.db` (SQLite) plus a git-style
content-addressed object store. Back it up with anything that copies files.
Erasure for compliance is `tombstone(hash, reason)`: content gone, audit log
entry kept.

## Development

```sh
pnpm install
pnpm test        # vitest, includes an e2e against a PaperTrail-Bench fixture
pnpm typecheck
pnpm build
```

Design doc: [docs/spec.md](docs/spec.md). Non-goals for v0.1: knowledge
graphs, UI, cloud service, extract-and-compress memory, OCR (pluggable
interface only).

## License

MIT.
