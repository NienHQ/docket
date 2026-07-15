# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the 0.x caveat: while the major version is 0, a minor bump may contain
breaking changes.

## [Unreleased]

## [0.1.0] - 2026-07-15

### Added

- Evidence store: content-addressed blob storage (sha256, git-style object
  layout), immutable evidence, tombstone erasure with an audit log. All
  derived state is rebuildable from evidence via `reindex()`.
- Ingestion: RFC822 eml and mbox parsing (postal-mime), JWZ threading with
  subject fallback and incremental per-message rethreading, quote and
  signature stripping, batched dir/mbox ingest (chunked transactions,
  progress callbacks).
- Malformed input quarantine: batch ingest never throws. Oversize (64 MiB
  cap), unparseable, and degenerate messages land in the `ingest_errors`
  table, deduped per (blob hash, reason), with counts surfaced in results.
- Hybrid search: contextual chunks (sender, date, subject, filename
  prefixes), SQLite FTS5 BM25, optional sqlite-vec vectors, reciprocal rank
  fusion, always-on feature rerank. Fully deterministic without an embedder.
- Bi-temporal fact ledger: event-time validity plus ingestion-time belief
  intervals, supersede-never-delete, as-of and history queries, mandatory
  source citations.
- Entities: parties, address mappings with validity windows, chronological
  entity timelines.
- Agent tools facade: hybridSearch, sqlFilter, getThread, getSource,
  getEntityTimeline, fact asOf/history/assert. Citations
  (`chk_<hash>_<n>` plus span) resolve to frozen source bytes forever.
- MCP stdio server with a `docket-mcp` bin: seven read tools by default;
  `--write` adds `docket_fact_assert` and `docket_entity_map`.
- Concurrency contract: one writer, many readers (WAL),
  `Docket.open(dir, { readonly: true })`, busy_timeout 5000, every write
  surface throws on a read-only instance.
- Stepped schema migrations: append-only migration ledger with per-step
  transactions; databases newer than the build are rejected on open;
  committed v1 fixture proves forward migration.
- Performance (Ryzen 9 9950X3D, no embedder): 15k messages ingested in
  62 s, search p50 25 ms / p95 31 ms. Numbers and harness in docs/perf.md.
- Test suite: 79 tests, including an end-to-end run that ingests a
  PaperTrail-Bench fixture (248 messages) and answers 12 of 12 sampled
  questions with citations verified against ground truth.

### Fixed

- Reindex, tombstone, mbox parsing, attachment dedup, and HTML decoding
  edge cases found in an adversarial review pass, each pinned by a
  regression test.

[Unreleased]: https://github.com/NienHQ/docket/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NienHQ/docket/releases/tag/v0.1.0
