import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DocketDb } from "../src/db.js";
import { HashEmbedder } from "../src/indexer/embedder.js";
import { SqliteIndexer } from "../src/indexer/indexer.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

interface MessageSeed {
  messageId: string;
  fromName?: string;
  fromAddress: string;
  to?: string[];
  subject?: string;
  sentAt?: string | null;
  threadId?: string | null;
  body: string;
  /** 'new' fragment spans into body; defaults to one fragment covering the whole body */
  fragments?: Array<[number, number]>;
}

function seedMessage(dk: DocketDb, s: MessageSeed): string {
  const blobHash = sha256("raw:" + s.messageId);
  dk.db
    .prepare(
      "INSERT OR IGNORE INTO blobs (hash, size, mime, created_at)" +
        " VALUES (?, ?, 'message/rfc822', '2026-01-01T00:00:00Z')",
    )
    .run(blobHash, s.body.length);
  dk.db
    .prepare(
      "INSERT INTO messages (message_id, blob_hash, thread_id, subject, from_name," +
        " from_address, sent_at, body_text) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      s.messageId,
      blobHash,
      s.threadId ?? null,
      s.subject ?? "",
      s.fromName ?? "",
      s.fromAddress,
      s.sentAt ?? null,
      s.body,
    );
  for (const addr of s.to ?? []) {
    dk.db
      .prepare(
        "INSERT INTO message_recipients (message_id, name, address, kind) VALUES (?, '', ?, 'to')",
      )
      .run(s.messageId, addr);
  }
  const frags = s.fragments ?? [[0, s.body.length]];
  frags.forEach(([start, end], i) => {
    dk.db
      .prepare(
        "INSERT INTO fragments (fragment_id, message_id, kind, span_start, span_end, text)" +
          " VALUES (?, ?, 'new', ?, ?, ?)",
      )
      .run(`frg_${blobHash}_${i}`, s.messageId, start, end, s.body.slice(start, end));
  });
  return blobHash;
}

function seedAttachment(
  dk: DocketDb,
  messageId: string,
  attIndex: number,
  filename: string,
  mime: string,
  content: string,
): string {
  const blobHash = sha256(content);
  const objDir = join(dk.objectsDir, blobHash.slice(0, 2));
  mkdirSync(objDir, { recursive: true });
  writeFileSync(join(objDir, blobHash.slice(2)), content, "utf-8");
  dk.db
    .prepare(
      "INSERT OR IGNORE INTO blobs (hash, size, mime, created_at)" +
        " VALUES (?, ?, ?, '2026-01-01T00:00:00Z')",
    )
    .run(blobHash, content.length, mime);
  dk.db
    .prepare(
      "INSERT INTO attachments (message_id, att_index, filename, mime, blob_hash)" +
        " VALUES (?,?,?,?,?)",
    )
    .run(messageId, attIndex, filename, mime, blobHash);
  return blobHash;
}

interface ChunkRow {
  chunk_id: string;
  chunk_index: number;
  span_start: number;
  span_end: number;
  text: string;
  context: string;
  source_kind: string;
}

function chunksFor(dk: DocketDb, blobHash: string): ChunkRow[] {
  return dk.db
    .prepare(
      "SELECT chunk_id, chunk_index, span_start, span_end, text, context, source_kind" +
        " FROM chunks WHERE blob_hash = ? ORDER BY chunk_index",
    )
    .all(blobHash) as ChunkRow[];
}

describe("SqliteIndexer", () => {
  let dir: string;
  let dk: DocketDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docket-indexer-"));
    dk = openDb(dir);
  });

  afterEach(() => {
    dk.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces deterministic chunk ids and spans across reindex runs", async () => {
    const long = "word ".repeat(700).trim(); // ~3500 chars, forces intra-paragraph splits
    const body = `First paragraph about the lease renewal.\n\nSecond paragraph with terms.\n\n${long}`;
    const blobHash = seedMessage(dk, {
      messageId: "m1@example.com",
      fromAddress: "alice@acme.test",
      subject: "Lease",
      sentAt: "2026-07-01T10:00:00Z",
      body,
    });
    const indexer = new SqliteIndexer(dk, { embedder: new HashEmbedder() });

    await indexer.indexMessage("m1@example.com");
    const first = chunksFor(dk, blobHash);
    expect(first.length).toBeGreaterThan(1);
    first.forEach((c, i) => {
      expect(c.chunk_id).toBe(`chk_${blobHash}_${i}`);
      expect(c.span_end - c.span_start).toBeLessThanOrEqual(1200);
    });

    await indexer.indexMessage("m1@example.com");
    const second = chunksFor(dk, blobHash);
    expect(second).toEqual(first);

    // no duplicate FTS or embedding rows after reindex
    const ftsCount = dk.db.prepare("SELECT count(*) AS n FROM chunks_fts").get() as { n: number };
    expect(ftsCount.n).toBe(first.length);
    const embCount = dk.db.prepare("SELECT count(*) AS n FROM embeddings").get() as { n: number };
    expect(embCount.n).toBe(first.length);
  });

  it("chunk spans slice back to body_text exactly, including offset fragments", async () => {
    const prefix = "quoted header noise\n\n";
    const fresh = "The delivery is confirmed for Thursday.\n\nInvoice will follow separately.";
    const body = prefix + fresh + "\n\n> old quoted reply";
    const blobHash = seedMessage(dk, {
      messageId: "m2@example.com",
      fromAddress: "bob@acme.test",
      body,
      fragments: [[prefix.length, prefix.length + fresh.length]],
    });
    const indexer = new SqliteIndexer(dk);
    await indexer.indexMessage("m2@example.com");

    const rows = chunksFor(dk, blobHash);
    expect(rows.length).toBeGreaterThan(0);
    for (const c of rows) {
      expect(c.text).toBe(body.slice(c.span_start, c.span_end));
      expect(c.text).not.toContain("quoted");
    }
  });

  it("finds a distinctive term via FTS and honors the fromAddress filter", async () => {
    seedMessage(dk, {
      messageId: "m3@example.com",
      fromName: "Alice",
      fromAddress: "alice@acme.test",
      to: ["bob@acme.test"],
      subject: "Chess night",
      sentAt: "2026-07-10T09:00:00Z",
      body: "We reached a zugzwang position in the endgame review.",
    });
    seedMessage(dk, {
      messageId: "m4@example.com",
      fromAddress: "bob@acme.test",
      subject: "Lunch",
      sentAt: "2026-07-11T09:00:00Z",
      body: "Lunch is at noon on Friday in the main hall.",
    });
    const indexer = new SqliteIndexer(dk);
    await indexer.indexMessage("m3@example.com");
    await indexer.indexMessage("m4@example.com");

    const hits = await indexer.hybridSearch({ query: "zugzwang" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.messageId).toBe("m3@example.com");
    expect(hits[0]?.text).toContain("zugzwang");
    expect(hits[0]?.context).toBe(
      "Email from Alice alice@acme.test to bob@acme.test on 2026-07-10T09:00:00Z, subject: Chess night.",
    );
    // context lives in its own column, never inside the source text
    expect(hits[0]?.text).not.toContain("Email from");

    const filtered = await indexer.hybridSearch({
      query: "zugzwang",
      filter: { fromAddress: "bob@acme.test" },
    });
    expect(filtered.length).toBe(0);
  });

  it("hybrid search with HashEmbedder merges FTS and vector candidate lists", async () => {
    seedMessage(dk, {
      messageId: "m5@example.com",
      fromAddress: "carol@acme.test",
      subject: "Billing",
      sentAt: "2026-07-05T09:00:00Z",
      threadId: "thr_billing",
      body: "The overdue invoice for the March shipment needs payment this week.",
    });
    seedMessage(dk, {
      messageId: "m6@example.com",
      fromAddress: "dave@acme.test",
      subject: "Picnic",
      sentAt: "2026-07-06T09:00:00Z",
      threadId: "thr_social",
      body: "Company picnic is on Saturday, bring sunscreen and games.",
    });
    const indexer = new SqliteIndexer(dk, { embedder: new HashEmbedder() });
    await indexer.indexMessage("m5@example.com");
    await indexer.indexMessage("m6@example.com");

    // shares tokens with m5 only; must surface via both BM25 and vector lists
    const hits = await indexer.hybridSearch({ query: "invoice payment overdue" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.messageId).toBe("m5@example.com");

    // RRF union: a query matching either doc returns both
    const union = await indexer.hybridSearch({ query: "invoice picnic" });
    const messageIds = union.map((h) => h.messageId);
    expect(messageIds).toContain("m5@example.com");
    expect(messageIds).toContain("m6@example.com");

    // the JS cosine scan fallback ranks the same as the sqlite-vec path
    const hadVec = dk.hasVec;
    dk.hasVec = false;
    const fallback = await indexer.hybridSearch({ query: "invoice payment overdue" });
    dk.hasVec = hadVec;
    expect(fallback[0]?.messageId).toBe("m5@example.com");
  });

  it("populates finite rerank features and respects k", async () => {
    for (let i = 0; i < 5; i++) {
      seedMessage(dk, {
        messageId: `bulk${i}@example.com`,
        fromAddress: "erin@acme.test",
        subject: `Update ${i}`,
        sentAt: `2026-07-0${i + 1}T09:00:00Z`,
        threadId: i < 3 ? "thr_updates" : null,
        body: `Status update number ${i}: the warehouse migration continues on schedule.`,
      });
    }
    const indexer = new SqliteIndexer(dk, { embedder: new HashEmbedder() });
    for (let i = 0; i < 5; i++) await indexer.indexMessage(`bulk${i}@example.com`);

    const hits = await indexer.hybridSearch({ query: "warehouse migration schedule", k: 3 });
    expect(hits.length).toBe(3);
    for (const h of hits) {
      for (const name of ["rrf", "overlap", "recency", "threadCoherence"]) {
        const v = h.features[name];
        expect(v).toBeTypeOf("number");
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(Number.isFinite(h.score)).toBe(true);
    }
  });

  it("indexes text attachments and skips non-text mime types", async () => {
    seedMessage(dk, {
      messageId: "m7@example.com",
      fromAddress: "frank@acme.test",
      subject: "Q2 numbers",
      sentAt: "2026-07-12T09:00:00Z",
      body: "See attached figures.",
    });
    const content = "Quarterly totals:\n\nalpha 100\nbravo 250\ncharlie 75\n";
    const textHash = seedAttachment(
      dk,
      "m7@example.com",
      0,
      "totals.txt",
      "text/plain",
      content,
    );
    const pdfHash = seedAttachment(
      dk,
      "m7@example.com",
      1,
      "report.pdf",
      "application/pdf",
      "%PDF-1.4 binary-ish payload",
    );

    const indexer = new SqliteIndexer(dk);
    await indexer.indexAttachment("m7@example.com", 0);
    await indexer.indexAttachment("m7@example.com", 1);

    // attachment chunk ids are scoped per owning message: shared blobs must
    // not clobber each other's attribution
    const msgHash12 = createHash("sha256")
      .update("m7@example.com")
      .digest("hex")
      .slice(0, 12);
    const textChunks = chunksFor(dk, textHash);
    expect(textChunks.length).toBeGreaterThan(0);
    expect(textChunks[0]?.chunk_id).toBe(`chk_${textHash}_m${msgHash12}_0`);
    expect(textChunks[0]?.source_kind).toBe("attachment");
    for (const c of textChunks) {
      expect(c.text).toBe(content.slice(c.span_start, c.span_end));
    }
    expect(textChunks[0]?.context).toBe(
      "Attachment totals.txt of email from frank@acme.test on 2026-07-12T09:00:00Z, subject: Q2 numbers.",
    );

    expect(chunksFor(dk, pdfHash).length).toBe(0);

    const hits = await indexer.hybridSearch({
      query: "bravo",
      filter: { sourceKind: "attachment" },
    });
    expect(hits.length).toBe(1);
    expect(hits[0]?.chunkId).toBe(`chk_${textHash}_m${msgHash12}_0`);
  });

  it("filters by partyId through party_addresses on sender or recipients", async () => {
    dk.db
      .prepare("INSERT INTO parties (party_id, name, kind) VALUES ('pty_acme', 'Acme', 'company')")
      .run();
    dk.db
      .prepare(
        "INSERT INTO party_addresses (address, party_id, person) VALUES ('gina@acme.test', 'pty_acme', 'Gina')",
      )
      .run();
    seedMessage(dk, {
      messageId: "m8@example.com",
      fromAddress: "gina@acme.test",
      sentAt: "2026-07-13T09:00:00Z",
      body: "Renewal quote attached for the annual contract.",
    });
    seedMessage(dk, {
      messageId: "m9@example.com",
      fromAddress: "outsider@other.test",
      to: ["gina@acme.test"],
      sentAt: "2026-07-13T10:00:00Z",
      body: "Renewal reminder: your annual contract expires soon.",
    });
    seedMessage(dk, {
      messageId: "m10@example.com",
      fromAddress: "stranger@other.test",
      sentAt: "2026-07-13T11:00:00Z",
      body: "Renewal of the annual contract is unrelated to Acme.",
    });
    const indexer = new SqliteIndexer(dk);
    for (const id of ["m8@example.com", "m9@example.com", "m10@example.com"]) {
      await indexer.indexMessage(id);
    }

    const hits = await indexer.hybridSearch({
      query: "renewal annual contract",
      filter: { partyId: "pty_acme" },
    });
    const ids = hits.map((h) => h.messageId).sort();
    expect(ids).toEqual(["m8@example.com", "m9@example.com"]);
  });
});
