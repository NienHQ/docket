/**
 * Malformed input tolerance (plan task 1.4): batch ingest never throws on bad
 * input. Unparseable, degenerate and oversize inputs are quarantined in
 * ingest_errors (raw bytes preserved in the CAS when possible), the batch
 * continues, and accounting holds: every input file becomes either an
 * IngestResult or a quarantine. The single-message emlBytes path throws for
 * the same three cases instead, because the caller handed us one specific
 * message.
 *
 * Dedupe rule (matches the implementation): at most one ingest_errors row per
 * (blob_hash, reason). Re-running a batch over identical bad bytes fires
 * onError again but does not grow the table. Oversize inputs carry a null
 * blob_hash (the bytes are never stored, never parsed) and are exempt from
 * dedupe.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";
import { MAX_INGEST_BYTES } from "../src/ingest/ingest.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/corpus-small/messages", import.meta.url));
const CLEAN_COUNT = 20;

const tempDirs: string[] = [];
const dockets: Docket[] = [];

// rmSync here also deletes the 65 MiB oversize file written by the size-cap
// test, so nothing large outlives a test run
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
  const dk = await Docket.open(tempDir("docket-quarantine-db-"));
  dockets.push(dk);
  return dk;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic byte stream (LCG); same bytes on every run, no headers. */
function garbageBytes(seed: number, length: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}

/** A real fixture with its Message-ID made unique, then cut at 60 percent. */
function truncatedEml(): Uint8Array {
  const raw = readFileSync(join(FIXTURES, "MSG-000046.eml"), "utf8");
  const patched = raw.replace(
    "<MSG-000046@meridianpackaging.example>",
    "<poison-truncated@quarantine.example>",
  );
  const bytes = new TextEncoder().encode(patched);
  return bytes.subarray(0, Math.floor(bytes.length * 0.6));
}

/** Valid headers, tiny body: a real message that must NOT be quarantined. */
function tinyBodyEml(): Uint8Array {
  const body = "x".repeat(100);
  return new TextEncoder().encode(
    [
      "Message-ID: <poison-tinybody@quarantine.example>",
      "From: Short Sender <short@quarantine.example>",
      "To: reader@quarantine.example",
      "Subject: Tiny but real",
      "Date: Mon, 04 Mar 2024 09:00:00 +0000",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      body,
    ].join("\r\n"),
  );
}

const ZERO_BYTES = new Uint8Array(0);
const GARBAGE = garbageBytes(42, 4096);

/**
 * Poisoned corpus: CLEAN_COUNT real fixtures plus four synthetic members.
 * Deterministic classification with the pinned postal-mime version:
 *   - truncated: headers survive the cut, parses, ingests as a message
 *   - tinybody: real message
 *   - zero byte and seeded garbage: parse to a headerless empty email,
 *     quarantined as degenerate
 */
function writePoisonedCorpus(): { root: string; fileCount: number } {
  const root = tempDir("docket-quarantine-eml-");
  const messages = join(root, "messages");
  mkdirSync(messages);
  const clean = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .slice(0, CLEAN_COUNT);
  for (const f of clean) {
    writeFileSync(join(messages, f), readFileSync(join(FIXTURES, f)));
  }
  writeFileSync(join(messages, "zz-truncated.eml"), truncatedEml());
  writeFileSync(join(messages, "zz-tinybody.eml"), tinyBodyEml());
  writeFileSync(join(messages, "zz-zero.eml"), ZERO_BYTES);
  writeFileSync(join(messages, "zz-garbage.eml"), GARBAGE);
  return { root, fileCount: clean.length + 4 };
}

function errorRows(dk: Docket): Array<Record<string, unknown>> {
  return dk.tools.sqlFilter({ table: "ingest_errors", limit: 500 });
}

function messageIds(dk: Docket): Set<string> {
  const rows = dk.tools.sqlFilter({ table: "messages", limit: 500 }) as Array<{
    message_id: string;
  }>;
  return new Set(rows.map((r) => r.message_id));
}

describe("quarantine (malformed input tolerance)", () => {
  it("dir() over a poisoned corpus completes with full accounting", async () => {
    const { root, fileCount } = writePoisonedCorpus();
    const dk = await openDocket();

    const results = await dk.ingest.dir(root, { batchSize: 7 });
    const errors = errorRows(dk);

    // every input file is accounted for exactly once
    expect(results.length + errors.length).toBe(fileCount);
    expect(results).toHaveLength(CLEAN_COUNT + 2); // clean + truncated + tinybody
    expect(errors).toHaveLength(2); // zero byte + garbage
    expect(results.every((r) => r.fresh)).toBe(true);

    const ids = messageIds(dk);
    expect(ids.size).toBe(CLEAN_COUNT + 2);
    expect(ids.has("poison-truncated@quarantine.example")).toBe(true);
    expect(ids.has("poison-tinybody@quarantine.example")).toBe(true);
    // every clean fixture landed under its own Message-ID
    for (let n = 1; n <= CLEAN_COUNT; n++) {
      const id = `MSG-${String(n).padStart(6, "0")}@`;
      expect([...ids].some((i) => i.startsWith(id))).toBe(true);
    }
  });

  it("quarantines a zero-byte file as degenerate with the evidence in the CAS", async () => {
    const { root } = writePoisonedCorpus();
    const dk = await openDocket();
    await dk.ingest.dir(root);

    const hash = sha256Hex(ZERO_BYTES);
    const rows = errorRows(dk).filter((r) => r["blob_hash"] === hash);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["reason"]).toBe("degenerate");
    expect(typeof rows[0]!["at"]).toBe("string");

    // no messages row, but the raw bytes are preserved
    expect(messageIds(dk).has(`synth-${hash}`)).toBe(false);
    expect(dk.store.hasBlob(hash)).toBe(true);
    expect(dk.store.getBlob(hash)!.byteLength).toBe(0);
  });

  it("quarantines seeded binary garbage as degenerate, not a message", async () => {
    const { root } = writePoisonedCorpus();
    const dk = await openDocket();
    await dk.ingest.dir(root);

    const hash = sha256Hex(GARBAGE);
    const rows = errorRows(dk).filter((r) => r["blob_hash"] === hash);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["reason"]).toBe("degenerate");

    expect(messageIds(dk).has(`synth-${hash}`)).toBe(false);
    expect(dk.store.getBlob(hash)).toEqual(GARBAGE);
  });

  it("does not quarantine a message with valid headers and a 100-byte body", async () => {
    const { root } = writePoisonedCorpus();
    const dk = await openDocket();
    await dk.ingest.dir(root);

    expect(messageIds(dk).has("poison-tinybody@quarantine.example")).toBe(true);
    const hash = sha256Hex(tinyBodyEml());
    expect(errorRows(dk).some((r) => r["blob_hash"] === hash)).toBe(false);
  });

  it("fires onError once per quarantine with the right reason", async () => {
    const { root } = writePoisonedCorpus();
    const dk = await openDocket();

    const seen: Array<{ blobHash: string | null; reason: string }> = [];
    await dk.ingest.dir(root, {
      onError: (e) => seen.push({ blobHash: e.blobHash, reason: e.reason }),
    });

    expect(seen).toHaveLength(2);
    const byHash = new Map(seen.map((e) => [e.blobHash, e.reason]));
    expect(byHash.get(sha256Hex(ZERO_BYTES))).toBe("degenerate");
    expect(byHash.get(sha256Hex(GARBAGE))).toBe("degenerate");
  });

  it("re-running dir() does not duplicate ingest_errors rows for identical bytes", async () => {
    const { root, fileCount } = writePoisonedCorpus();
    const dk = await openDocket();

    await dk.ingest.dir(root);
    const first = errorRows(dk);
    expect(first).toHaveLength(2);

    const seen: string[] = [];
    const results = await dk.ingest.dir(root, { onError: (e) => seen.push(e.reason) });

    // rows deduped by (blob_hash, reason); onError still reports each event
    expect(errorRows(dk)).toHaveLength(first.length);
    expect(seen).toHaveLength(2);
    expect(results.length + seen.length).toBe(fileCount);
    expect(results.every((r) => r.fresh === false)).toBe(true);
  });

  it("quarantines an oversize input in batch mode and stores nothing", async () => {
    // 65 MiB of zeros, comfortably over the 64 MiB cap
    const big = Buffer.alloc(65 * 1024 * 1024);
    expect(big.byteLength).toBeGreaterThan(MAX_INGEST_BYTES);

    const root = tempDir("docket-quarantine-big-");
    writeFileSync(join(root, "big.eml"), big);

    const dk = await openDocket();
    const seen: Array<{ blobHash: string | null; reason: string; detail: string }> = [];
    const results = await dk.ingest.dir(root, { onError: (e) => seen.push(e) });

    expect(results).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe("oversize");
    expect(seen[0]!.blobHash).toBeNull();
    expect(seen[0]!.detail).toContain(String(big.byteLength));

    const rows = errorRows(dk);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["reason"]).toBe("oversize");
    expect(rows[0]!["blob_hash"]).toBeNull();
    // nothing was stored: no blobs, no messages
    expect(dk.tools.sqlFilter({ table: "messages" })).toHaveLength(0);
    expect(dk.store.hasBlob(sha256Hex(big))).toBe(false);
    // dedupe is keyed on blob_hash, which is null here, so re-runs may add
    // rows for oversize inputs; that is accepted and not asserted against
  });

  it("emlBytes throws on oversize and degenerate input (single-message contract)", async () => {
    const dk = await openDocket();

    const big = Buffer.alloc(65 * 1024 * 1024);
    await expect(dk.ingest.emlBytes(big)).rejects.toThrow(/ingest cap/);

    await expect(dk.ingest.emlBytes(ZERO_BYTES)).rejects.toThrow(/degenerate/);
    await expect(dk.ingest.emlBytes(GARBAGE)).rejects.toThrow(/degenerate/);

    // and no quarantine rows: throwing paths do not write to ingest_errors
    expect(errorRows(dk)).toHaveLength(0);
  });
});
