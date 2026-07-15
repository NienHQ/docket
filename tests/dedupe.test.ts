/**
 * Near-duplicate suppression (plan 2.4, spec 3.3). All scenarios go through
 * the public Docket facade on temp dirs with synthetic emails: quoted-reply
 * copies and shared attachments collapse into one primary hit (earliest
 * message, best score) with the folded copies listed in `duplicates`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";

const envs: Array<{ dk: Docket; dir: string }> = [];

async function open(): Promise<Docket> {
  const dir = mkdtempSync(join(tmpdir(), "docket-dedupe-"));
  const dk = await Docket.open(dir);
  envs.push({ dk, dir });
  return dk;
}

afterEach(() => {
  for (const env of envs.splice(0)) {
    env.dk.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

const PLAIN = 'text/plain; charset="utf-8"';

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
  const b = "docket-dedupe-boundary";
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

/** four-message thread where everyone re-types the same paragraph as new text */
const PARAGRAPH =
  "The escrow release for the harbor lease hinges on the marine survey " +
  "clearing the pontoon inspection before the quarter closes.";

interface ThreadSeed {
  messageId: string;
  from: string;
  date: string;
}

const THREAD: ThreadSeed[] = [
  { messageId: "dup1@ops.example", from: "Rita Vale <rita@ops.example>", date: "Fri, 01 Mar 2024 09:00:00 +0000" },
  { messageId: "dup2@ops.example", from: "Sam Ito <sam@ops.example>", date: "Sat, 02 Mar 2024 09:00:00 +0000" },
  { messageId: "dup3@ops.example", from: "Ana Reyes <ana@ops.example>", date: "Sun, 03 Mar 2024 09:00:00 +0000" },
  { messageId: "dup4@ops.example", from: "Leo Marsh <leo@ops.example>", date: "Mon, 04 Mar 2024 09:00:00 +0000" },
];

async function ingestThread(dk: Docket, seeds: ThreadSeed[], body: string): Promise<void> {
  // ingest out of date order: primary selection must follow sent_at, not
  // ingest order
  const order = [2, 0, 3, 1].filter((i) => i < seeds.length);
  for (const i of order) {
    const s = seeds[i]!;
    const first = seeds[0]!;
    const headers: Record<string, string> = {
      From: s.from,
      To: "desk@ops.example",
      Subject: i === 0 ? "Harbor lease" : "Re: Harbor lease",
      Date: s.date,
      "Message-ID": `<${s.messageId}>`,
      "Content-Type": PLAIN,
    };
    if (i > 0) headers["In-Reply-To"] = `<${first.messageId}>`;
    await dk.ingest.emlBytes(makeEml(headers, body));
  }
}

describe("near-duplicate suppression", () => {
  it("collapses a paragraph re-typed across a 4-message thread into one primary hit", async () => {
    const dk = await open();
    await ingestThread(dk, THREAD, PARAGRAPH);

    const hits = await dk.tools.hybridSearch({
      query: "escrow harbor pontoon inspection",
    });

    expect(hits.length).toBe(1);
    const hit = hits[0]!;
    expect(hit.text).toContain("pontoon inspection");
    expect(hit.messageId).toBe("dup1@ops.example"); // earliest sent_at wins
    expect(hit.duplicates).toBeDefined();
    expect(hit.duplicates!.length).toBe(3);
    expect(hit.duplicates!.map((d) => d.messageId)).toEqual([
      "dup2@ops.example",
      "dup3@ops.example",
      "dup4@ops.example",
    ]);
    // duplicates are ordered by sentAt ascending
    const sentAts = hit.duplicates!.map((d) => d.sentAt ?? "");
    expect([...sentAts].sort()).toEqual(sentAts);
  });

  it("dedupe: false returns every copy as its own hit", async () => {
    const dk = await open();
    await ingestThread(dk, THREAD, PARAGRAPH);

    const hits = await dk.tools.hybridSearch({
      query: "escrow harbor pontoon inspection",
      dedupe: false,
    });

    expect(hits.length).toBe(4);
    expect(hits.map((h) => h.messageId).sort()).toEqual([
      "dup1@ops.example",
      "dup2@ops.example",
      "dup3@ops.example",
      "dup4@ops.example",
    ]);
    for (const h of hits) expect(h.duplicates).toBeUndefined();
  });

  it("does not collapse near-but-not-identical texts (Jaccard below 0.9)", async () => {
    const dk = await open();
    // shared sentence: 17 tokens = 13 shingles; the second message appends a
    // 15-token sentence, so Jaccard = 13 / 28, far below 0.9
    const shared =
      "The vendor confirmed the cobalt shipment leaves rotterdam on friday " +
      "morning with the customs manifest sealed.";
    const extra =
      " The insurance rider covers transit damage through antwerp and the " +
      "surcharge lands next month.";
    await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Rita Vale <rita@ops.example>",
          To: "desk@ops.example",
          Subject: "Cobalt shipment",
          Date: "Mon, 01 Apr 2024 09:00:00 +0000",
          "Message-ID": "<near1@ops.example>",
          "Content-Type": PLAIN,
        },
        shared,
      ),
    );
    await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Sam Ito <sam@ops.example>",
          To: "desk@ops.example",
          Subject: "Re: Cobalt shipment",
          Date: "Tue, 02 Apr 2024 09:00:00 +0000",
          "Message-ID": "<near2@ops.example>",
          "Content-Type": PLAIN,
        },
        shared + extra,
      ),
    );

    const hits = await dk.tools.hybridSearch({
      query: "cobalt shipment rotterdam customs manifest",
    });

    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.messageId).sort()).toEqual([
      "near1@ops.example",
      "near2@ops.example",
    ]);
    for (const h of hits) expect(h.duplicates).toBeUndefined();
  });

  it("the primary inherits the cluster's best score even when a later copy scores higher", async () => {
    const dk = await open();
    const body =
      "Quarterly audit of the vellum ledger requires the notary " +
      "countersignature before any disbursement clears the trust account.";
    // dates spread across months so recency separates the copies; the latest
    // copy is from Zephyr, and the query includes his name, so his copy also
    // wins the token-overlap and BM25 features: the top-scoring copy is NOT
    // the earliest
    const seeds: ThreadSeed[] = [
      { messageId: "sc1@ops.example", from: "Rita Vale <rita@ops.example>", date: "Mon, 01 Jan 2024 09:00:00 +0000" },
      { messageId: "sc2@ops.example", from: "Sam Ito <sam@ops.example>", date: "Thu, 01 Feb 2024 09:00:00 +0000" },
      { messageId: "sc3@ops.example", from: "Ana Reyes <ana@ops.example>", date: "Fri, 01 Mar 2024 09:00:00 +0000" },
      { messageId: "sc4@ops.example", from: "Zephyr Quill <zephyr@ops.example>", date: "Mon, 01 Jul 2024 09:00:00 +0000" },
    ];
    await ingestThread(dk, seeds, body);

    const query = "vellum ledger notary disbursement zephyr";
    const raw = await dk.tools.hybridSearch({ query, dedupe: false });
    expect(raw.length).toBe(4);
    const maxScore = Math.max(...raw.map((h) => h.score));
    // sanity: the best-scoring copy pre-collapse is the latest, not the earliest
    expect(raw[0]!.messageId).toBe("sc4@ops.example");
    expect(raw[0]!.score).toBe(maxScore);

    const collapsed = await dk.tools.hybridSearch({ query });
    expect(collapsed.length).toBe(1);
    expect(collapsed[0]!.messageId).toBe("sc1@ops.example"); // earliest is primary
    expect(collapsed[0]!.score).toBe(maxScore); // inherits the cluster maximum
  });

  it("collapsing frees top-k slots for distinct results", async () => {
    const dk = await open();
    const body =
      "The cobalt manifest for the harbor shipment lists twelve pallets of " +
      "ore cleared through customs on tuesday.";
    const seeds: ThreadSeed[] = [
      { messageId: "sl1@ops.example", from: "Rita Vale <rita@ops.example>", date: "Mon, 01 Apr 2024 09:00:00 +0000" },
      { messageId: "sl2@ops.example", from: "Sam Ito <sam@ops.example>", date: "Tue, 02 Apr 2024 09:00:00 +0000" },
      { messageId: "sl3@ops.example", from: "Ana Reyes <ana@ops.example>", date: "Wed, 03 Apr 2024 09:00:00 +0000" },
      { messageId: "sl4@ops.example", from: "Leo Marsh <leo@ops.example>", date: "Thu, 04 Apr 2024 09:00:00 +0000" },
    ];
    await ingestThread(dk, seeds, body);
    await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Vik Chandra <vik@ops.example>",
          To: "desk@ops.example",
          Subject: "Cobalt pricing",
          Date: "Fri, 05 Apr 2024 09:00:00 +0000",
          "Message-ID": "<weak1@ops.example>",
          "Content-Type": PLAIN,
        },
        "Cobalt pricing update for the quarter is attached to this note.",
      ),
    );
    await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Mia Torres <mia@ops.example>",
          To: "desk@ops.example",
          Subject: "Delay",
          Date: "Sat, 06 Apr 2024 09:00:00 +0000",
          "Message-ID": "<weak2@ops.example>",
          "Content-Type": PLAIN,
        },
        "The shipment window moved to thursday after the dock strike ended.",
      ),
    );

    const hits = await dk.tools.hybridSearch({
      query: "cobalt manifest harbor shipment pallets",
      k: 3,
    });

    expect(hits.length).toBe(3);
    expect(hits.map((h) => h.messageId).sort()).toEqual([
      "sl1@ops.example",
      "weak1@ops.example",
      "weak2@ops.example",
    ]);
    const primary = hits.find((h) => h.messageId === "sl1@ops.example")!;
    expect(primary.duplicates!.map((d) => d.messageId)).toEqual([
      "sl2@ops.example",
      "sl3@ops.example",
      "sl4@ops.example",
    ]);
  });

  it("folds the two chunks of a shared attachment blob into one hit", async () => {
    const dk = await open();
    const attText =
      "The quorum threshold for the tribunal vote is seventeen of the " +
      "twenty three seated members.";
    await dk.ingest.emlBytes(
      makeMultipartEml({
        messageId: "att1@ops.example",
        from: "Rita Vale <rita@ops.example>",
        to: "desk@ops.example",
        subject: "Bylaws",
        date: "Mon, 01 Mar 2024 09:00:00 +0000",
        body: "See attached.",
        attachment: { filename: "bylaws.txt", text: attText },
      }),
    );
    await dk.ingest.emlBytes(
      makeMultipartEml({
        messageId: "att2@ops.example",
        from: "Sam Ito <sam@ops.example>",
        to: "desk@ops.example",
        subject: "Fwd: Bylaws",
        date: "Fri, 05 Mar 2024 09:00:00 +0000",
        body: "Forwarding the bylaws again.",
        attachment: { filename: "bylaws.txt", text: attText },
      }),
    );

    const hits = await dk.tools.hybridSearch({
      query: "quorum threshold tribunal seventeen",
      filter: { sourceKind: "attachment" },
    });

    expect(hits.length).toBe(1);
    const hit = hits[0]!;
    expect(hit.messageId).toBe("att1@ops.example"); // earliest message primary
    expect(hit.duplicates!.length).toBe(1);
    expect(hit.duplicates![0]!.messageId).toBe("att2@ops.example");
    // both chunks come from the same deduplicated attachment blob
    const blobOf = (chunkId: string): string => chunkId.split("_")[1] ?? "";
    expect(blobOf(hit.duplicates![0]!.chunkId)).toBe(blobOf(hit.chunkId));
    expect(hit.duplicates![0]!.chunkId).not.toBe(hit.chunkId);
  });

  it("is deterministic: identical calls return deep-equal results", async () => {
    const dk = await open();
    await ingestThread(dk, THREAD, PARAGRAPH);
    await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Vik Chandra <vik@ops.example>",
          To: "desk@ops.example",
          Subject: "Survey",
          Date: "Tue, 05 Mar 2024 09:00:00 +0000",
          "Message-ID": "<det1@ops.example>",
          "Content-Type": PLAIN,
        },
        "The marine survey report is booked for the pontoon next week.",
      ),
    );

    const q = { query: "escrow harbor pontoon inspection survey", k: 5 };
    const a = await dk.tools.hybridSearch(q);
    const b = await dk.tools.hybridSearch(q);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});
