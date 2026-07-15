# Status

Read this first when resuming work. The roadmap with per-task acceptance
criteria is [plan.md](plan.md); claim tasks here (see the claiming
convention at the bottom of the plan).

## In progress

- 1.2 incremental threading (claimed 2026-07-15)

## Blocked

- 1.1 CI pipeline: pushing .github/workflows requires the workflow OAuth
  scope on the local gh token. Unblock with: gh auth refresh -h github.com
  -s workflow (interactive). Workflow YAML is otherwise ready to write.

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
