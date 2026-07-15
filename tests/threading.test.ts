import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DocketDb } from "../src/db.js";
import { SqliteIngestor } from "../src/ingest/ingest.js";
import { rethreadIncremental, threadIdForRoot } from "../src/ingest/jwz.js";
import type { BlobMeta, EvidenceStore } from "../src/types.js";

const FIXTURES = fileURLToPath(
  new URL("./fixtures/corpus-small/messages", import.meta.url),
);

/**
 * 12 fixture messages spanning three multi-message References threads
 * (ground_truth THR-0007, THR-0009 and THR-0010).
 */
const CORPUS_FILES = [
  "MSG-000007.eml",
  "MSG-000008.eml",
  "MSG-000009.eml",
  "MSG-000019.eml",
  "MSG-000053.eml",
  "MSG-000011.eml",
  "MSG-000021.eml",
  "MSG-000047.eml",
  "MSG-000012.eml",
  "MSG-000013.eml",
  "MSG-000018.eml",
  "MSG-000054.eml",
];

/** Minimal in-memory evidence store: only inserts the blobs rows the
 * messages/attachments foreign keys require. */
class MemStore implements EvidenceStore {
  private readonly blobs = new Map<string, Uint8Array>();

  constructor(private readonly dk: DocketDb) {}

  putBlob(bytes: Uint8Array, meta: BlobMeta): string {
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (!this.blobs.has(hash)) {
      this.blobs.set(hash, bytes);
      this.dk.db
        .prepare("INSERT OR IGNORE INTO blobs (hash, size, mime, created_at) VALUES (?, ?, ?, ?)")
        .run(hash, bytes.byteLength, meta.mime, "1970-01-01T00:00:00.000Z");
    }
    return hash;
  }

  getBlob(hash: string): Uint8Array | null {
    return this.blobs.get(hash) ?? null;
  }

  hasBlob(hash: string): boolean {
    return this.blobs.has(hash);
  }

  tombstone(): void {
    throw new Error("not supported by the mem store");
  }
}

interface Env {
  dk: DocketDb;
  ingestor: SqliteIngestor;
  dir: string;
}

const envs: Env[] = [];

function setup(): Env {
  const dir = mkdtempSync(join(tmpdir(), "docket-threading-"));
  const dk = openDb(dir);
  const ingestor = new SqliteIngestor(dk, new MemStore(dk));
  const env = { dk, ingestor, dir };
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

function makeEml(headers: Record<string, string>, body: string): Uint8Array {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return new TextEncoder().encode(`${head}\r\n\r\n${body}`);
}

interface Snapshot {
  messages: Array<[string, string | null]>;
  threads: Array<Record<string, unknown>>;
}

function snapshot(env: Env): Snapshot {
  const messages = (
    env.dk.db
      .prepare("SELECT message_id, thread_id FROM messages ORDER BY message_id")
      .all() as Array<{ message_id: string; thread_id: string | null }>
  ).map((r): [string, string | null] => [r.message_id, r.thread_id]);
  const threads = env.dk.db
    .prepare("SELECT thread_id, subject, first_at, last_at FROM threads ORDER BY thread_id")
    .all() as Array<Record<string, unknown>>;
  return { messages, threads };
}

/** Deterministic PRNG (mulberry32) so shuffles never depend on wall clock. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  const rand = prng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function threadOf(env: Env, id: string): string | null {
  const row = env.dk.db
    .prepare("SELECT thread_id FROM messages WHERE message_id = ?")
    .get(id) as { thread_id: string | null } | undefined;
  return row?.thread_id ?? null;
}

function threadCount(env: Env): number {
  return (env.dk.db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n;
}

/** Oracle: fresh db, same messages in the given order, then a full
 * recompute; rethreadAll depends only on the row set, never on order. */
async function oracle(parts: Uint8Array[]): Promise<Env> {
  const env = setup();
  for (const p of parts) await env.ingestor.emlBytes(p);
  env.ingestor.rethreadAll();
  return env;
}

describe("incremental threading", () => {
  it("matches full recompute after every single ingest, for 6 shuffled orders", async () => {
    for (let seed = 1; seed <= 6; seed++) {
      const order = shuffle(CORPUS_FILES, seed);
      const incremental = setup();
      const full = setup();
      for (let i = 0; i < order.length; i++) {
        const bytes = fixture(order[i]!);
        const before = seed === 1 && i === order.length - 1 ? snapshot(incremental) : null;
        const res = await incremental.ingestor.emlBytes(bytes);
        await full.ingestor.emlBytes(bytes);
        full.ingestor.rethreadAll();
        expect(snapshot(incremental), `seed ${seed} prefix ${i + 1}`).toEqual(snapshot(full));

        if (before) {
          const after = snapshot(incremental);
          const prev = new Map(before.messages);
          const changed = after.messages.filter(
            ([id, tid]) => !prev.has(id) || prev.get(id) !== tid,
          ).length;
          const stats = rethreadIncremental(incremental.dk.db, res.messageId);
          console.log(
            `perf: final ingest of seed 1 rewrote ${changed} thread assignment(s); ` +
              `recompute cluster was ${stats.clusterSize} of ${after.messages.length} messages`,
          );
          expect(stats.clusterSize).toBeLessThan(after.messages.length);
        }
      }
    }
  });

  it("bridges two existing threads into one and drops the orphaned thread row", async () => {
    const mk = (id: string, subject: string, date: string, refs?: string): Uint8Array =>
      makeEml(
        {
          From: "Pat Doe <pat@x.example>",
          To: "Sam Roe <sam@x.example>",
          Subject: subject,
          Date: date,
          "Message-ID": `<${id}>`,
          ...(refs ? { References: refs } : {}),
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        `body of ${id}\n`,
      );
    const parts = [
      mk("br-a1@x.example", "Alpha plan", "Mon, 01 Jan 2024 09:00:00 +0000"),
      mk("br-a2@x.example", "Re: Alpha plan", "Mon, 01 Jan 2024 10:00:00 +0000", "<br-a1@x.example>"),
      mk("br-b1@x.example", "Beta plan", "Mon, 01 Jan 2024 11:00:00 +0000"),
      mk("br-b2@x.example", "Re: Beta plan", "Mon, 01 Jan 2024 12:00:00 +0000", "<br-b1@x.example>"),
    ];
    const env = setup();
    for (const p of parts) await env.ingestor.emlBytes(p);
    expect(threadCount(env)).toBe(2);
    expect(threadOf(env, "br-b1@x.example")).toBe(threadIdForRoot("br-b1@x.example"));

    const bridge = mk(
      "br-c1@x.example",
      "Re: Alpha plan",
      "Mon, 01 Jan 2024 13:00:00 +0000",
      "<br-a1@x.example> <br-b1@x.example>",
    );
    await env.ingestor.emlBytes(bridge);

    const want = threadIdForRoot("br-a1@x.example");
    for (const id of [
      "br-a1@x.example",
      "br-a2@x.example",
      "br-b1@x.example",
      "br-b2@x.example",
      "br-c1@x.example",
    ]) {
      expect(threadOf(env, id)).toBe(want);
    }
    expect(threadCount(env)).toBe(1);

    const check = await oracle([...parts, bridge]);
    expect(snapshot(env)).toEqual(snapshot(check));
  });

  it("re-roots a thread when a referenced parent arrives late", async () => {
    const child = (id: string, date: string): Uint8Array =>
      makeEml(
        {
          From: "Pat Doe <pat@x.example>",
          To: "Sam Roe <sam@x.example>",
          Subject: "Re: Specs",
          Date: date,
          "Message-ID": `<${id}>`,
          References: "<late-par@x.example>",
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        "reply body\n",
      );
    const parts = [
      child("late-c1@x.example", "Tue, 02 Jan 2024 09:00:00 +0000"),
      child("late-c2@x.example", "Tue, 02 Jan 2024 10:00:00 +0000"),
    ];
    const env = setup();
    for (const p of parts) await env.ingestor.emlBytes(p);

    const placeholderThread = threadIdForRoot("late-par@x.example");
    expect(threadOf(env, "late-c1@x.example")).toBe(placeholderThread);
    expect(threadOf(env, "late-c2@x.example")).toBe(placeholderThread);
    expect(threadCount(env)).toBe(1);

    // the late parent itself references a grandparent, so the root (and the
    // thread id) must change for every member of the thread
    const parent = makeEml(
      {
        From: "Sam Roe <sam@x.example>",
        To: "Pat Doe <pat@x.example>",
        Subject: "Specs",
        Date: "Tue, 02 Jan 2024 08:00:00 +0000",
        "Message-ID": "<late-par@x.example>",
        References: "<late-grand@x.example>",
        "Content-Type": 'text/plain; charset="utf-8"',
      },
      "parent body\n",
    );
    await env.ingestor.emlBytes(parent);

    const want = threadIdForRoot("late-grand@x.example");
    expect(want).not.toBe(placeholderThread);
    for (const id of ["late-par@x.example", "late-c1@x.example", "late-c2@x.example"]) {
      expect(threadOf(env, id)).toBe(want);
    }
    expect(threadCount(env)).toBe(1);
    const orphan = env.dk.db
      .prepare("SELECT 1 FROM threads WHERE thread_id = ?")
      .get(placeholderThread);
    expect(orphan).toBeUndefined();

    const check = await oracle([...parts, parent]);
    expect(snapshot(env)).toEqual(snapshot(check));
  });

  it("joins a linkless message to an existing thread by normalized subject", async () => {
    const parts = [
      makeEml(
        {
          From: "Pat Doe <pat@x.example>",
          To: "Sam Roe <sam@x.example>",
          Subject: "Invoice 77",
          Date: "Wed, 03 Jan 2024 09:00:00 +0000",
          "Message-ID": "<inv-1@x.example>",
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        "invoice attached\n",
      ),
      makeEml(
        {
          From: "Sam Roe <sam@x.example>",
          To: "Pat Doe <pat@x.example>",
          Subject: "Re: Invoice 77",
          Date: "Wed, 03 Jan 2024 10:00:00 +0000",
          "Message-ID": "<inv-2@x.example>",
          References: "<inv-1@x.example>",
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        "received\n",
      ),
    ];
    const env = setup();
    for (const p of parts) await env.ingestor.emlBytes(p);

    const loner = makeEml(
      {
        From: "Kim Lee <kim@x.example>",
        To: "Pat Doe <pat@x.example>",
        Subject: "RE: invoice 77",
        Date: "Wed, 03 Jan 2024 11:00:00 +0000",
        "Message-ID": "<inv-3@x.example>",
        "Content-Type": 'text/plain; charset="utf-8"',
      },
      "forwarding my copy without reply headers\n",
    );
    await env.ingestor.emlBytes(loner);

    const want = threadIdForRoot("inv-1@x.example");
    expect(threadOf(env, "inv-3@x.example")).toBe(want);
    expect(threadCount(env)).toBe(1);

    const check = await oracle([...parts, loner]);
    expect(snapshot(env)).toEqual(snapshot(check));
  });

  it("makes an earlier linkless message joinable by later subject matches", async () => {
    const first = makeEml(
      {
        From: "Pat Doe <pat@x.example>",
        To: "Sam Roe <sam@x.example>",
        Subject: "Quarterly sync",
        Date: "Thu, 04 Jan 2024 09:00:00 +0000",
        "Message-ID": "<qs-1@x.example>",
        "Content-Type": 'text/plain; charset="utf-8"',
      },
      "agenda below\n",
    );
    const second = makeEml(
      {
        From: "Sam Roe <sam@x.example>",
        To: "Pat Doe <pat@x.example>",
        Subject: "Re: Quarterly sync",
        Date: "Thu, 04 Jan 2024 10:00:00 +0000",
        "Message-ID": "<qs-2@x.example>",
        "Content-Type": 'text/plain; charset="utf-8"',
      },
      "works for me\n",
    );
    const env = setup();
    await env.ingestor.emlBytes(first);
    expect(threadOf(env, "qs-1@x.example")).toBe(threadIdForRoot("qs-1@x.example"));

    await env.ingestor.emlBytes(second);
    // two linkless singletons with the same normalized subject merge,
    // rooted at the earliest message
    const want = threadIdForRoot("qs-1@x.example");
    expect(threadOf(env, "qs-1@x.example")).toBe(want);
    expect(threadOf(env, "qs-2@x.example")).toBe(want);
    expect(threadCount(env)).toBe(1);

    const check = await oracle([first, second]);
    expect(snapshot(env)).toEqual(snapshot(check));
  });

  it("moves absorbed loners when a new anchor with a smaller root id appears", async () => {
    const parts = [
      makeEml(
        {
          From: "Pat Doe <pat@x.example>",
          To: "Sam Roe <sam@x.example>",
          Subject: "Budget",
          Date: "Fri, 05 Jan 2024 09:00:00 +0000",
          "Message-ID": "<m1@x.example>",
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        "budget draft\n",
      ),
      makeEml(
        {
          From: "Sam Roe <sam@x.example>",
          To: "Pat Doe <pat@x.example>",
          Subject: "Re: Budget",
          Date: "Fri, 05 Jan 2024 10:00:00 +0000",
          "Message-ID": "<m2@x.example>",
          References: "<m1@x.example>",
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        "looks fine\n",
      ),
      makeEml(
        {
          From: "Kim Lee <kim@x.example>",
          To: "Pat Doe <pat@x.example>",
          Subject: "Re: Budget",
          Date: "Fri, 05 Jan 2024 11:00:00 +0000",
          "Message-ID": "<zz-loner@x.example>",
          "Content-Type": 'text/plain; charset="utf-8"',
        },
        "adding a note without reply headers\n",
      ),
    ];
    const env = setup();
    for (const p of parts) await env.ingestor.emlBytes(p);
    expect(threadOf(env, "zz-loner@x.example")).toBe(threadIdForRoot("m1@x.example"));
    expect(threadCount(env)).toBe(1);

    // new anchor rooted at a placeholder id that sorts before m1@x.example:
    // the loner must rebind to it, exactly as a full recompute would decide
    const rival = makeEml(
      {
        From: "Ana Cruz <ana@x.example>",
        To: "Pat Doe <pat@x.example>",
        Subject: "Budget",
        Date: "Fri, 05 Jan 2024 12:00:00 +0000",
        "Message-ID": "<x1@x.example>",
        References: "<a0@x.example>",
        "Content-Type": 'text/plain; charset="utf-8"',
      },
      "resending from my archive\n",
    );
    await env.ingestor.emlBytes(rival);

    const rivalThread = threadIdForRoot("a0@x.example");
    expect(threadOf(env, "x1@x.example")).toBe(rivalThread);
    expect(threadOf(env, "zz-loner@x.example")).toBe(rivalThread);
    expect(threadOf(env, "m1@x.example")).toBe(threadIdForRoot("m1@x.example"));
    expect(threadOf(env, "m2@x.example")).toBe(threadIdForRoot("m1@x.example"));
    expect(threadCount(env)).toBe(2);

    const check = await oracle([...parts, rival]);
    expect(snapshot(env)).toEqual(snapshot(check));
  });
});
