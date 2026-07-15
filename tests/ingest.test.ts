import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DocketDb } from "../src/db.js";
import { SqliteIngestor } from "../src/ingest/ingest.js";
import type { BlobMeta, EvidenceStore } from "../src/types.js";

const FIXTURES = fileURLToPath(
  new URL("./fixtures/corpus-small/messages", import.meta.url),
);

/**
 * In-memory stand-in for the evidence store module. Inserts minimal blobs
 * rows so the messages/attachments foreign keys hold.
 */
class FakeStore implements EvidenceStore {
  readonly blobs = new Map<string, Uint8Array>();
  readonly sources = new Map<string, BlobMeta>();

  constructor(private readonly dk: DocketDb) {}

  putBlob(bytes: Uint8Array, meta: BlobMeta): string {
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (!this.blobs.has(hash)) {
      this.blobs.set(hash, bytes);
      this.dk.db
        .prepare("INSERT OR IGNORE INTO blobs (hash, size, mime, created_at) VALUES (?, ?, ?, ?)")
        .run(hash, bytes.byteLength, meta.mime, new Date().toISOString());
    }
    const attIndex = meta.source.kind === "attachment" ? meta.source.attIndex : -1;
    this.sources.set(`${hash}|${meta.source.messageId}|${attIndex}`, meta);
    return hash;
  }

  getBlob(hash: string): Uint8Array | null {
    return this.blobs.get(hash) ?? null;
  }

  hasBlob(hash: string): boolean {
    return this.blobs.has(hash);
  }

  tombstone(): void {
    throw new Error("not supported by the fake store");
  }
}

interface Env {
  dk: DocketDb;
  store: FakeStore;
  ingestor: SqliteIngestor;
  dir: string;
}

const envs: Env[] = [];

function setup(): Env {
  const dir = mkdtempSync(join(tmpdir(), "docket-ingest-"));
  const dk = openDb(dir);
  const store = new FakeStore(dk);
  const ingestor = new SqliteIngestor(dk, store);
  const env = { dk, store, ingestor, dir };
  envs.push(env);
  return env;
}

afterEach(() => {
  for (const env of envs.splice(0)) {
    env.dk.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

function count(dk: DocketDb, table: string): number {
  const row = dk.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function makeEml(headers: Record<string, string>, body: string): Uint8Array {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return new TextEncoder().encode(`${head}\r\n\r\n${body}`);
}

describe("SqliteIngestor", () => {
  it("ingests a single eml with attachment", async () => {
    const { dk, store, ingestor } = setup();
    const result = await ingestor.emlBytes(fixture("MSG-000002.eml"));

    expect(result.fresh).toBe(true);
    expect(result.messageId).toBe("MSG-000002@bluepineproperties.example");
    expect(result.attachments).toBe(1);
    expect(result.threadId).toMatch(/^thr_[0-9a-f]{16}$/);

    const msg = dk.db
      .prepare("SELECT * FROM messages WHERE message_id = ?")
      .get(result.messageId) as Record<string, unknown>;
    expect(msg["subject"]).toBe("Lease agreement LEASE-2024-001");
    expect(msg["from_name"]).toBe("Hugo Yates");
    expect(msg["from_address"]).toBe("hugo.yates@bluepineproperties.example");
    expect(msg["sent_at"]).toBe("2024-01-02T09:07:00.000Z");
    expect(msg["blob_hash"]).toBe(result.blobHash);
    expect(msg["thread_id"]).toBe(result.threadId);
    const body = msg["body_text"] as string;
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("LEASE-2024-001");

    const recipients = dk.db
      .prepare("SELECT * FROM message_recipients WHERE message_id = ?")
      .all(result.messageId) as Array<Record<string, unknown>>;
    expect(recipients).toHaveLength(1);
    expect(recipients[0]!["address"]).toBe("iris.ellis@kestrelfabrication.example");
    expect(recipients[0]!["kind"]).toBe("to");

    const atts = dk.db
      .prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY att_index")
      .all(result.messageId) as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(1);
    expect(atts[0]!["filename"]).toBe("LEASE-2024-001.txt");
    expect(atts[0]!["mime"]).toBe("text/plain");

    // blob sources recorded through the store interface
    const msgSource = store.sources.get(`${result.blobHash}|${result.messageId}|-1`);
    expect(msgSource?.source.kind).toBe("message");
    const attHash = atts[0]!["blob_hash"] as string;
    const attSource = store.sources.get(`${attHash}|${result.messageId}|0`);
    expect(attSource?.source.kind).toBe("attachment");
    expect(attSource?.source.kind === "attachment" && attSource.source.filename).toBe(
      "LEASE-2024-001.txt",
    );
    expect(store.hasBlob(result.blobHash)).toBe(true);
    expect(store.hasBlob(attHash)).toBe(true);
  });

  it("is idempotent: re-ingesting identical bytes changes nothing", async () => {
    const { dk, store, ingestor } = setup();
    const bytes = fixture("MSG-000002.eml");

    const first = await ingestor.emlBytes(bytes);
    expect(first.fresh).toBe(true);
    const counts = {
      messages: count(dk, "messages"),
      recipients: count(dk, "message_recipients"),
      attachments: count(dk, "attachments"),
      fragments: count(dk, "fragments"),
      threads: count(dk, "threads"),
      blobs: count(dk, "blobs"),
      sources: store.sources.size,
    };

    const second = await ingestor.emlBytes(bytes);
    expect(second.fresh).toBe(false);
    expect(second.messageId).toBe(first.messageId);
    expect(second.blobHash).toBe(first.blobHash);
    expect(second.threadId).toBe(first.threadId);
    expect(second.attachments).toBe(first.attachments);

    expect(count(dk, "messages")).toBe(counts.messages);
    expect(count(dk, "message_recipients")).toBe(counts.recipients);
    expect(count(dk, "attachments")).toBe(counts.attachments);
    expect(count(dk, "fragments")).toBe(counts.fragments);
    expect(count(dk, "threads")).toBe(counts.threads);
    expect(count(dk, "blobs")).toBe(counts.blobs);
    expect(store.sources.size).toBe(counts.sources);
  });

  it("splits body into new/quote/signature fragments with exact spans", async () => {
    const { dk, ingestor } = setup();
    const body = [
      "Here is my reply with the numbers you asked for.",
      "",
      "On Mon, 1 Jan 2024 at 09:00, Bella Quinn wrote:",
      "> Could you send over the Q4 numbers?",
      "> Thanks in advance.",
      "",
      "-- ",
      "Alice Example",
      "Finance Team",
    ].join("\n");
    const result = await ingestor.emlBytes(
      makeEml(
        {
          From: "Alice Example <alice@x.example>",
          To: "Bella Quinn <bella@y.example>",
          Subject: "Q4 numbers",
          Date: "Mon, 01 Jan 2024 10:00:00 +0000",
          "Message-ID": "<frag-test-1@x.example>",
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        body,
      ),
    );

    const stored = dk.db
      .prepare("SELECT body_text FROM messages WHERE message_id = ?")
      .get(result.messageId) as { body_text: string };
    const fragments = dk.db
      .prepare("SELECT * FROM fragments WHERE message_id = ? ORDER BY span_start")
      .all(result.messageId) as Array<{
      fragment_id: string;
      kind: string;
      span_start: number;
      span_end: number;
      text: string;
    }>;

    expect(fragments.map((f) => f.kind)).toEqual(["new", "quote", "signature"]);
    const hash8 = createHash("sha256").update(result.messageId).digest("hex").slice(0, 16);
    fragments.forEach((f, i) => {
      expect(f.fragment_id).toBe(`frg_${hash8}_${i}`);
      expect(stored.body_text.slice(f.span_start, f.span_end)).toBe(f.text);
    });
    expect(fragments[0]!.text).toContain("Here is my reply");
    expect(fragments[1]!.text).toContain("wrote:");
    expect(fragments[1]!.text).toContain("> Could you send over");
    expect(fragments[2]!.text).toContain("Alice Example");
    expect(fragments[2]!.text.startsWith("-- ")).toBe(true);
  });

  it("marks a trailing sign-off block as signature", async () => {
    const { dk, ingestor } = setup();
    const body = [
      "The revised order quantities are attached below.",
      "",
      "Best regards,",
      "Carol Vance",
      "Acme Corp",
    ].join("\n");
    const result = await ingestor.emlBytes(
      makeEml(
        {
          From: "Carol Vance <carol@acme.example>",
          To: "Dan Ochoa <dan@z.example>",
          Subject: "Order quantities",
          Date: "Tue, 02 Jan 2024 10:00:00 +0000",
          "Message-ID": "<frag-test-2@acme.example>",
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        body,
      ),
    );

    const stored = dk.db
      .prepare("SELECT body_text FROM messages WHERE message_id = ?")
      .get(result.messageId) as { body_text: string };
    const fragments = dk.db
      .prepare("SELECT * FROM fragments WHERE message_id = ? ORDER BY span_start")
      .all(result.messageId) as Array<{
      kind: string;
      span_start: number;
      span_end: number;
      text: string;
    }>;

    expect(fragments.map((f) => f.kind)).toEqual(["new", "signature"]);
    for (const f of fragments) {
      expect(stored.body_text.slice(f.span_start, f.span_end)).toBe(f.text);
    }
    expect(fragments[1]!.text.startsWith("Best regards,")).toBe(true);
    expect(fragments[1]!.text).toContain("Acme Corp");
  });

  it("threads a References chain identically regardless of ingest order", async () => {
    const files = ["MSG-000007.eml", "MSG-000008.eml", "MSG-000009.eml"];
    const ids = [
      "MSG-000007@kestrelfabrication.example",
      "MSG-000008@meridianpackaging.example",
      "MSG-000009@kestrelfabrication.example",
    ];

    const a = setup();
    for (const f of files) await a.ingestor.emlBytes(fixture(f));

    const b = setup();
    for (const f of [...files].reverse()) await b.ingestor.emlBytes(fixture(f));

    const threadOf = (env: Env, id: string): string =>
      (env.dk.db.prepare("SELECT thread_id FROM messages WHERE message_id = ?").get(id) as {
        thread_id: string;
      }).thread_id;

    const threadsA = ids.map((id) => threadOf(a, id));
    const threadsB = ids.map((id) => threadOf(b, id));

    expect(new Set(threadsA).size).toBe(1);
    expect(new Set(threadsB).size).toBe(1);
    expect(threadsA).toEqual(threadsB);

    const threadRow = a.dk.db
      .prepare("SELECT * FROM threads WHERE thread_id = ?")
      .get(threadsA[0]) as Record<string, unknown>;
    expect(threadRow["subject"]).toBe("Purchase order PO-2024-0005 - aluminum sheet 2mm");
    expect(threadRow["first_at"]).toBe("2024-01-16T09:00:00.000Z");
  });

  it("joins messages without header links via normalized subject", async () => {
    const { dk, ingestor } = setup();
    const first = await ingestor.emlBytes(
      makeEml(
        {
          From: "Erin Wolfe <erin@p.example>",
          To: "Farid Khan <farid@q.example>",
          Subject: "Invoice 42",
          Date: "Wed, 03 Jan 2024 09:00:00 +0000",
          "Message-ID": "<subj-1@p.example>",
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        "Invoice 42 is attached.\n",
      ),
    );
    const second = await ingestor.emlBytes(
      makeEml(
        {
          From: "Farid Khan <farid@q.example>",
          To: "Erin Wolfe <erin@p.example>",
          Subject: "Re: Invoice 42",
          Date: "Wed, 03 Jan 2024 11:00:00 +0000",
          "Message-ID": "<subj-2@q.example>",
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        "Received, thanks.\n",
      ),
    );

    expect(first.threadId).not.toBe("");
    expect(second.threadId).toBe(first.threadId);
    expect(count(dk, "threads")).toBe(1);
    const thread = dk.db
      .prepare("SELECT * FROM threads WHERE thread_id = ?")
      .get(second.threadId) as Record<string, unknown>;
    expect(thread["subject"]).toBe("Invoice 42");
    expect(thread["first_at"]).toBe("2024-01-03T09:00:00.000Z");
    expect(thread["last_at"]).toBe("2024-01-03T11:00:00.000Z");
  });

  it("ingests an mbox file split on postmark lines", async () => {
    const { dk, ingestor, dir } = setup();
    const raw1 = readFileSync(join(FIXTURES, "MSG-000001.eml"), "latin1");
    const raw3 = readFileSync(join(FIXTURES, "MSG-000003.eml"), "latin1");
    const mbox =
      `From ben.whitfield@kestrelfabrication.example Tue Jan  2 09:00:00 2024\n${raw1}\n` +
      `From hugo.yates@bluepineproperties.example Tue Jan  2 09:14:00 2024\n${raw3}\n`;
    const path = join(dir, "test.mbox");
    writeFileSync(path, mbox, "latin1");

    const results = await ingestor.mboxFile(path);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.fresh)).toBe(true);
    expect(count(dk, "messages")).toBe(2);
    expect(results[0]!.messageId).toBe("MSG-000001@kestrelfabrication.example");
  });
});
