/**
 * Thread-context expansion (plan 2.5, spec 3.6). All scenarios go through
 * the public Docket facade on temp dirs with synthetic emails: with
 * expand: "thread", each hit carries up to 2 messages each side of its own
 * message (send-time order, hit excluded, per-entry text capped at 1200
 * chars), and without it nothing changes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";

const envs: Array<{ dk: Docket; dir: string }> = [];

async function open(): Promise<Docket> {
  const dir = mkdtempSync(join(tmpdir(), "docket-expand-"));
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

interface Seed {
  messageId: string;
  from: string;
  date: string;
  body: string;
}

/**
 * Ingest a thread with proper References chains (each reply references
 * every prior message). Bodies are single lines so each message yields one
 * 'new' fragment whose text equals the body exactly.
 */
async function ingestThread(dk: Docket, subject: string, seeds: Seed[]): Promise<void> {
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]!;
    const headers: Record<string, string> = {
      From: s.from,
      To: "desk@ops.example",
      Subject: i === 0 ? subject : `Re: ${subject}`,
      Date: s.date,
      "Message-ID": `<${s.messageId}>`,
      "Content-Type": PLAIN,
    };
    if (i > 0) {
      headers["In-Reply-To"] = `<${seeds[i - 1]!.messageId}>`;
      headers["References"] = seeds
        .slice(0, i)
        .map((p) => `<${p.messageId}>`)
        .join(" ");
    }
    await dk.ingest.emlBytes(makeEml(headers, s.body));
  }
}

/** six-message thread, distinct sentences, message 3 holds the unique phrase */
const SIX: Seed[] = [
  {
    messageId: "ex1@ops.example",
    from: "Rita Vale <rita@ops.example>",
    date: "Fri, 01 Mar 2024 09:00:00 +0000",
    body: "Kickoff for the granite atrium bid closes friday and the site walk is booked.",
  },
  {
    messageId: "ex2@ops.example",
    from: "Sam Ito <sam@ops.example>",
    date: "Sat, 02 Mar 2024 09:00:00 +0000",
    body: "Surveyor notes flag drainage under the north wing before the pour.",
  },
  {
    messageId: "ex3@ops.example",
    from: "Ana Reyes <ana@ops.example>",
    date: "Sun, 03 Mar 2024 09:00:00 +0000",
    body: "The falcon crate manifest cleared the ostend customs berth this morning.",
  },
  {
    messageId: "ex4@ops.example",
    from: "Leo Marsh <leo@ops.example>",
    date: "Mon, 04 Mar 2024 09:00:00 +0000",
    body: "Steel tonnage quote from the mill lands tuesday with the revised gauge.",
  },
  {
    messageId: "ex5@ops.example",
    from: "Vik Chandra <vik@ops.example>",
    date: "Tue, 05 Mar 2024 09:00:00 +0000",
    body: "Permit office wants the acoustic study appended to the variance file.",
  },
  {
    messageId: "ex6@ops.example",
    from: "Mia Torres <mia@ops.example>",
    date: "Wed, 06 Mar 2024 09:00:00 +0000",
    body: "Final walkthrough moved to the ninth pending the elevator inspection.",
  },
];

const MID_QUERY = "falcon crate manifest ostend berth";

describe("thread-context expansion", () => {
  it("attaches 2 messages each side of a mid-thread hit, in send order, hit excluded", async () => {
    const dk = await open();
    await ingestThread(dk, "Atrium build", SIX);

    const hits = await dk.tools.hybridSearch({ query: MID_QUERY, expand: "thread" });

    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0]!;
    expect(hit.messageId).toBe("ex3@ops.example");
    expect(hit.threadContext).toBeDefined();
    const ctx = hit.threadContext!;
    expect(ctx.length).toBe(4);
    expect(ctx.map((e) => e.messageId)).toEqual([
      "ex1@ops.example",
      "ex2@ops.example",
      "ex4@ops.example",
      "ex5@ops.example",
    ]);
    // the hit's own message never appears in its context
    expect(ctx.some((e) => e.messageId === hit.messageId)).toBe(false);
    const bySeed = new Map(SIX.map((s) => [s.messageId, s]));
    for (const e of ctx) {
      const seed = bySeed.get(e.messageId)!;
      expect(e.fromAddress).toBe(seed.from.match(/<(.+)>/)![1]);
      expect(e.sentAt).toBeTruthy();
      expect(e.newText).toBe(seed.body); // stripped new text, single fragment
    }
    // send-time order
    const sentAts = ctx.map((e) => e.sentAt ?? "");
    expect([...sentAts].sort()).toEqual(sentAts);
  });

  it("a hit at the thread head only carries the following messages", async () => {
    const dk = await open();
    await ingestThread(dk, "Atrium build", SIX);

    const hits = await dk.tools.hybridSearch({
      query: "granite atrium bid site walk",
      expand: "thread",
    });

    const hit = hits.find((h) => h.messageId === "ex1@ops.example")!;
    expect(hit).toBeDefined();
    expect(hit.threadContext!.map((e) => e.messageId)).toEqual([
      "ex2@ops.example",
      "ex3@ops.example",
    ]);
  });

  it("omits threadContext entirely for a single-message thread", async () => {
    const dk = await open();
    await dk.ingest.emlBytes(
      makeEml(
        {
          From: "Rita Vale <rita@ops.example>",
          To: "desk@ops.example",
          Subject: "Lone note",
          Date: "Mon, 01 Apr 2024 09:00:00 +0000",
          "Message-ID": "<solo1@ops.example>",
          "Content-Type": PLAIN,
        },
        "The zircon ballast invoice awaits countersignature at the bursar desk.",
      ),
    );

    const hits = await dk.tools.hybridSearch({
      query: "zircon ballast countersignature bursar",
      expand: "thread",
    });

    expect(hits.length).toBe(1);
    expect("threadContext" in hits[0]!).toBe(false);
  });

  it("caps each entry's newText at 1200 chars", async () => {
    const dk = await open();
    const longBody = Array.from(
      { length: 60 },
      (_, i) => `segment ${i} of the dredging appendix continues with clause ${i * 7}`,
    ).join(" ");
    expect(longBody.length).toBeGreaterThan(3000);
    await ingestThread(dk, "Dredging appendix", [
      {
        messageId: "cap1@ops.example",
        from: "Rita Vale <rita@ops.example>",
        date: "Mon, 01 Apr 2024 09:00:00 +0000",
        body: "The pontoon winch tender opens thursday at the harbor annex.",
      },
      {
        messageId: "cap2@ops.example",
        from: "Sam Ito <sam@ops.example>",
        date: "Tue, 02 Apr 2024 09:00:00 +0000",
        body: longBody,
      },
    ]);

    const hits = await dk.tools.hybridSearch({
      query: "pontoon winch tender harbor annex",
      expand: "thread",
    });

    const hit = hits.find((h) => h.messageId === "cap1@ops.example")!;
    expect(hit).toBeDefined();
    const entry = hit.threadContext!.find((e) => e.messageId === "cap2@ops.example")!;
    expect(entry).toBeDefined();
    expect(entry.newText.length).toBe(1200);
    expect(entry.newText).toBe(longBody.slice(0, 1200));
  });

  it("expand absent and expand: \"none\" behave identically and attach nothing", async () => {
    const dk = await open();
    await ingestThread(dk, "Atrium build", SIX);

    const plain = await dk.tools.hybridSearch({ query: MID_QUERY });
    const none = await dk.tools.hybridSearch({ query: MID_QUERY, expand: "none" });

    expect(plain.length).toBeGreaterThan(0);
    expect(none).toEqual(plain);
    for (const h of [...plain, ...none]) {
      expect("threadContext" in h).toBe(false);
    }
  });

  it("a deduped primary hit carries context relative to its own (earliest) message", async () => {
    const dk = await open();
    const sentence =
      "The mahogany rostrum shipment cleared bonded storage without a surcharge.";
    await ingestThread(dk, "Rostrum shipment", [
      {
        messageId: "dd1@ops.example",
        from: "Rita Vale <rita@ops.example>",
        date: "Mon, 01 Apr 2024 09:00:00 +0000",
        body: sentence,
      },
      {
        messageId: "dd2@ops.example",
        from: "Sam Ito <sam@ops.example>",
        date: "Tue, 02 Apr 2024 09:00:00 +0000",
        body: sentence,
      },
      {
        messageId: "dd3@ops.example",
        from: "Ana Reyes <ana@ops.example>",
        date: "Wed, 03 Apr 2024 09:00:00 +0000",
        body: sentence,
      },
    ]);

    const hits = await dk.tools.hybridSearch({
      query: "mahogany rostrum bonded surcharge",
      expand: "thread",
    });

    expect(hits.length).toBe(1);
    const hit = hits[0]!;
    expect(hit.messageId).toBe("dd1@ops.example"); // earliest is primary
    expect(hit.duplicates!.length).toBe(2);
    // context is relative to the primary's message: the two that follow it
    expect(hit.threadContext!.map((e) => e.messageId)).toEqual([
      "dd2@ops.example",
      "dd3@ops.example",
    ]);
  });

  it("is deterministic: identical expanded calls return deep-equal results", async () => {
    const dk = await open();
    await ingestThread(dk, "Atrium build", SIX);

    const q = { query: MID_QUERY, expand: "thread" as const, k: 5 };
    const a = await dk.tools.hybridSearch(q);
    const b = await dk.tools.hybridSearch(q);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});
