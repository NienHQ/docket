/**
 * LLM contextualizer + context_cache (plan task 2.3). The cache is keyed
 * (chunk id, tool, tool version): reindex re-derives identical chunk ids
 * (spec invariant 3) and must hit the cache 100 percent, a version bump
 * invalidates, tombstone and replaced-message purges remove cached context
 * with the content, and the default deterministic path never touches the
 * table.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";
import { MetaContextualizer } from "../src/indexer/context.js";
import { LlmContextualizer } from "../src/indexer/llm-context.js";
import type { ChunkDraft } from "../src/types.js";

const tempDirs: string[] = [];
const dockets: Docket[] = [];

afterEach(() => {
  for (const dk of dockets.splice(0)) dk.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "docket-ctx-cache-"));
  tempDirs.push(dir);
  return dir;
}

async function openDocket(dir: string, contextualizer?: LlmContextualizer): Promise<Docket> {
  const dk = await Docket.open(dir, contextualizer ? { contextualizer } : {});
  dockets.push(dk);
  return dk;
}

/** Read rows straight from the SQLite file (readonly, WAL allows coexistence). */
function rows<T>(dir: string, sql: string, ...args: Array<string | number>): T[] {
  const db = new DatabaseCtor(join(dir, "docket.db"), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

function count(dir: string, sql: string, ...args: Array<string | number>): number {
  return rows<{ n: number }>(dir, sql, ...args)[0]!.n;
}

/**
 * Counting mock complete(): deterministic output derived from the prompt so
 * assertions are stable, with an optional predicate that returns "" instead.
 */
function countingComplete(emptyWhen?: (prompt: string) => boolean): {
  complete: (prompt: string) => Promise<string>;
  state: { calls: number };
} {
  const state = { calls: 0 };
  const complete = async (prompt: string): Promise<string> => {
    state.calls += 1;
    if (emptyWhen?.(prompt)) return "";
    const h = createHash("sha256").update(prompt).digest("hex").slice(0, 8);
    return `quaggamarsh ctx(${h})`;
  };
  return { complete, state };
}

const MOCK_CONTEXT = /^quaggamarsh ctx\([0-9a-f]{8}\)$/;

function makeEml(headers: Record<string, string>, body: string): Uint8Array {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return new TextEncoder().encode(`${head}\r\n\r\n${body}`);
}

/** 5 deterministic messages; the first carries a text attachment so the
 * attachment chunk id scheme (chk_<blob>_m<hash12>_<n>) is exercised too. */
function fixtureEmails(): Uint8Array[] {
  const out: Uint8Array[] = [];
  const withAttachment = [
    'Message-ID: <ctx-0@cache.example>',
    "From: Sender 0 <sender0@cache.example>",
    "To: ops@cache.example",
    "Subject: Invoice INV-100 status",
    "Date: Mon, 4 Mar 2024 09:00:00 +0000",
    'Content-Type: multipart/mixed; boundary="B0"',
    "",
    "--B0",
    "Content-Type: text/plain",
    "",
    "Invoice INV-100 for milestone 0 is attached. Total due is $100.00 by end of month.",
    "--B0",
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    "",
    "Ledger reconciliation notes for INV-100: opening balance matches statement line 4.",
    "--B0--",
    "",
  ].join("\r\n");
  out.push(new TextEncoder().encode(withAttachment));
  for (let i = 1; i < 5; i++) {
    out.push(
      makeEml(
        {
          "Message-ID": `<ctx-${i}@cache.example>`,
          From: `Sender ${i} <sender${i}@cache.example>`,
          To: "ops@cache.example",
          Subject: `Invoice INV-10${i} status`,
          Date: `Mon, 4 Mar 2024 09:0${i}:00 +0000`,
        },
        `Invoice INV-10${i} for milestone ${i} is now overdue. Total due is $${i}00.00 by end of month.`,
      ),
    );
  }
  return out;
}

interface ChunkRow {
  chunk_id: string;
  span_start: number;
  span_end: number;
  context: string;
}

const CHUNK_SNAPSHOT_SQL =
  "SELECT chunk_id, span_start, span_end, context FROM chunks ORDER BY chunk_id";

describe("LlmContextualizer with context_cache", () => {
  it("fills the cache on ingest: one complete() per chunk, contexts stored", async () => {
    const dir = tempDir();
    const { complete, state } = countingComplete();
    const dk = await openDocket(dir, new LlmContextualizer({ complete }));
    for (const e of fixtureEmails()) await dk.ingest.emlBytes(e);

    const chunks = rows<{ chunk_id: string; context: string }>(
      dir,
      "SELECT chunk_id, context FROM chunks ORDER BY chunk_id",
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(state.calls).toBe(chunks.length);
    for (const c of chunks) expect(c.context).toMatch(MOCK_CONTEXT);

    const cached = rows<{ chunk_id: string; context: string }>(
      dir,
      "SELECT chunk_id, context FROM context_cache ORDER BY chunk_id",
    );
    expect(cached).toEqual(chunks);
    expect(
      count(dir, "SELECT COUNT(*) AS n FROM context_cache WHERE tool = 'llm-context' AND tool_version = '1'"),
    ).toBe(chunks.length);
  });

  it("reindex hits the cache 100 percent: zero new complete() calls, identical chunks", async () => {
    const dir = tempDir();
    const { complete, state } = countingComplete();
    const dk = await openDocket(dir, new LlmContextualizer({ complete }));
    for (const e of fixtureEmails()) await dk.ingest.emlBytes(e);

    const before = rows<ChunkRow>(dir, CHUNK_SNAPSHOT_SQL);
    const callsBefore = state.calls;
    expect(callsBefore).toBeGreaterThan(0);

    await dk.reindex();

    expect(state.calls).toBe(callsBefore); // the done criterion: 100 percent cache hit
    const after = rows<ChunkRow>(dir, CHUNK_SNAPSHOT_SQL);
    expect(after).toEqual(before);
  });

  it("version bump invalidates: reindex under version 2 re-pays every chunk", async () => {
    const dir = tempDir();
    const { complete, state } = countingComplete();
    const dk1 = await openDocket(dir, new LlmContextualizer({ complete }));
    for (const e of fixtureEmails()) await dk1.ingest.emlBytes(e);
    const chunkCount = count(dir, "SELECT COUNT(*) AS n FROM chunks");
    const callsAfterIngest = state.calls;
    dk1.close();
    dockets.splice(dockets.indexOf(dk1), 1);

    const dk2 = await openDocket(dir, new LlmContextualizer({ complete, version: "2" }));
    await dk2.reindex();

    expect(state.calls).toBe(callsAfterIngest + chunkCount);
    expect(
      count(dir, "SELECT COUNT(*) AS n FROM context_cache WHERE tool_version = '1'"),
    ).toBe(chunkCount);
    expect(
      count(dir, "SELECT COUNT(*) AS n FROM context_cache WHERE tool_version = '2'"),
    ).toBe(chunkCount);
  });

  it("empty completion falls back to MetaContextualizer and the fallback is cached", async () => {
    const dir = tempDir();
    // by design the fallback is cached too: the model said nothing useful
    // once, so it is not asked again under the same version
    const { complete, state } = countingComplete((p) => p.includes("Subject: Invoice INV-102"));
    const dk = await openDocket(dir, new LlmContextualizer({ complete }));
    for (const e of fixtureEmails()) await dk.ingest.emlBytes(e);

    const target = rows<{
      chunk_id: string;
      blob_hash: string;
      chunk_index: number;
      source_kind: string;
      message_id: string;
      span_start: number;
      span_end: number;
      text: string;
      context: string;
      meta_json: string;
    }>(
      dir,
      "SELECT chunk_id, blob_hash, chunk_index, source_kind, message_id, span_start," +
        " span_end, text, context, meta_json FROM chunks WHERE message_id = ?",
      "ctx-2@cache.example",
    );
    expect(target.length).toBeGreaterThan(0);

    for (const row of target) {
      const draft: ChunkDraft = {
        blobHash: row.blob_hash,
        chunkIndex: row.chunk_index,
        sourceKind: row.source_kind as "message" | "attachment",
        messageId: row.message_id,
        span: { start: row.span_start, end: row.span_end },
        text: row.text,
        meta: JSON.parse(row.meta_json) as Record<string, string>,
      };
      const expected = await new MetaContextualizer().contextualize(draft);
      expect(row.context).toBe(expected);
      expect(row.context.length).toBeGreaterThan(0);
      const cached = rows<{ context: string }>(
        dir,
        "SELECT context FROM context_cache WHERE chunk_id = ?",
        row.chunk_id,
      );
      expect(cached).toEqual([{ context: expected }]);
    }

    // cached fallback: reindex asks the model for nothing, including the
    // chunk whose completion came back empty
    const callsBefore = state.calls;
    await dk.reindex();
    expect(state.calls).toBe(callsBefore);
  });

  it("tombstone purges the blob's context_cache rows and keeps the rest", async () => {
    const dir = tempDir();
    const { complete } = countingComplete();
    const dk = await openDocket(dir, new LlmContextualizer({ complete }));
    const results = [];
    for (const e of fixtureEmails()) results.push(await dk.ingest.emlBytes(e));

    const victim = results[1]!;
    const victimChunkIds = rows<{ chunk_id: string }>(
      dir,
      "SELECT chunk_id FROM chunks WHERE blob_hash = ?",
      victim.blobHash,
    ).map((r) => r.chunk_id);
    expect(victimChunkIds.length).toBeGreaterThan(0);
    const totalBefore = count(dir, "SELECT COUNT(*) AS n FROM context_cache");

    dk.store.tombstone(victim.blobHash, "test erasure");

    for (const id of victimChunkIds) {
      expect(count(dir, "SELECT COUNT(*) AS n FROM context_cache WHERE chunk_id = ?", id)).toBe(0);
    }
    expect(count(dir, "SELECT COUNT(*) AS n FROM context_cache")).toBe(
      totalBefore - victimChunkIds.length,
    );
  });

  it("replaced message (same Message-ID, new bytes) purges the old blob's cache rows", async () => {
    const dir = tempDir();
    const { complete } = countingComplete();
    const dk = await openDocket(dir, new LlmContextualizer({ complete }));

    const headers = {
      "Message-ID": "<swap@cache.example>",
      From: "Sender <sender@cache.example>",
      To: "ops@cache.example",
      Subject: "PO-777 revision",
      Date: "Tue, 5 Mar 2024 10:00:00 +0000",
    };
    const first = await dk.ingest.emlBytes(
      makeEml(headers, "Purchase order PO-777 quantity is 50 units at the March rate."),
    );
    const oldChunkIds = rows<{ chunk_id: string }>(
      dir,
      "SELECT chunk_id FROM chunks WHERE blob_hash = ?",
      first.blobHash,
    ).map((r) => r.chunk_id);
    expect(oldChunkIds.length).toBeGreaterThan(0);

    const second = await dk.ingest.emlBytes(
      makeEml(headers, "Purchase order PO-777 quantity is amended to 65 units, same rate."),
    );
    expect(second.blobHash).not.toBe(first.blobHash);
    expect(second.fresh).toBe(true);

    for (const id of oldChunkIds) {
      expect(count(dir, "SELECT COUNT(*) AS n FROM context_cache WHERE chunk_id = ?", id)).toBe(0);
    }
    const newCount = count(
      dir,
      "SELECT COUNT(*) AS n FROM context_cache cc JOIN chunks c ON c.chunk_id = cc.chunk_id" +
        " WHERE c.blob_hash = ?",
      second.blobHash,
    );
    expect(newCount).toBeGreaterThan(0);
  });

  it("default MetaContextualizer never touches context_cache", async () => {
    const dir = tempDir();
    const dk = await openDocket(dir);
    for (const e of fixtureEmails()) await dk.ingest.emlBytes(e);

    expect(count(dir, "SELECT COUNT(*) AS n FROM context_cache")).toBe(0);
    const contexts = rows<{ context: string }>(dir, "SELECT context FROM chunks");
    expect(contexts.length).toBeGreaterThan(0);
    for (const c of contexts) expect(c.context.length).toBeGreaterThan(0);
  });

  it("hybridSearch matches on cached LLM context content", async () => {
    const dir = tempDir();
    const { complete } = countingComplete();
    const dk = await openDocket(dir, new LlmContextualizer({ complete }));
    for (const e of fixtureEmails()) await dk.ingest.emlBytes(e);

    const hits = await dk.tools.hybridSearch({ query: "quaggamarsh" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.context).toContain("quaggamarsh");
  });
});
