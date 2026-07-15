/**
 * Stepped schema migrations (plan task 1.6). Runs against the committed
 * schema-version-1 fixture at tests/fixtures/db-v1/docket.db, produced by
 * scripts/make-v1-fixture.mjs. The fixture is never mutated in place: every
 * test copies it into a fresh temp directory first.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseCtor from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { Docket } from "../src/docket.js";
import { SCHEMA_VERSION } from "../src/schema.js";

const FIXTURE_DB = fileURLToPath(new URL("./fixtures/db-v1/docket.db", import.meta.url));
const EML = fileURLToPath(
  new URL("./fixtures/corpus-small/messages/MSG-000001.eml", import.meta.url),
);

const EXPECTED_TABLES = [
  "attachments",
  "audit_log",
  "blob_sources",
  "blobs",
  "chunks",
  "chunks_fts",
  "documents",
  "embeddings",
  "facts",
  "fragments",
  "ingest_errors",
  "message_recipients",
  "messages",
  "parties",
  "party_addresses",
  "threads",
];

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "docket-migrations-"));
  tempDirs.push(dir);
  return dir;
}

/** Copy the committed v1 fixture into a fresh dir and return that dir. */
function v1Copy(): string {
  const dir = tempDir();
  copyFileSync(FIXTURE_DB, join(dir, "docket.db"));
  return dir;
}

function schemaNames(dir: string, type: "table" | "index"): string[] {
  const db = new DatabaseCtor(join(dir, "docket.db"), { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(type) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

function rowCounts(dir: string, tables: string[]): Record<string, number> {
  const db = new DatabaseCtor(join(dir, "docket.db"), { readonly: true, fileMustExist: true });
  try {
    const out: Record<string, number> = {};
    for (const t of tables) {
      out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    }
    return out;
  } finally {
    db.close();
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("schema migrations", () => {
  it("fresh writer open lands on SCHEMA_VERSION with all tables present", () => {
    const dir = tempDir();
    const handle = openDb(dir);
    try {
      expect(handle.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      handle.db.close();
    }
    const tables = schemaNames(dir, "table");
    for (const t of EXPECTED_TABLES) {
      expect(tables, `table ${t} exists`).toContain(t);
    }
  });

  it("migrates the committed v1 fixture forward, preserving its rows", () => {
    const dir = v1Copy();
    const handle = openDb(dir);
    try {
      const db = handle.db;
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);

      // exact rows inserted by scripts/make-v1-fixture.mjs
      expect(db.prepare("SELECT * FROM parties").all()).toEqual([
        { party_id: "pty_acme", name: "Acme Corp", kind: "company", notes: "fixture party" },
      ]);
      expect(db.prepare("SELECT * FROM blobs").all()).toEqual([
        {
          hash: "a".repeat(64),
          size: 42,
          mime: "message/rfc822",
          created_at: "2025-06-01T00:00:00.000Z",
          tombstoned: 0,
        },
      ]);
      expect(db.prepare("SELECT * FROM messages").all()).toEqual([
        {
          message_id: "fixture-1@example.com",
          blob_hash: "a".repeat(64),
          thread_id: "thr_fixture",
          subject: "Fixture subject",
          from_name: "Fixture Sender",
          from_address: "sender@example.com",
          sent_at: "2025-06-01T00:00:00.000Z",
          in_reply_to: null,
          references_json: "[]",
          body_text: "Fixture body text.",
        },
      ]);
      expect(db.prepare("SELECT * FROM facts").all()).toEqual([
        {
          fact_id: 1,
          entity: "pty_acme",
          relation: "payment_terms",
          value_json: '"NET30"',
          valid_from: "2025-06-01",
          valid_to: null,
          created_at: "2025-06-01T00:00:00.000Z",
          expired_at: null,
          source_chunk: null,
          source_message: "fixture-1@example.com",
        },
      ]);
      expect(db.prepare("SELECT * FROM audit_log").all()).toEqual([
        {
          id: 1,
          at: "2025-06-01T00:00:00.000Z",
          action: "fixture",
          subject: "db-v1",
          detail: "created by make-v1-fixture",
        },
      ]);

      // the v2 step added the quarantine table, empty on arrival
      expect(db.prepare("SELECT COUNT(*) AS n FROM ingest_errors").get()).toEqual({ n: 0 });
    } finally {
      handle.db.close();
    }
  });

  it("migrated v1 schema equals a fresh v2 schema (tables and indexes)", () => {
    const freshDir = tempDir();
    const fresh = openDb(freshDir);
    fresh.db.close();

    const migratedDir = v1Copy();
    const migrated = openDb(migratedDir);
    migrated.db.close();

    expect(schemaNames(migratedDir, "table")).toEqual(schemaNames(freshDir, "table"));
    expect(schemaNames(migratedDir, "index")).toEqual(schemaNames(freshDir, "index"));
  });

  it("rejects a database newer than this build, in both writer and readonly opens", () => {
    const dir = v1Copy();
    const raw = new DatabaseCtor(join(dir, "docket.db"));
    raw.pragma("user_version = 99");
    raw.close();

    expect(() => openDb(dir)).toThrowError(
      `database schema version 99 is newer than this build (supports ${SCHEMA_VERSION})`,
    );
    expect(() => openDb(dir, { readonly: true })).toThrowError(/99/);
  });

  it("a migrated v1 database ingests and searches (FTS and triggers intact)", async () => {
    const dir = v1Copy();
    const dk = await Docket.open(dir);
    try {
      const result = await dk.ingest.emlFile(EML);
      expect(result.fresh).toBe(true);
      const hits = await dk.tools.hybridSearch({ query: "payment terms NET 30", k: 10 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.messageId === result.messageId)).toBe(true);
    } finally {
      dk.close();
    }
  });

  it("re-opening a migrated database is a no-op", () => {
    const dir = v1Copy();
    const first = openDb(dir);
    first.db.close();

    const tables = ["parties", "blobs", "messages", "facts", "audit_log", "ingest_errors"];
    const countsBefore = rowCounts(dir, tables);

    const second = openDb(dir);
    try {
      expect(second.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      second.db.close();
    }
    expect(rowCounts(dir, tables)).toEqual(countsBefore);
  });
});
