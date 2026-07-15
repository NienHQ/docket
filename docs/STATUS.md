# Status

Read this first when resuming work.

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

- Run against the full PaperTrail-Bench corpus once its harness (B1) exists;
  publish numbers vs BM25-only and naive-vector baselines.
- Pluggable PDF/OCR attachment parser interface (text/* only today).
- LLM contextualizer example (interface is in, default is deterministic
  metadata).
- Entity resolution beyond exact address windows (bench category 5).
- npm publish as @nienhq/docket once the API settles.
