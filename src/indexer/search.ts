import type { DocketDb } from "../db.js";
import type { Embedder, SearchFilter, SearchHit } from "../types.js";

const CANDIDATE_LIMIT = 50;
const RRF_K = 60;
const MS_PER_DAY = 86_400_000;

interface CompiledFilter {
  /** starts with " AND " when non-empty, appended after the query condition */
  sql: string;
  params: unknown[];
}

/** Filters compile to SQL over chunks c joined to messages m (spec 3.3: filter before ranking). */
function compileFilter(filter: SearchFilter | undefined): CompiledFilter {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter) {
    if (filter.fromAddress !== undefined) {
      conds.push("m.from_address = ?");
      params.push(filter.fromAddress);
    }
    if (filter.threadId !== undefined) {
      conds.push("m.thread_id = ?");
      params.push(filter.threadId);
    }
    if (filter.after !== undefined) {
      conds.push("m.sent_at >= ?");
      params.push(filter.after);
    }
    if (filter.before !== undefined) {
      conds.push("m.sent_at < ?");
      params.push(filter.before);
    }
    if (filter.sourceKind !== undefined) {
      conds.push("c.source_kind = ?");
      params.push(filter.sourceKind);
    }
    if (filter.partyId !== undefined) {
      // party_addresses stores lowercased addresses; message headers keep
      // their original case, so compare case-insensitively
      conds.push(
        "(lower(m.from_address) IN (SELECT address FROM party_addresses WHERE party_id = ?)" +
          " OR EXISTS (SELECT 1 FROM message_recipients mr" +
          " JOIN party_addresses pa ON pa.address = lower(mr.address)" +
          " WHERE mr.message_id = m.message_id AND pa.party_id = ?))",
      );
      params.push(filter.partyId, filter.partyId);
    }
    if (filter.mime !== undefined) {
      conds.push(
        "EXISTS (SELECT 1 FROM blobs b WHERE b.hash = c.blob_hash AND b.mime LIKE ?)",
      );
      params.push(filter.mime + "%");
    }
  }
  return { sql: conds.length > 0 ? " AND " + conds.join(" AND ") : "", params };
}

export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** Each whitespace token quoted and OR-joined, so raw user text cannot break FTS5 syntax. */
function ftsMatchExpr(query: string): string | null {
  const toks = query.split(/\s+/).filter((t) => t.length > 0);
  if (toks.length === 0) return null;
  return toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

function bm25Candidates(dbh: DocketDb, match: string, filter: CompiledFilter): string[] {
  const sql =
    "SELECT c.chunk_id AS id FROM chunks_fts" +
    " JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id" +
    " LEFT JOIN messages m ON m.message_id = c.message_id" +
    " WHERE chunks_fts MATCH ?" +
    filter.sql +
    ` ORDER BY bm25(chunks_fts), c.chunk_id LIMIT ${CANDIDATE_LIMIT}`;
  const rows = dbh.db.prepare(sql).all(match, ...filter.params) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function toFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function vectorCandidates(
  dbh: DocketDb,
  model: string,
  queryVec: Float32Array,
  filter: CompiledFilter,
): string[] {
  if (dbh.hasVec) {
    const buf = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
    const sql =
      "SELECT e.chunk_id AS id FROM embeddings e" +
      " JOIN chunks c ON c.chunk_id = e.chunk_id" +
      " LEFT JOIN messages m ON m.message_id = c.message_id" +
      " WHERE e.model = ?" +
      filter.sql +
      ` ORDER BY vec_distance_cosine(e.vector, ?), e.chunk_id LIMIT ${CANDIDATE_LIMIT}`;
    const rows = dbh.db
      .prepare(sql)
      .all(model, ...filter.params, buf) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
  // scan fallback: fine at SME scale (spec 3.3)
  const sql =
    "SELECT e.chunk_id AS id, e.vector AS vector FROM embeddings e" +
    " JOIN chunks c ON c.chunk_id = e.chunk_id" +
    " LEFT JOIN messages m ON m.message_id = c.message_id" +
    " WHERE e.model = ?" +
    filter.sql;
  const rows = dbh.db
    .prepare(sql)
    .all(model, ...filter.params) as Array<{ id: string; vector: Buffer }>;
  return rows
    .map((r) => ({ id: r.id, sim: cosineSim(queryVec, toFloat32(r.vector)) }))
    .sort((a, b) => (b.sim !== a.sim ? b.sim - a.sim : a.id < b.id ? -1 : 1))
    .slice(0, CANDIDATE_LIMIT)
    .map((r) => r.id);
}

interface CandidateRow {
  chunk_id: string;
  text: string;
  context: string;
  message_id: string | null;
  thread_id: string | null;
  sent_at: string | null;
}

const FEATURE_NAMES = ["rrf", "overlap", "recency", "threadCoherence"] as const;

export async function hybridSearch(
  dbh: DocketDb,
  embedder: Embedder | undefined,
  q: { query: string; k?: number; filter?: SearchFilter },
): Promise<SearchHit[]> {
  const k = q.k ?? 10;
  const filter = compileFilter(q.filter);

  const lists: string[][] = [];
  const match = ftsMatchExpr(q.query);
  if (match !== null) lists.push(bm25Candidates(dbh, match, filter));
  if (embedder) {
    const [queryVec] = await embedder.embed([q.query]);
    if (queryVec && queryVec.some((x) => x !== 0)) {
      lists.push(vectorCandidates(dbh, embedder.model, queryVec, filter));
    }
  }

  // reciprocal rank fusion, ranks are 1-based
  const rrfScores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  const ids = [...rrfScores.keys()];
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(",");
  const rows = dbh.db
    .prepare(
      "SELECT c.chunk_id, c.text, c.context, c.message_id, m.thread_id, m.sent_at" +
        " FROM chunks c LEFT JOIN messages m ON m.message_id = c.message_id" +
        ` WHERE c.chunk_id IN (${placeholders})`,
    )
    .all(...ids) as CandidateRow[];

  const queryTokens = new Set(tokenize(q.query));
  const threadCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.thread_id !== null) {
      threadCounts.set(r.thread_id, (threadCounts.get(r.thread_id) ?? 0) + 1);
    }
  }
  // recency is anchored to the newest candidate, not the wall clock, so the
  // same query over the same data scores identically forever (invariant 7)
  let anchor = -Infinity;
  for (const r of rows) {
    if (r.sent_at !== null) {
      const t = Date.parse(r.sent_at);
      if (!Number.isNaN(t)) anchor = Math.max(anchor, t);
    }
  }

  const scored = rows.map((r) => {
    const docTokens = new Set(tokenize(r.context + " " + r.text));
    let hitCount = 0;
    for (const t of queryTokens) if (docTokens.has(t)) hitCount++;
    const overlap = queryTokens.size > 0 ? hitCount / queryTokens.size : 0;

    let recency = 0;
    if (r.sent_at !== null && anchor !== -Infinity) {
      const t = Date.parse(r.sent_at);
      if (!Number.isNaN(t)) {
        const days = Math.max(0, (anchor - t) / MS_PER_DAY);
        recency = 1 / (1 + days);
      }
    }

    const threadCoherence =
      r.thread_id !== null
        ? ((threadCounts.get(r.thread_id) ?? 1) - 1) / rows.length
        : 0;

    const features: Record<string, number> = {
      rrf: rrfScores.get(r.chunk_id) ?? 0,
      overlap,
      recency,
      threadCoherence,
    };
    return { row: r, features, score: 0 };
  });

  // equal-weight rerank over min-max normalized features
  for (const name of FEATURE_NAMES) {
    let min = Infinity;
    let max = -Infinity;
    for (const s of scored) {
      const v = s.features[name] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min;
    for (const s of scored) {
      const v = s.features[name] ?? 0;
      const norm = range > 0 ? (v - min) / range : 0;
      s.features[name] = norm;
      s.score += norm / FEATURE_NAMES.length;
    }
  }

  scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.row.chunk_id < b.row.chunk_id ? -1 : 1,
  );

  return scored.slice(0, k).map((s) => ({
    chunkId: s.row.chunk_id,
    score: s.score,
    text: s.row.text,
    context: s.row.context,
    messageId: s.row.message_id ?? undefined,
    threadId: s.row.thread_id ?? undefined,
    sentAt: s.row.sent_at ?? undefined,
    features: s.features,
  }));
}
