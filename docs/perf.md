# Ingest and search performance

Numbers from the synthetic-corpus harness in `scripts/perf.mjs` (plan task
1.3). The harness generates a deterministic corpus with a seeded PRNG
(threads of 1 to 8 messages, ~200 senders across 40 domains, 20 percent
with a text attachment), writes it as an mbox, then ingests and searches
through the public `Docket` API. Rerun with:

```
pnpm build
node scripts/perf.mjs --messages 15000
```

## Recorded run

Environment: AMD Ryzen 9 9950X3D 16-Core Processor, Linux, Node v24.15.0.
Command: `node scripts/perf.mjs --messages 15000` (seed 42, batchSize 500,
no embedder, sqlite-vec absent so vector search is not exercised).

| metric | value |
| --- | --- |
| messages ingested | 15000 |
| ingest wall time | 1m 1.6s |
| ingest rate | 243.7 msg/s |
| docket.db size | 224.7 MiB |
| objects/ size | 42.1 MiB |
| search p50 (200 queries, k=10) | 25.0 ms |
| search p95 | 30.6 ms |
| search max | 33.5 ms |
| reindex wall time | 1m 0.7s |

Ingest wall time here is end to end: mbox split, MIME parse, blob writes,
batched message inserts, one rethread pass, and the facade's chunk plus FTS
indexing pass. Search latency is `tools.hybridSearch` with k=10 and no
embedder (FTS plus recency/thread features only).

## Plan targets

- 15k messages ingested in minutes, not hours, on a laptop: met. One minute
  on this desktop; even a laptop several times slower stays well inside
  "minutes".
- Search p95 under 100 ms without embedder: met (30.6 ms at 15k messages).

## Observations

- The post-ingest indexing pass (chunking plus `chunks_fts` inserts)
  dominates wall time, not the raw message inserts: `reindex()`, which is
  purely derived-state rebuild, takes about the same time as the full
  ingest. That is the first place to look when scaling past 15k.
- Throughput drops as the corpus grows (about 1500 msg/s at 2k messages,
  about 240 msg/s at 15k), consistent with FTS index maintenance cost
  growing with table size.
- The db is roughly 5x the size of the raw evidence, mostly chunk text and
  the FTS index; acceptable for now, revisit if archives exceed a few
  hundred thousand messages.
