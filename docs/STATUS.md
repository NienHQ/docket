# Status

Read this first when resuming work. The roadmap with per-task acceptance
criteria is [plan.md](plan.md); claim tasks here (see the claiming
convention at the bottom of the plan).

## In progress

- 2.5 thread-context expansion (claimed 2026-07-15)

## Blocked (credentials, see docs/RELEASING.md)

- 1.1 CI pipeline: pushing .github/workflows requires the workflow OAuth
  scope on the local gh token. Unblock with: gh auth refresh -h github.com
  -s workflow (interactive). Workflow YAML is otherwise ready to write.
- 1.7 publish step only: needs npm login and the nienhq org/scope on npm.
  Everything else is done and proven by pnpm verify:pack; publish is
  npm publish --access public per docs/RELEASING.md.

## 2026-07-15 - task 2.4 done: near-duplicate suppression

- Post-rerank, pre-cut dedupe stage (default on, dedupe: false opts
  out): 5-token shingle Jaccard >= 0.9 or exact normalized equality
  clusters candidates via deterministic union-find; primary = earliest
  message (provenance points at the original), inherits cluster max
  score; folded copies in SearchHit.duplicates; collapsing frees top-k
  slots. Exposed through tools and MCP. Suite: 111 tests + 1 skip.

## 2026-07-15 - task 2.3 done: LLM contextualizer with cache

- LlmContextualizer: caller-supplied complete(), no vendor SDK;
  deterministic prompt from chunk meta + text; empty replies fall back
  to the metadata contextualizer (fallback cached by design).
- context_cache (schema v5) keyed (chunk id, tool, version); chunk ids
  now minted in one shared helper so cache lookups and inserts cannot
  drift. Reindex is a 100 percent cache hit (asserted); version bump
  re-pays; tombstone and replaced-message purges remove cached context.
  Suite: 104 tests + 1 env-flagged skip.

## 2026-07-15 - task 2.2 done: embedder adapters + reembed

- src/embedders/ subpath: OpenAiEmbedder (fetch-based, batching, 429/5xx
  retry with Retry-After, tested against a local mock server) and
  LocalEmbedder (transformers.js via optional peer dep, lazy import,
  real-model test env-flagged behind DOCKET_LOCAL_EMBEDDER=1).
- dk.reembed() fills missing vectors for the configured model from
  stored chunk text, no re-chunk/re-parse. Schema v4 re-keys embeddings
  to PK (chunk_id, model) so models coexist side by side (needed for the
  M3 ablation work). Suite: 96 tests + 1 env-flagged skip.

## 2026-07-15 - task 2.1 done: attachment parsers + PDF text

- AttachmentParser interface + DocketOptions.parsers; PdfTextParser
  (pdfjs-dist ^5, dynamic import so the core never loads it; 5.x not 6.x
  to keep the Node 20 floor). Parsed text cached in parse_cache (schema
  v3) keyed (blob, tool, version): reindex reuses, version bump
  invalidates, tombstone purges. Scanned PDFs cache empty text and index
  nothing; parser throws are contained. Committed sub-KiB PDF fixtures +
  scripts/make-pdf-fixtures.mjs. Suite: 86 tests.
- Known gap for later: no stats surface for skipped/failed parses.

## 2026-07-15 - task 1.7 prep done: publish-ready packaging

- docket-mcp bin (shebang + symlink-safe main-module guard), exports map
  verified, files audit, sideEffects false, keywords; CHANGELOG.md
  (keep-a-changelog), docs/RELEASING.md runbook, README install section.
- scripts/verify-pack.mjs proves it end to end: tarball is dist +
  metadata only (37.3 KiB, 48 files), installs into a scratch project,
  library smoke passes through the installed package, and the installed
  bin serves MCP over stdio. Suite: 79 tests + verify:pack PASS.

## 2026-07-15 - task 1.6 done: stepped schema migrations

- schema.ts is now an append-only migration ledger: frozen v1 DDL, v2
  adds ingest_errors, SCHEMA_VERSION computed from the last step. Each
  step runs in its own transaction; databases newer than the build are
  rejected on open. The append-only rule is documented above the array.
- Committed v1 fixture db (30 KiB) + scripts/make-v1-fixture.mjs;
  tests prove forward migration preserves data, schema parity with a
  fresh v2 db, and end-to-end function after migration. Suite: 79 tests.

## 2026-07-15 - task 1.5 done: concurrency contract

- One writer, many readers, enforced: Docket.open({ readonly: true })
  requires an existing db at the current schema version, every write
  surface rejects/throws, busy_timeout 5000 on all connections. Contract
  documented in spec section 2.
- MCP server opens read-only by default; --write registers
  docket_fact_assert and docket_entity_map.
- tests/concurrency.test.ts: writer + two readers with WAL visibility,
  all guards, old-schema rejection, cross-process reader via dist.
  Suite: 73 tests.

## 2026-07-15 - task 1.4 done: malformed input quarantine

- Batch ingest never throws: oversize (64 MiB cap, checked before parse),
  parse_error (bytes preserved in CAS), and degenerate (no id, no from, no
  date, empty body) inputs land in the new ingest_errors table (schema v2),
  deduped per (blob_hash, reason), surfaced via BatchOptions.onError and
  sqlFilter. Single-message emlBytes throws instead (caller error, not
  archive noise). tests/quarantine.test.ts: poisoned-corpus accounting.
  Suite: 66 tests.

## 2026-07-15 - task 1.3 done: ingest at scale

- BatchOptions (batchSize, onProgress) on mboxFile/dir: parse per batch,
  then one write transaction per batch; parse errors skip the message
  instead of sinking the batch (formal quarantine lands in 1.4).
- scripts/perf.mjs: self-contained seeded corpus generator + measurement.
  Recorded in docs/perf.md (Ryzen 9 9950X3D): 15k messages ingested in
  62s (244 msg/s), search p50 25ms / p95 31ms, reindex 61s. Both plan
  targets met. Known cost center: FTS maintenance dominates at scale.
- tests/batch.test.ts: batched equals one-by-one, progress, idempotency,
  poisoned member. Suite: 58 tests.
- Weekly CI perf job deferred until 1.1 unblocks (gh workflow scope).

## 2026-07-15 - task 1.2 done: incremental threading

- Single-message ingest now runs rethreadIncremental: BFS over the header id
  graph plus thread and subject closure, recomputing only the affected
  cluster. rethreadAll stays as the reindex fallback and the test oracle.
- tests/threading.test.ts: property test (6 seeded shuffles, oracle equality
  after every prefix) plus bridge, late-parent re-root, and subject-fallback
  merge cases. Suite: 54 tests.

## 2026-07-15 - v0.1 core built

- All six layers implemented per [spec.md](spec.md): evidence store (CAS +
  tombstones + audit log), ingestion (postal-mime, JWZ threading, quote/sig
  stripping, mbox), index (contextual chunks, FTS5 + optional sqlite-vec,
  hybrid RRF + feature rerank), bi-temporal fact ledger, entities, tools
  facade, MCP server.
- 48 tests: unit per module, 10 regression tests from an adversarial review
  pass (reindex/tombstone/mbox/dedup/HTML edge cases), and an e2e that ingests
  a PaperTrail-Bench fixture (248 messages) and answers 12 of 12 sampled
  category 1 to 3 questions using only the public tools, citations verified
  against ground truth.
- Deterministic without an embedder, including rerank scores (recency anchors
  to the newest candidate, not the wall clock).

## Next

See [plan.md](plan.md). Milestone 1 (production hardening: CI,
incremental threading, scale, malformed input, concurrency contract,
migrations, npm release) comes before feature work.
