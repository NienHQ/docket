/**
 * Concurrency contract tests (spec section 2): one writer, many readers.
 * WAL mode lets any number of readonly opens coexist with a single writer;
 * readers see committed writes on fresh queries, every write surface on a
 * readonly instance throws, and all connections carry a 5s busy_timeout.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import DatabaseCtor from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { Docket } from "../src/docket.js";
import { SCHEMA_VERSION } from "../src/schema.js";

const MESSAGES_DIR = fileURLToPath(
  new URL("./fixtures/corpus-small/messages", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const READONLY_MSG = /read-only/;
const QUERY = "payment terms";

describe("concurrency: one writer, many readers", () => {
  let base: string;
  let dir: string;
  let writer: Docket;
  let reader1: Docket;
  let reader2: Docket;
  let emlPaths: string[] = [];
  let allClosed = false;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "docket-concurrency-"));
    dir = join(base, "shared");
    emlPaths = readdirSync(MESSAGES_DIR)
      .filter((f) => f.endsWith(".eml"))
      .sort()
      .map((f) => join(MESSAGES_DIR, f));
    writer = await Docket.open(dir);
    for (const p of emlPaths.slice(0, 10)) {
      await writer.ingest.emlFile(p);
    }
  }, 60_000);

  afterAll(() => {
    if (!allClosed) {
      for (const inst of [reader1, reader2, writer]) {
        try {
          inst?.close();
        } catch {
          // already closed
        }
      }
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("two readers search alongside the writer and see committed writes", async () => {
    reader1 = await Docket.open(dir, { readonly: true });
    reader2 = await Docket.open(dir, { readonly: true });

    for (const r of [reader1, reader2]) {
      const hits = await r.tools.hybridSearch({ query: QUERY, k: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(r.tools.sqlFilter({ table: "messages", limit: 500 })).toHaveLength(10);
    }

    for (const p of emlPaths.slice(10, 15)) {
      await writer.ingest.emlFile(p);
    }
    const writerCount = writer.tools.sqlFilter({ table: "messages", limit: 500 }).length;
    expect(writerCount).toBe(15);

    // WAL snapshot semantics: each statement on a reader starts a fresh read
    // transaction, so a new query sees everything the writer committed.
    for (const r of [reader1, reader2]) {
      expect(r.tools.sqlFilter({ table: "messages", limit: 500 })).toHaveLength(writerCount);
      const hits = await r.tools.hybridSearch({ query: QUERY, k: 5 });
      expect(hits.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("every write surface on a readonly instance throws; reads keep working", async () => {
    const ro = reader1;
    const readsOk = () =>
      expect(ro.tools.sqlFilter({ table: "messages", limit: 500 })).toHaveLength(15);
    const firstEml = emlPaths[0];
    expect(firstEml).toBeDefined();
    const emlBytes = new Uint8Array(readFileSync(firstEml as string));

    // async-typed surfaces reject rather than throw synchronously
    await expect(ro.ingest.emlBytes(emlBytes)).rejects.toThrow(READONLY_MSG);
    readsOk();
    await expect(ro.ingest.dir(MESSAGES_DIR)).rejects.toThrow(READONLY_MSG);
    readsOk();
    await expect(ro.reindex()).rejects.toThrow(READONLY_MSG);
    readsOk();
    expect(() =>
      ro.facts.assert({
        entity: "party:acme",
        relation: "payment_terms",
        value: "NET30",
        validFrom: "2024-01-01",
        source: { messageId: "MSG-000001@kestrelfabrication.example" },
      }),
    ).toThrow(READONLY_MSG);
    readsOk();
    expect(() => ro.facts.backfill([])).toThrow(READONLY_MSG);
    readsOk();
    expect(() =>
      ro.entities.addParty({ partyId: "party:acme", name: "Acme", kind: "company" }),
    ).toThrow(READONLY_MSG);
    readsOk();
    expect(() =>
      ro.entities.mapAddress({ address: "ap@acme.example", partyId: "party:acme" }),
    ).toThrow(READONLY_MSG);
    readsOk();
    expect(() =>
      ro.store.putBlob(new Uint8Array([1, 2, 3]), {
        mime: "text/plain",
        source: { kind: "message", messageId: "m" },
      }),
    ).toThrow(READONLY_MSG);
    readsOk();
    expect(() => ro.store.tombstone("deadbeef", "test")).toThrow(READONLY_MSG);
    readsOk();

    const hits = await ro.tools.hybridSearch({ query: QUERY, k: 3 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("readonly open of a missing directory throws (fileMustExist)", async () => {
    await expect(
      Docket.open(join(base, "does-not-exist"), { readonly: true }),
    ).rejects.toThrow();
  });

  it("readonly open of an older schema version names found and required versions", async () => {
    const oldDir = join(base, "old-schema");
    const w = await Docket.open(oldDir);
    w.close();

    const raw = new DatabaseCtor(join(oldDir, "docket.db"));
    raw.pragma("user_version = 1");
    raw.close();

    await expect(Docket.open(oldDir, { readonly: true })).rejects.toThrow(
      new RegExp(`requires schema version ${SCHEMA_VERSION}, found 1`),
    );
    await expect(Docket.open(oldDir, { readonly: true })).rejects.toThrow(
      /open a writer once to migrate/,
    );
  });

  it("a child process opens the same dir readonly via dist and searches", async () => {
    // Build dist first: the child imports the built package entry point.
    const tscBin = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
    const build = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(build.status, `tsc build failed:\n${build.stdout}\n${build.stderr}`).toBe(0);

    const distIndex = pathToFileURL(join(REPO_ROOT, "dist", "index.js")).href;
    const script = [
      `import { Docket } from ${JSON.stringify(distIndex)};`,
      `const dk = await Docket.open(${JSON.stringify(dir)}, { readonly: true });`,
      `const hits = await dk.tools.hybridSearch({ query: ${JSON.stringify(QUERY)}, k: 5 });`,
      `dk.close();`,
      `process.stdout.write(JSON.stringify({ hits: hits.length }));`,
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(child.status, `child failed:\n${child.stderr}`).toBe(0);
    const out = JSON.parse(child.stdout) as { hits: number };

    // No embedder anywhere, so parent and child run the same deterministic
    // BM25 search and must agree; the parent's writer stays open throughout.
    const parentHits = await writer.tools.hybridSearch({ query: QUERY, k: 5 });
    expect(out.hits).toBe(parentHits.length);
    expect(out.hits).toBeGreaterThan(0);
    expect(writer.tools.sqlFilter({ table: "messages", limit: 500 })).toHaveLength(15);
  }, 180_000);

  it("openDb sets busy_timeout 5000 on reader and writer connections", () => {
    // reader connection against the shared dir (coexists with the writer)
    const ro = openDb(dir, { readonly: true });
    expect(ro.readonly).toBe(true);
    expect(ro.db.pragma("busy_timeout", { simple: true })).toBe(5000);
    ro.db.close();

    // writer connection against its own dir (two writers are unsupported)
    const rw = openDb(join(base, "busy-timeout"));
    expect(rw.readonly).toBe(false);
    expect(rw.db.pragma("busy_timeout", { simple: true })).toBe(5000);
    rw.db.close();
  });

  it("writer and both readers close cleanly", () => {
    expect(() => reader1.close()).not.toThrow();
    expect(() => reader2.close()).not.toThrow();
    expect(() => writer.close()).not.toThrow();
    allClosed = true;
  });
});
