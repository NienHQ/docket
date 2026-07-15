import type { DocketDb } from "../db.js";
import type {
  DuplicateRef,
  Embedder,
  SearchFilter,
  SearchHit,
  ThreadContextEntry,
} from "../types.js";

const CANDIDATE_LIMIT = 50;
const RRF_K = 60;
const MS_PER_DAY = 86_400_000;
const SHINGLE_SIZE = 5;
const DUP_JACCARD = 0.9;
const EXPAND_NEIGHBORS = 2;
const EXPAND_TEXT_CAP = 1200;

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

interface ScoredCandidate {
  row: CandidateRow;
  features: Record<string, number>;
  score: number;
  duplicates?: DuplicateRef[];
}

/** lowercase, non-alphanumerics to single spaces, collapsed and trimmed */
function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Token shingles over the normalized text. Texts shorter than the shingle
 * size get one shingle of the whole normalized text, so tiny chunks only
 * cluster on exact normalized equality.
 */
function shingleSet(norm: string): Set<string> {
  const out = new Set<string>();
  if (norm.length === 0) return out;
  const toks = norm.split(" ");
  if (toks.length < SHINGLE_SIZE) {
    out.add(norm);
    return out;
  }
  for (let i = 0; i + SHINGLE_SIZE <= toks.length; i++) {
    out.add(toks.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

/** earliest sent_at first, nulls last, ties by chunk_id ascending */
function byEarliest(a: CandidateRow, b: CandidateRow): number {
  if (a.sent_at !== b.sent_at) {
    if (a.sent_at === null) return 1;
    if (b.sent_at === null) return -1;
    return a.sent_at < b.sent_at ? -1 : 1;
  }
  return a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0;
}

/**
 * Near-duplicate suppression (spec 3.3): quoted-reply copies and shared
 * attachments put near-identical text in many chunks. Candidates whose
 * normalized texts are exactly equal or whose shingle Jaccard is >= 0.9
 * cluster together; the primary is the EARLIEST message's chunk (provenance
 * points at the original assertion), it inherits the cluster's best score so
 * collapsing never demotes a result, and the folded copies are listed in
 * `duplicates` ordered by sent_at then chunk id. Runs on the full reranked
 * candidate list before the top-k cut, so folded copies free slots for
 * distinct results. Fully deterministic: pairwise union-find over the sorted
 * candidates, smaller root index wins.
 */
function collapseDuplicates(scored: ScoredCandidate[]): ScoredCandidate[] {
  const n = scored.length;
  const norms = scored.map((s) => normalizeForDedupe(s.row.text));
  const sets = norms.map(shingleSet);

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[i] !== r) {
      const next = parent[i]!;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (norms[i] === norms[j] || jaccard(sets[i]!, sets[j]!) >= DUP_JACCARD) {
        union(i, j);
      }
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const members = clusters.get(root);
    if (members) members.push(i);
    else clusters.set(root, [i]);
  }

  const out: ScoredCandidate[] = [];
  for (const members of clusters.values()) {
    if (members.length === 1) {
      out.push(scored[members[0]!]!);
      continue;
    }
    const ordered = [...members].sort((x, y) =>
      byEarliest(scored[x]!.row, scored[y]!.row),
    );
    const primary = scored[ordered[0]!]!;
    let best = primary.score;
    for (const m of members) if (scored[m]!.score > best) best = scored[m]!.score;
    const duplicates: DuplicateRef[] = ordered.slice(1).map((m) => {
      const r = scored[m]!.row;
      return {
        chunkId: r.chunk_id,
        ...(r.message_id !== null ? { messageId: r.message_id } : {}),
        ...(r.sent_at !== null ? { sentAt: r.sent_at } : {}),
      };
    });
    out.push({ ...primary, score: best, duplicates });
  }
  out.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.row.chunk_id < b.row.chunk_id ? -1 : 1,
  );
  return out;
}

interface ThreadMessageRow {
  message_id: string;
  sent_at: string | null;
  from_address: string;
}

/**
 * Thread-context expansion (spec 3.6): when expand: "thread" was requested,
 * each hit carries the surrounding new-fragment text of its thread, up to
 * EXPAND_NEIGHBORS messages each side of the hit's message ordered by
 * (sent_at, message_id) (the getThread ordering), the hit's own message
 * excluded, each entry's text capped at EXPAND_TEXT_CAP chars after joining
 * its 'new' fragments. Runs AFTER dedupe and the top-k cut: expansion is
 * display context and never affects ranking. One thread query per DISTINCT
 * thread among the hits; entries are cached per message so hits sharing a
 * thread never re-query.
 */
function expandThreadContext(dbh: DocketDb, hits: SearchHit[]): SearchHit[] {
  const threadIds = new Set<string>();
  for (const h of hits) if (h.threadId !== undefined) threadIds.add(h.threadId);
  if (threadIds.size === 0) return hits;

  const msgStmt = dbh.db.prepare(
    "SELECT message_id, sent_at, from_address FROM messages" +
      " WHERE thread_id = ? ORDER BY sent_at, message_id",
  );
  const fragStmt = dbh.db.prepare(
    "SELECT text FROM fragments WHERE message_id = ? AND kind = 'new'" +
      " ORDER BY span_start",
  );
  const threads = new Map<string, ThreadMessageRow[]>();
  for (const tid of threadIds) {
    threads.set(tid, msgStmt.all(tid) as ThreadMessageRow[]);
  }

  const entryCache = new Map<string, ThreadContextEntry>();
  const entryFor = (m: ThreadMessageRow): ThreadContextEntry => {
    const cached = entryCache.get(m.message_id);
    if (cached) return cached;
    const newText = (fragStmt.all(m.message_id) as Array<{ text: string }>)
      .map((f) => f.text)
      .join("\n")
      .slice(0, EXPAND_TEXT_CAP);
    const entry: ThreadContextEntry = {
      messageId: m.message_id,
      sentAt: m.sent_at,
      fromAddress: m.from_address,
      newText,
    };
    entryCache.set(m.message_id, entry);
    return entry;
  };

  return hits.map((h) => {
    if (h.threadId === undefined || h.messageId === undefined) return h;
    const msgs = threads.get(h.threadId) ?? [];
    const idx = msgs.findIndex((m) => m.message_id === h.messageId);
    if (idx < 0) return h;
    const neighbors = [
      ...msgs.slice(Math.max(0, idx - EXPAND_NEIGHBORS), idx),
      ...msgs.slice(idx + 1, idx + 1 + EXPAND_NEIGHBORS),
    ];
    if (neighbors.length === 0) return h;
    return { ...h, threadContext: neighbors.map(entryFor) };
  });
}

export async function hybridSearch(
  dbh: DocketDb,
  embedder: Embedder | undefined,
  q: {
    query: string;
    k?: number;
    filter?: SearchFilter;
    dedupe?: boolean;
    expand?: "thread" | "none";
  },
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

  const scored: ScoredCandidate[] = rows.map((r) => {
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

  // dedupe before the top-k cut so folded copies free slots (default on)
  const finalists = q.dedupe === false ? scored : collapseDuplicates(scored);

  const hits: SearchHit[] = finalists.slice(0, k).map((s) => ({
    chunkId: s.row.chunk_id,
    score: s.score,
    text: s.row.text,
    context: s.row.context,
    messageId: s.row.message_id ?? undefined,
    threadId: s.row.thread_id ?? undefined,
    sentAt: s.row.sent_at ?? undefined,
    features: s.features,
    ...(s.duplicates !== undefined ? { duplicates: s.duplicates } : {}),
  }));

  // after the top-k cut: expansion is display context, never a ranking input
  return q.expand === "thread" ? expandThreadContext(dbh, hits) : hits;
}
