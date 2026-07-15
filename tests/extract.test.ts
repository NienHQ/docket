/**
 * Fact extraction pipeline (plan 3.1, spec 3.4) through the public facade:
 * scripted complete() functions drive extraction over synthetic corpora on
 * temp dirs. Covers the happy path, run skipping by thread state hash,
 * version bumps with duplicate-safe re-assertion, every rejection reason,
 * bad JSON handling, the read-only guard, and the input cap.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";
import { EXTRACT_INSTRUCTION, MAX_INPUT_CHARS } from "../src/extract/facts.js";
import type { ProposedFact, RejectedFact } from "../src/types.js";

const PLAIN = 'text/plain; charset="utf-8"';

function makeEml(headers: Record<string, string>, body: string): Uint8Array {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return new TextEncoder().encode(`${head}\r\n\r\n${body}`);
}

const TERMS_BODY =
  "Acme Corp and Beta Ltd agree payment terms of NET 30 effective 2024-01-05 " +
  "for all fabrication orders placed this year.";
const TERMS_REVISED_BODY =
  "Following the volume review, payment terms are revised to NET 45 " +
  "effective 2024-03-01 for Acme Corp orders.";
const RENT_BODY =
  "Monthly rent for the Walnut Street premises is $500.00 effective " +
  "2024-02-01 as agreed with Bluestone Properties.";

function termsEml(): Uint8Array {
  return makeEml(
    {
      "Message-ID": "<t1m1@corp.example>",
      From: "Alice Ng <alice@acme.example>",
      To: "bob@beta.example",
      Subject: "Trading terms",
      Date: "Fri, 05 Jan 2024 09:00:00 +0000",
      "Content-Type": PLAIN,
    },
    TERMS_BODY,
  );
}

function termsRevisedEml(): Uint8Array {
  return makeEml(
    {
      "Message-ID": "<t1m2@corp.example>",
      From: "Bob Ray <bob@beta.example>",
      To: "alice@acme.example",
      Subject: "Re: Trading terms",
      "In-Reply-To": "<t1m1@corp.example>",
      References: "<t1m1@corp.example>",
      Date: "Fri, 01 Mar 2024 09:00:00 +0000",
      "Content-Type": PLAIN,
    },
    TERMS_REVISED_BODY,
  );
}

function rentEml(): Uint8Array {
  return makeEml(
    {
      "Message-ID": "<t2m1@corp.example>",
      From: "Hugo Yates <hugo@bluestone.example>",
      To: "iris@acme.example",
      Subject: "Premises rent",
      Date: "Thu, 01 Feb 2024 09:00:00 +0000",
      "Content-Type": PLAIN,
    },
    RENT_BODY,
  );
}

function chunkIdsOf(prompt: string): string[] {
  return [...prompt.matchAll(/\[chunk (chk_[a-z0-9_]+)\]/g)].map((m) => m[1]!);
}

function withRoDb<T>(dir: string, fn: (db: Database) => T): T {
  const db = new DatabaseCtor(join(dir, "docket.db"), { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface ChunkInfo {
  chunk_id: string;
  text: string;
  thread_id: string;
}

function chunkInfos(dir: string): ChunkInfo[] {
  return withRoDb(dir, (db) =>
    db
      .prepare(
        "SELECT c.chunk_id, c.text, m.thread_id FROM chunks c" +
          " JOIN messages m ON m.message_id = c.message_id ORDER BY c.chunk_id",
      )
      .all(),
  ) as ChunkInfo[];
}

/** the scripted stand-in for an extraction model used by the happy-path arc */
function scriptedComplete(calls: string[]): (prompt: string) => Promise<string> {
  return async (prompt) => {
    calls.push(prompt);
    const ids = chunkIdsOf(prompt);
    if (prompt.includes("payment terms")) {
      const proposals: ProposedFact[] = [
        {
          entity: "Acme Corp",
          relation: "payment_terms",
          value: "NET 30",
          validFrom: "2024-01-05",
          sourceChunk: ids[0]!,
        },
      ];
      if (prompt.includes("revised")) {
        proposals.push({
          entity: "Acme Corp",
          relation: "payment_terms",
          value: "NET 45",
          validFrom: "2024-03-01",
          sourceChunk: ids[ids.length - 1]!,
        });
      }
      return JSON.stringify(proposals);
    }
    if (prompt.includes("Monthly rent")) {
      // fenced on purpose: the parser must strip markdown fences
      const body = JSON.stringify([
        {
          entity: "Bluestone Properties",
          relation: "monthly_rent",
          value: "$500.00",
          validFrom: "2024-02-01",
          sourceChunk: ids[0]!,
        },
      ]);
      return "```json\n" + body + "\n```";
    }
    return "[]";
  };
}

describe("extractFacts: runs, skips, version bumps, incremental threads", () => {
  let dir: string;
  let dk: Docket;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "docket-extract-"));
    dk = await Docket.open(dir);
    await dk.ingest.emlBytes(termsEml());
    await dk.ingest.emlBytes(rentEml());
  });

  afterAll(() => {
    dk?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("happy path: one valid proposal per thread lands in the ledger", async () => {
    const calls: string[] = [];
    const report = await dk.extractFacts({ complete: scriptedComplete(calls) });

    expect(report).toEqual({ threads: 2, skipped: 0, proposed: 2, asserted: 2, rejected: 0 });
    expect(calls).toHaveLength(2);

    const terms = dk.facts.asOf("Acme Corp", "payment_terms", "2024-06-01");
    expect(terms?.value).toBe("NET 30");
    expect(terms?.sourceChunk).toMatch(/^chk_/);
    const rent = dk.facts.asOf("Bluestone Properties", "monthly_rent", "2024-02-15");
    expect(rent?.value).toBe("$500.00");

    const runs = withRoDb(dir, (db) =>
      db.prepare("SELECT thread_id, proposed, asserted, rejected FROM fact_extract_runs").all(),
    ) as Array<{ proposed: number; asserted: number; rejected: number }>;
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.proposed === 1 && r.asserted === 1 && r.rejected === 0)).toBe(
      true,
    );
  });

  it("re-running the same version skips every unchanged thread", async () => {
    const calls: string[] = [];
    const before = dk.facts.history("Acme Corp", "payment_terms").length;

    const report = await dk.extractFacts({ complete: scriptedComplete(calls) });

    expect(report).toEqual({ threads: 0, skipped: 2, proposed: 0, asserted: 0, rejected: 0 });
    expect(calls).toHaveLength(0);
    expect(dk.facts.history("Acme Corp", "payment_terms")).toHaveLength(before);
  });

  it("version bump re-extracts but identical proposals do not double-assert", async () => {
    const calls: string[] = [];
    const termsBefore = dk.facts.history("Acme Corp", "payment_terms").length;
    const rentBefore = dk.facts.history("Bluestone Properties", "monthly_rent").length;

    const report = await dk.extractFacts({ complete: scriptedComplete(calls), version: "2" });

    expect(calls).toHaveLength(2);
    expect(report).toEqual({ threads: 2, skipped: 0, proposed: 2, asserted: 0, rejected: 0 });
    expect(dk.facts.history("Acme Corp", "payment_terms")).toHaveLength(termsBefore);
    expect(dk.facts.history("Bluestone Properties", "monthly_rent")).toHaveLength(rentBefore);
  });

  it("a new message changes the thread hash: only that thread re-processes", async () => {
    await dk.ingest.emlBytes(termsRevisedEml());

    const calls: string[] = [];
    const report = await dk.extractFacts({ complete: scriptedComplete(calls), version: "2" });

    expect(report).toEqual({ threads: 1, skipped: 1, proposed: 2, asserted: 1, rejected: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("revised to NET 45");
    expect(calls[0]).not.toContain("Monthly rent");

    // NET 30 was a duplicate; NET 45 extends the interval chain
    expect(dk.facts.asOf("Acme Corp", "payment_terms", "2024-02-01")?.value).toBe("NET 30");
    expect(dk.facts.asOf("Acme Corp", "payment_terms", "2024-04-01")?.value).toBe("NET 45");
  });

  it("read-only instances reject extraction", async () => {
    const ro = await Docket.open(dir, { readonly: true });
    try {
      await expect(ro.extractFacts({ complete: async () => "[]" })).rejects.toThrow(
        /read-only/,
      );
    } finally {
      ro.close();
    }
  });
});

describe("extractFacts: validation rejects and bad JSON", () => {
  let dir: string;
  let dk: Docket;
  let termsChunk: ChunkInfo;
  let rentChunk: ChunkInfo;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "docket-extract-rej-"));
    dk = await Docket.open(dir);
    await dk.ingest.emlBytes(termsEml());
    await dk.ingest.emlBytes(rentEml());
    const infos = chunkInfos(dir);
    termsChunk = infos.find((c) => c.text.includes("payment terms"))!;
    rentChunk = infos.find((c) => c.text.includes("Monthly rent"))!;
    expect(termsChunk).toBeDefined();
    expect(rentChunk).toBeDefined();
  });

  afterAll(() => {
    dk?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("every invalid proposal is rejected with its specific reason", async () => {
    const good: ProposedFact = {
      entity: "Acme Corp",
      relation: "payment_terms",
      value: "NET 30",
      validFrom: "2024-01-05",
      sourceChunk: termsChunk.chunk_id,
    };
    const batch: unknown[] = [
      { ...good, value: "" }, // bad_shape
      { ...good, validFrom: "2024-02-30" }, // bad_date
      { ...good, sourceChunk: "chk_0000000000_0" }, // unknown_chunk
      { ...good, sourceChunk: rentChunk.chunk_id }, // foreign_chunk
      { ...good, value: "NET 99" }, // ungrounded_value
      { ...good, entity: "Zephyr Holdings" }, // ungrounded_entity
      { ...good, relation: "payment terms" }, // bad_relation
      good, // asserted
    ];

    const rejections: RejectedFact[] = [];
    const report = await dk.extractFacts({
      complete: async (prompt) =>
        prompt.includes("payment terms") ? JSON.stringify(batch) : "[]",
      onReject: (r) => rejections.push(r),
    });

    expect(report).toEqual({ threads: 2, skipped: 0, proposed: 8, asserted: 1, rejected: 7 });
    expect(rejections).toHaveLength(7);
    const expectedReasons = [
      "bad_shape",
      "bad_date",
      "unknown_chunk",
      "foreign_chunk",
      "ungrounded_value",
      "ungrounded_entity",
      "bad_relation",
    ];
    expect(rejections.map((r) => r.reason)).toEqual(expectedReasons);
    expect(rejections.every((r) => r.threadId === termsChunk.thread_id)).toBe(true);

    const rows = withRoDb(dir, (db) =>
      db.prepare("SELECT reason FROM fact_extract_rejects ORDER BY id").all(),
    ) as Array<{ reason: string }>;
    expect(rows.map((r) => r.reason)).toEqual(expectedReasons);

    expect(dk.facts.asOf("Acme Corp", "payment_terms", "2024-06-01")?.value).toBe("NET 30");
  });

  it("unparseable output rejects the whole thread once and still records the run", async () => {
    let callCount = 0;
    const prose = async (): Promise<string> => {
      callCount++;
      return "I could not find any durable facts in this correspondence.";
    };

    const report = await dk.extractFacts({
      complete: prose,
      version: "2",
      threads: [termsChunk.thread_id],
    });
    expect(report).toEqual({ threads: 1, skipped: 0, proposed: 0, asserted: 0, rejected: 1 });
    expect(callCount).toBe(1);

    const rows = withRoDb(dir, (db) =>
      db
        .prepare(
          "SELECT reason, payload_json FROM fact_extract_rejects WHERE tool_version = '2'",
        )
        .all(),
    ) as Array<{ reason: string; payload_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("bad_json");
    expect(rows[0]!.payload_json).toContain("durable facts");

    const runs = withRoDb(dir, (db) =>
      db
        .prepare(
          "SELECT proposed, asserted, rejected FROM fact_extract_runs WHERE tool_version = '2'",
        )
        .all(),
    ) as Array<{ proposed: number; asserted: number; rejected: number }>;
    expect(runs).toEqual([{ proposed: 0, asserted: 0, rejected: 1 }]);

    // same version and unchanged thread: the failed run is not retried
    const again = await dk.extractFacts({
      complete: prose,
      version: "2",
      threads: [termsChunk.thread_id],
    });
    expect(again).toEqual({ threads: 0, skipped: 1, proposed: 0, asserted: 0, rejected: 0 });
    expect(callCount).toBe(1);
  });
});

describe("extractFacts: input cap", () => {
  let dir: string;
  let dk: Docket;

  const BODY_TAIL = Array(40).fill("survey beam ledger").join(" ");
  const TOTAL_MESSAGES = 25;

  function capEml(i: number): Uint8Array {
    const marker = `SITEMARK${String(i).padStart(2, "0")}`;
    const headers: Record<string, string> = {
      "Message-ID": `<cap-${i}@corp.example>`,
      From: `Surveyor <survey@site.example>`,
      To: "office@site.example",
      Subject: i === 1 ? "Site capacity" : "Re: Site capacity",
      Date: `Mon, ${String(i).padStart(2, "0")} Apr 2024 09:00:00 +0000`,
      "Content-Type": PLAIN,
    };
    if (i > 1) {
      headers["In-Reply-To"] = "<cap-1@corp.example>";
      headers["References"] = "<cap-1@corp.example>";
    }
    return makeEml(headers, `${marker} ${BODY_TAIL}`);
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "docket-extract-cap-"));
    dk = await Docket.open(dir);
    for (let i = 1; i <= TOTAL_MESSAGES; i++) await dk.ingest.emlBytes(capEml(i));
  });

  afterAll(() => {
    dk?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("caps thread input at the limit and only drops whole trailing messages", async () => {
    let captured = "";
    const report = await dk.extractFacts({
      complete: async (prompt) => {
        captured = prompt;
        return "[]";
      },
    });
    expect(report.threads).toBe(1);
    expect(captured.startsWith(EXTRACT_INSTRUCTION + "\n\n")).toBe(true);

    const input = captured.slice(EXTRACT_INSTRUCTION.length + 2);
    expect(input.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
    expect(input).toContain("SITEMARK01");
    expect(input).not.toContain(`SITEMARK${TOTAL_MESSAGES}`);

    // never split mid-chunk: every line is either a message header or a
    // complete chunk line carrying the full body text
    const lines = input.split("\n");
    const headerRe = /^From \S+ on .*:$/;
    const chunkRe = /^\[chunk chk_[a-z0-9_]+\] SITEMARK\d{2} /;
    let headers = 0;
    let chunks = 0;
    for (const line of lines) {
      if (headerRe.test(line)) {
        headers++;
        continue;
      }
      expect(line).toMatch(chunkRe);
      expect(line.endsWith(BODY_TAIL)).toBe(true);
      chunks++;
    }
    expect(headers).toBe(chunks); // one single-chunk body per included message
    expect(headers).toBeGreaterThan(0);
    expect(headers).toBeLessThan(TOTAL_MESSAGES);
  });
});
