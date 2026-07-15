/**
 * Batched ingest (plan task 1.3): the chunked-transaction bulk path must be
 * observationally identical to one-by-one ingestion, report progress, stay
 * idempotent, and survive a poisoned batch member.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";

const tempDirs: string[] = [];
const dockets: Docket[] = [];

afterEach(() => {
  for (const dk of dockets.splice(0)) dk.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function openDocket(): Promise<Docket> {
  const dk = await Docket.open(tempDir("docket-batch-db-"));
  dockets.push(dk);
  return dk;
}

function makeEml(headers: Record<string, string>, body: string): Uint8Array {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return new TextEncoder().encode(`${head}\r\n\r\n${body}`);
}

/**
 * 25 deterministic messages: 10 thread roots, plus 15 replies spread over the
 * first 5 threads (3 replies each), with proper In-Reply-To and References.
 */
function corpus(): Array<{ name: string; bytes: Uint8Array }> {
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  let minute = 0;
  const stamp = (): string => {
    const d = new Date(Date.UTC(2024, 2, 4, 9, minute));
    minute += 7;
    return d.toUTCString();
  };
  for (let t = 0; t < 10; t++) {
    out.push({
      name: `m-${String(out.length).padStart(3, "0")}.eml`,
      bytes: makeEml(
        {
          "Message-ID": `<root-${t}@batch.example>`,
          From: `Sender ${t} <sender${t}@batch.example>`,
          To: `crew@batch.example`,
          Subject: `Topic ${t} kickoff`,
          Date: stamp(),
        },
        `Opening note for topic ${t}.\nThe fittings order needs review.\n`,
      ),
    });
  }
  for (let t = 0; t < 5; t++) {
    for (let r = 1; r <= 3; r++) {
      const parent = r === 1 ? `root-${t}@batch.example` : `reply-${t}-${r - 1}@batch.example`;
      const refs = [`<root-${t}@batch.example>`];
      for (let p = 1; p < r; p++) refs.push(`<reply-${t}-${p}@batch.example>`);
      out.push({
        name: `m-${String(out.length).padStart(3, "0")}.eml`,
        bytes: makeEml(
          {
            "Message-ID": `<reply-${t}-${r}@batch.example>`,
            "In-Reply-To": `<${parent}>`,
            References: refs.join(" "),
            From: `Replier ${r} <replier${r}@batch.example>`,
            To: `sender${t}@batch.example`,
            Subject: `Re: Topic ${t} kickoff`,
            Date: stamp(),
          },
          `Reply ${r} on topic ${t}.\nConfirming quantities and dates.\n`,
        ),
      });
    }
  }
  return out;
}

function writeCorpus(files: Array<{ name: string; bytes: Uint8Array }>): string {
  const dir = tempDir("docket-batch-eml-");
  const messages = join(dir, "messages");
  mkdirSync(messages);
  for (const f of files) writeFileSync(join(messages, f.name), f.bytes);
  return dir;
}

function count(dk: Docket, table: "messages" | "threads"): number {
  const rows = dk.tools.sqlFilter({ table, limit: 500 });
  return rows.length;
}

/** thread groupings as a canonical string: sorted list of sorted member lists */
function threadGroups(dk: Docket): string {
  const rows = dk.tools.sqlFilter({ table: "messages", limit: 500 }) as Array<{
    message_id: string;
    thread_id: string;
  }>;
  const byThread = new Map<string, string[]>();
  for (const r of rows) {
    const list = byThread.get(r.thread_id) ?? [];
    list.push(r.message_id);
    byThread.set(r.thread_id, list);
  }
  return [...byThread.values()]
    .map((ids) => ids.sort().join(","))
    .sort()
    .join(";");
}

async function chunkCount(dk: Docket): Promise<number> {
  const hits = await dk.tools.hybridSearch({ query: "topic", k: 500 });
  return hits.length;
}

describe("batched ingest", () => {
  it("dir() with batchSize 10 matches one-by-one emlBytes ingestion", async () => {
    const files = corpus();
    const root = writeCorpus(files);

    const batched = await openDocket();
    const results = await batched.ingest.dir(root, { batchSize: 10 });
    expect(results).toHaveLength(25);
    expect(results.every((r) => r.fresh)).toBe(true);

    const oneByOne = await openDocket();
    for (const f of files) await oneByOne.ingest.emlBytes(f.bytes);

    expect(count(batched, "messages")).toBe(25);
    expect(count(batched, "messages")).toBe(count(oneByOne, "messages"));
    expect(count(batched, "threads")).toBe(count(oneByOne, "threads"));
    expect(threadGroups(batched)).toBe(threadGroups(oneByOne));
    expect(await chunkCount(batched)).toBe(await chunkCount(oneByOne));
  });

  it("reports monotonically increasing progress with the right total", async () => {
    const root = writeCorpus(corpus());
    const dk = await openDocket();

    const calls: Array<[number, number]> = [];
    await dk.ingest.dir(root, {
      batchSize: 10,
      onProgress: (done, total) => calls.push([done, total]),
    });

    expect(calls).toHaveLength(3); // 10 + 10 + 5
    expect(calls.every(([, total]) => total === 25)).toBe(true);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]![0]).toBeGreaterThan(calls[i - 1]![0]);
    }
    expect(calls.at(-1)![0]).toBe(25);
  });

  it("stays idempotent through the batch path", async () => {
    const root = writeCorpus(corpus());
    const dk = await openDocket();

    const first = await dk.ingest.dir(root, { batchSize: 10 });
    expect(first.every((r) => r.fresh)).toBe(true);
    const messagesBefore = count(dk, "messages");
    const threadsBefore = count(dk, "threads");
    const chunksBefore = await chunkCount(dk);

    const second = await dk.ingest.dir(root, { batchSize: 10 });
    expect(second).toHaveLength(25);
    expect(second.every((r) => r.fresh === false)).toBe(true);
    expect(count(dk, "messages")).toBe(messagesBefore);
    expect(count(dk, "threads")).toBe(threadsBefore);
    expect(await chunkCount(dk)).toBe(chunksBefore);
  });

  it("a zero-byte batch member does not sink the rest of the batch", async () => {
    const files = corpus();
    const root = writeCorpus(files);
    writeFileSync(join(root, "messages", "m-005-poison.eml"), new Uint8Array(0));

    const dk = await openDocket();
    const results = await dk.ingest.dir(root, { batchSize: 10 });

    // every real message landed regardless of what the empty file produced
    const rows = dk.tools.sqlFilter({ table: "messages", limit: 500 }) as Array<{
      message_id: string;
    }>;
    const ids = new Set(rows.map((r) => r.message_id));
    for (let t = 0; t < 10; t++) expect(ids.has(`root-${t}@batch.example`)).toBe(true);
    for (let t = 0; t < 5; t++) {
      for (let r = 1; r <= 3; r++) expect(ids.has(`reply-${t}-${r}@batch.example`)).toBe(true);
    }
    expect(results.length).toBeGreaterThanOrEqual(25);
  });
});
