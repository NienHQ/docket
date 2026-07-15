/**
 * Regression pins for nine confirmed bugs found in adversarial review, plus a
 * determinism check. Each test names its scenario; assertions go through the
 * public Docket facade where possible, with raw SQLite reads on docket.db for
 * verification only.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";
import { HashEmbedder } from "../src/indexer/embedder.js";
import type { DocketOptions } from "../src/types.js";

const FIXTURES = fileURLToPath(
  new URL("./fixtures/corpus-small/messages", import.meta.url),
);

interface Env {
  dk: Docket;
  dir: string;
  /** second connection onto <dir>/docket.db, used for assertions only */
  db: Database;
}

const envs: Env[] = [];

async function open(options: DocketOptions = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "docket-regress-"));
  const dk = await Docket.open(dir, options);
  const db = new DatabaseCtor(join(dir, "docket.db"));
  const env = { dk, dir, db };
  envs.push(env);
  return env;
}

afterEach(() => {
  for (const env of envs.splice(0)) {
    env.db.close();
    env.dk.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

function makeEml(headers: Record<string, string>, body: string): Uint8Array {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return new TextEncoder().encode(`${head}\r\n\r\n${body}`);
}

function makeMultipartEml(opts: {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  attachment: { filename: string; text: string };
}): Uint8Array {
  const b = "docket-regress-boundary";
  const lines = [
    `Message-ID: <${opts.messageId}>`,
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${opts.date}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    opts.body,
    `--${b}`,
    `Content-Type: text/plain; charset="utf-8"; name="${opts.attachment.filename}"`,
    `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
    "",
    opts.attachment.text,
    `--${b}--`,
    "",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
}

interface ChunkRow {
  chunk_id: string;
  blob_hash: string;
  source_kind: string;
  message_id: string | null;
  span_start: number;
  span_end: number;
  text: string;
}

function chunkRows(db: Database): ChunkRow[] {
  return db
    .prepare(
      "SELECT chunk_id, blob_hash, source_kind, message_id, span_start, span_end, text" +
        " FROM chunks ORDER BY chunk_id",
    )
    .all() as ChunkRow[];
}

function count(db: Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

const PLAIN = 'text/plain; charset="utf-8"';

const TWO_PARAGRAPH_BODY = [
  "The revised lease terms arrive on Thursday and the deposit stays unchanged.",
  "",
  "Second paragraph carries the escrow release schedule for the quarter.",
  "",
  "-- ",
  "Rita Vale",
  "Ops Desk",
].join("\n");

describe("regressions", () => {
  // Scenario 1: reindex() must preserve message chunks. The bug wiped derived
  // tables (fragments included) and rebuilt chunks from an empty fragment set,
  // so reindex silently dropped every message chunk. Also pins the fragment
  // rebuild: identical chunk ids and spans require identical fragments.
  it("reindex() preserves message chunk ids and spans", async () => {
    const { dk, db } = await open();
    await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Rita Vale <rita@ops.example>",
          To: "Sam Ito <sam@ops.example>",
          Subject: "Lease terms",
          Date: "Mon, 05 Feb 2024 10:00:00 +0000",
          "Message-ID": "<regress-reindex-1@ops.example>",
          "Content-Type": PLAIN,
        },
        TWO_PARAGRAPH_BODY,
      ),
    );

    const before = chunkRows(db);
    expect(before.length).toBeGreaterThan(0);

    await dk.reindex();

    const after = chunkRows(db);
    expect(after).toEqual(before);
    expect(count(db, "SELECT COUNT(*) AS n FROM fragments")).toBeGreaterThan(0);
  });

  // Scenario 2: reindex() with an embedder configured. The bug inserted
  // embeddings rows before their chunks rows existed (or against stale chunk
  // ids), which threw SQLITE_CONSTRAINT_FOREIGNKEY during the rebuild.
  it("reindex() with an embedder rebuilds identical chunks and embeddings", async () => {
    const { dk, db } = await open({ embedder: new HashEmbedder() });
    await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Rita Vale <rita@ops.example>",
          To: "Sam Ito <sam@ops.example>",
          Subject: "Escrow schedule",
          Date: "Mon, 05 Feb 2024 11:00:00 +0000",
          "Message-ID": "<regress-reindex-2@ops.example>",
          "Content-Type": PLAIN,
        },
        TWO_PARAGRAPH_BODY,
      ),
    );

    const chunksBefore = chunkRows(db);
    const embBefore = count(db, "SELECT COUNT(*) AS n FROM embeddings");
    expect(chunksBefore.length).toBeGreaterThan(0);
    expect(embBefore).toBeGreaterThan(0);

    await expect(dk.reindex()).resolves.toBeUndefined();

    expect(chunkRows(db).map((c) => c.chunk_id)).toEqual(
      chunksBefore.map((c) => c.chunk_id),
    );
    expect(count(db, "SELECT COUNT(*) AS n FROM embeddings")).toBe(embBefore);
  });

  // Scenario 3: tombstoning a message blob must erase decoded content
  // everywhere, not only the CAS object. The bug left body_text, fragments
  // and getThread output readable after erasure.
  it("tombstoning a message blob erases content everywhere and is audited", async () => {
    const { dk, db } = await open();
    const r = await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Nora Hale <nora@corp.example>",
          To: "Omar Diaz <omar@corp.example>",
          Subject: "Severance details",
          Date: "Tue, 06 Feb 2024 09:00:00 +0000",
          "Message-ID": "<regress-tombstone-1@corp.example>",
          "Content-Type": PLAIN,
        },
        "Confidential severance figure is 84200 and must not persist.\n",
      ),
    );

    dk.store.tombstone(r.blobHash, "erasure");

    const thread = dk.tools.getThread(r.threadId);
    expect(thread).not.toBeNull();
    const msg = thread!.messages.find((m) => m.messageId === r.messageId);
    expect(msg).toBeDefined();
    expect(msg!.newText).toBe("");

    const row = db
      .prepare("SELECT body_text FROM messages WHERE message_id = ?")
      .get(r.messageId) as { body_text: string };
    expect(row.body_text).toBe("");
    expect(
      count(db, "SELECT COUNT(*) AS n FROM fragments WHERE message_id = ?", r.messageId),
    ).toBe(0);

    const audits = db
      .prepare("SELECT detail FROM audit_log WHERE action = 'tombstone' AND subject = ?")
      .all(r.blobHash) as Array<{ detail: string }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toBe("erasure");
  });

  // Scenario 4: an mbox body line starting with 'From ' is not a postmark and
  // must not split the message. The bug split on every 'From ' line, which
  // truncated stored evidence bytes; '>From ' escapes also stayed escaped.
  it("mbox split ignores 'From ' body lines and unescapes '>From '", async () => {
    const { dk, db, dir } = await open();
    const eml1 = [
      "Message-ID: <regress-mbox-1@example.com>",
      "From: Alice Adams <alice@example.com>",
      "To: Bob Barker <bob@example.com>",
      "Subject: mbox postmark handling",
      "Date: Mon, 22 Jan 2024 09:42:00 +0000",
      `Content-Type: ${PLAIN}`,
      "",
      "From my point of view, this holds.",
      ">From the vault we pulled the ledger.",
      "That is all.",
    ].join("\n");
    const eml2 = [
      "Message-ID: <regress-mbox-2@example.com>",
      "From: Bob Barker <bob@example.com>",
      "To: Alice Adams <alice@example.com>",
      "Subject: Re: mbox postmark handling",
      "Date: Mon, 22 Jan 2024 10:05:00 +0000",
      `Content-Type: ${PLAIN}`,
      "",
      "Received and agreed.",
    ].join("\n");
    const mbox =
      `From alice@example.com Mon Jan 22 09:42:00 2024\n${eml1}\n\n` +
      `From bob@example.com Mon Jan 22 10:05:00 2024\n${eml2}\n`;
    const path = join(dir, "regress.mbox");
    writeFileSync(path, mbox, "latin1");

    const results = await dk.ingest.mboxFile(path);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.messageId)).toEqual([
      "regress-mbox-1@example.com",
      "regress-mbox-2@example.com",
    ]);
    expect(count(db, "SELECT COUNT(*) AS n FROM messages")).toBe(2);

    const body = (
      db
        .prepare("SELECT body_text FROM messages WHERE message_id = ?")
        .get("regress-mbox-1@example.com") as { body_text: string }
    ).body_text;
    expect(body).toContain("From my point of view, this holds.");
    expect(body).toContain("That is all.");

    // stored evidence bytes carry the unescaped 'From ' line
    const blob = dk.store.getBlob(results[0]!.blobHash);
    expect(blob).not.toBeNull();
    const raw = new TextDecoder("utf-8").decode(blob!);
    expect(raw).toContain("\nFrom the vault we pulled the ledger.");
    expect(raw).not.toContain(">From the vault");
  });

  // Scenario 5: re-ingesting the same Message-ID with different bytes must
  // purge the old blob's index rows. The bug left the superseded chunks in
  // FTS, so retired content kept surfacing as live evidence.
  it("re-ingesting a Message-ID with new bytes purges stale chunks", async () => {
    const { dk } = await open();
    const headers = {
      From: "Pat Quinn <pat@vendor.example>",
      To: "Ravi Sood <ravi@buyer.example>",
      Subject: "Fitting quote",
      Date: "Wed, 07 Feb 2024 09:00:00 +0000",
      "Message-ID": "<regress-reingest-1@vendor.example>",
      "Content-Type": PLAIN,
    };
    await dk.ingest.emlBytes(
      makeEml(headers, "Quote for the fittings: oldprice100 per unit.\n"),
    );
    await dk.ingest.emlBytes(
      makeEml(headers, "Correction, the fittings are newprice200 per unit.\n"),
    );

    const stale = await dk.tools.hybridSearch({ query: "oldprice100" });
    expect(stale).toHaveLength(0);

    const fresh = await dk.tools.hybridSearch({ query: "newprice200" });
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0]!.messageId).toBe("regress-reingest-1@vendor.example");
  });

  // Scenario 6: a tombstoned text attachment must not break reindex(). The
  // bug had indexAttachment read the erased object file (or reinsert erased
  // content), so a routine rebuild threw after any compliance erasure.
  it("reindex() survives a tombstoned text attachment", async () => {
    const { dk, db } = await open();
    const r = await dk.ingest.emlBytes(
      makeMultipartEml({
        messageId: "regress-att-tomb@corp.example",
        from: "Tess Ung <tess@corp.example>",
        to: "Uma Voss <uma@corp.example>",
        subject: "Gate roster",
        date: "Thu, 08 Feb 2024 09:00:00 +0000",
        body: "Roster attached, the warehouse keys rotate on Friday.",
        attachment: {
          filename: "roster.txt",
          text: "erasable roster contents with badge numbers",
        },
      }),
    );
    expect(r.attachments).toBe(1);

    const attHash = (
      db
        .prepare("SELECT blob_hash FROM attachments WHERE message_id = ? AND att_index = 0")
        .get(r.messageId) as { blob_hash: string }
    ).blob_hash;
    expect(
      count(db, "SELECT COUNT(*) AS n FROM chunks WHERE blob_hash = ?", attHash),
    ).toBeGreaterThan(0);

    dk.store.tombstone(attHash, "erasure");

    await expect(dk.reindex()).resolves.toBeUndefined();

    expect(count(db, "SELECT COUNT(*) AS n FROM chunks WHERE blob_hash = ?", attHash)).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM chunks WHERE message_id = ? AND source_kind = 'message'",
        r.messageId,
      ),
    ).toBeGreaterThan(0);
  });

  // Scenario 7: attachment blobs are deduplicated across messages, so chunk
  // rows must be scoped per (blob, message). The bug keyed them by blob only,
  // and the last indexed message clobbered the other's attribution, breaking
  // sender filters.
  it("a shared attachment blob keeps per-message attributions", async () => {
    const { dk } = await open();
    const attachment = {
      filename: "manifest.txt",
      text: "zanzibar clearance manifest sharedtoken777 for the harbor run",
    };
    await dk.ingest.emlBytes(
      makeMultipartEml({
        messageId: "regress-shared-a@alpha.example",
        from: "Alice Alpha <alice@alpha.example>",
        to: "Cleo Marsh <cleo@port.example>",
        subject: "Manifest copy",
        date: "Fri, 09 Feb 2024 09:00:00 +0000",
        body: "Manifest attached from the alpha side.",
        attachment,
      }),
    );
    await dk.ingest.emlBytes(
      makeMultipartEml({
        messageId: "regress-shared-b@beta.example",
        from: "Bob Beta <bob@beta.example>",
        to: "Cleo Marsh <cleo@port.example>",
        subject: "Manifest copy again",
        date: "Fri, 09 Feb 2024 10:00:00 +0000",
        body: "Same manifest attached from the beta side.",
        attachment,
      }),
    );

    const hitsA = await dk.tools.hybridSearch({
      query: "sharedtoken777",
      filter: { fromAddress: "alice@alpha.example" },
    });
    const hitsB = await dk.tools.hybridSearch({
      query: "sharedtoken777",
      filter: { fromAddress: "bob@beta.example" },
    });
    expect(hitsA.length).toBeGreaterThan(0);
    expect(hitsB.length).toBeGreaterThan(0);
    expect(hitsA[0]!.messageId).toBe("regress-shared-a@alpha.example");
    expect(hitsB[0]!.messageId).toBe("regress-shared-b@beta.example");
    expect(hitsA[0]!.chunkId).not.toBe(hitsB[0]!.chunkId);
  });

  // Scenario 8: the partyId filter must match addresses case-insensitively.
  // party_addresses stores lowercased addresses while message headers keep
  // their original case; the bug compared them verbatim, so mixed-case
  // senders vanished from party-filtered search.
  it("partyId filter matches mixed-case sender addresses", async () => {
    const { dk } = await open();
    const r = await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Alice Case <Alice@Example.COM>",
          To: "Dana Frost <dana@other.example>",
          Subject: "Settlement figure",
          Date: "Sat, 10 Feb 2024 09:00:00 +0000",
          "Message-ID": "<regress-party-case@example.com>",
          "Content-Type": PLAIN,
        },
        "The casematch settlement figure is agreed at 12000.\n",
      ),
    );

    dk.entities.addParty({ partyId: "pty_acme", name: "Acme", kind: "company" });
    dk.entities.mapAddress({ address: "alice@example.com", partyId: "pty_acme" });

    const hits = await dk.tools.hybridSearch({
      query: "casematch",
      filter: { partyId: "pty_acme" },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.messageId).toBe(r.messageId);
  });

  // Scenario 9: an HTML-only email must still yield body text and be
  // retrievable. The bug stored an empty body when no text/plain part
  // existed, so HTML-only mail was invisible to search.
  it("HTML-only email gets body text and is searchable", async () => {
    const { dk, db } = await open();
    const r = await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Gil Horne <gil@sales.example>",
          To: "Hana Ives <hana@buyer.example>",
          Subject: "Rebate confirmation",
          Date: "Sun, 11 Feb 2024 09:00:00 +0000",
          "Message-ID": "<regress-html-only@sales.example>",
          "Content-Type": 'text/html; charset="utf-8"',
        },
        "<p>quarterly <b>rebate</b> agreed</p>",
      ),
    );

    const body = (
      db
        .prepare("SELECT body_text FROM messages WHERE message_id = ?")
        .get(r.messageId) as { body_text: string }
    ).body_text;
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("quarterly rebate agreed");

    const hits = await dk.tools.hybridSearch({ query: "rebate" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.messageId).toBe(r.messageId);
  });

  // Scenario 10: hybridSearch must score identically on repeated calls over
  // the same data (spec invariant 7). Recency is anchored to the newest
  // candidate instead of the wall clock, so full results including scores
  // and features are byte-stable.
  it("hybridSearch is deterministic across calls, scores included", async () => {
    const { dk } = await open();
    for (const f of ["MSG-000007.eml", "MSG-000008.eml", "MSG-000009.eml"]) {
      await dk.ingest.emlFile(join(FIXTURES, f));
    }

    const q = { query: "purchase order aluminum sheet", k: 10 };
    const first = await dk.tools.hybridSearch(q);
    expect(first.length).toBeGreaterThan(0);
    const second = await dk.tools.hybridSearch(q);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
