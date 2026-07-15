# Status

Read this first when resuming work. The roadmap with per-task acceptance
criteria is [plan.md](plan.md); claim tasks here (see the claiming
convention at the bottom of the plan).

## In progress

- 1.6 schema migrations (claimed 2026-07-15)

## Blocked

- 1.1 CI pipeline: pushing .github/workflows requires the workflow OAuth
  scope on the local gh token. Unblock with: gh auth refresh -h github.com
  -s workflow (interactive). Workflow YAML is otherwise ready to write.

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
