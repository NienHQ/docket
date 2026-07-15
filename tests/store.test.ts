import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DocketDb } from "../src/db.js";
import { DocumentsStore } from "../src/store/documents.js";
import { SqliteEvidenceStore, objectPath } from "../src/store/evidence.js";
import type { BlobMeta } from "../src/types.js";

const bytes = (s: string) => new TextEncoder().encode(s);

const msgMeta = (messageId: string): BlobMeta => ({
  mime: "message/rfc822",
  source: { kind: "message", messageId },
});

let dir: string;
let ddb: DocketDb;
let store: SqliteEvidenceStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docket-store-"));
  ddb = openDb(dir);
  store = new SqliteEvidenceStore(ddb);
});

afterEach(() => {
  ddb.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteEvidenceStore", () => {
  it("roundtrips put and get", () => {
    const data = bytes("hello evidence");
    const hash = store.putBlob(data, msgMeta("m1@example.com"));

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.hasBlob(hash)).toBe(true);
    expect(store.getBlob(hash)).toEqual(data);
    expect(existsSync(objectPath(ddb.objectsDir, hash))).toBe(true);
  });

  it("returns null and false for unknown hashes", () => {
    expect(store.getBlob("0".repeat(64))).toBeNull();
    expect(store.hasBlob("0".repeat(64))).toBe(false);
  });

  it("dedups identical bytes: one object, one blobs row, two sources", () => {
    const data = bytes("shared attachment body");
    const h1 = store.putBlob(data, msgMeta("a@example.com"));
    const h2 = store.putBlob(data, {
      mime: "application/pdf",
      source: { kind: "attachment", messageId: "b@example.com", attIndex: 0, filename: "x.pdf" },
    });

    expect(h1).toBe(h2);
    const blobCount = ddb.db
      .prepare("SELECT COUNT(*) AS n FROM blobs WHERE hash = ?")
      .get(h1) as { n: number };
    expect(blobCount.n).toBe(1);
    const srcCount = ddb.db
      .prepare("SELECT COUNT(*) AS n FROM blob_sources WHERE hash = ?")
      .get(h1) as { n: number };
    expect(srcCount.n).toBe(2);
  });

  it("is idempotent on exact re-put", () => {
    const data = bytes("same bytes same meta");
    const meta = msgMeta("dup@example.com");
    const h1 = store.putBlob(data, meta);
    const h2 = store.putBlob(data, meta);

    expect(h1).toBe(h2);
    const blobCount = ddb.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number };
    expect(blobCount.n).toBe(1);
    const srcCount = ddb.db
      .prepare("SELECT COUNT(*) AS n FROM blob_sources")
      .get() as { n: number };
    expect(srcCount.n).toBe(1);
    expect(store.getBlob(h1)).toEqual(data);
  });

  it("tombstone erases content, purges derived rows, and audits", () => {
    const data = bytes("to be erased for compliance");
    const hash = store.putBlob(data, msgMeta("erase@example.com"));

    const chunkId = `chk_${hash}_0`;
    ddb.db
      .prepare(
        `INSERT INTO chunks (chunk_id, blob_hash, chunk_index, source_kind, message_id, span_start, span_end, text)
         VALUES (?, ?, 0, 'message', 'erase@example.com', 0, 5, 'to be')`,
      )
      .run(chunkId, hash);
    ddb.db
      .prepare("INSERT INTO chunks_fts (chunk_id, context, text) VALUES (?, 'ctx', 'to be')")
      .run(chunkId);
    ddb.db
      .prepare("INSERT INTO embeddings (chunk_id, model, dim, vector) VALUES (?, 'm', 2, ?)")
      .run(chunkId, Buffer.from(new Float32Array([0.1, 0.2]).buffer));

    store.tombstone(hash, "gdpr erasure request 42");

    expect(store.getBlob(hash)).toBeNull();
    expect(store.hasBlob(hash)).toBe(false);
    expect(existsSync(objectPath(ddb.objectsDir, hash))).toBe(false);

    for (const table of ["chunks", "chunks_fts", "embeddings"]) {
      const n = ddb.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE chunk_id = ?`)
        .get(chunkId) as { n: number };
      expect(n.n, table).toBe(0);
    }

    const audit = ddb.db
      .prepare("SELECT action, subject, detail FROM audit_log WHERE subject = ?")
      .all(hash) as Array<{ action: string; subject: string; detail: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toEqual({
      action: "tombstone",
      subject: hash,
      detail: "gdpr erasure request 42",
    });
  });
});

describe("DocumentsStore", () => {
  it("stores documents and returns the chain ordered by version", () => {
    const docs = new DocumentsStore(ddb);
    const base = {
      kind: "lease",
      rootId: "doc-root",
      partyId: null,
      blobHash: null,
      issuedDate: null,
    };
    // insert out of order to prove chain() sorts by version
    docs.addDocument({ ...base, docId: "doc-v3", version: 3, supersedes: "doc-v2", fields: { rent: 1200 } });
    docs.addDocument({ ...base, docId: "doc-v1", version: 1, supersedes: null, fields: { rent: 1000 } });
    docs.addDocument({ ...base, docId: "doc-v2", version: 2, supersedes: "doc-v1", fields: { rent: 1100 } });

    const got = docs.get("doc-v2");
    expect(got).not.toBeNull();
    expect(got?.supersedes).toBe("doc-v1");
    expect(got?.fields).toEqual({ rent: 1100 });

    expect(docs.get("missing")).toBeNull();

    const chain = docs.chain("doc-root");
    expect(chain.map((d) => d.docId)).toEqual(["doc-v1", "doc-v2", "doc-v3"]);
    expect(chain.map((d) => d.version)).toEqual([1, 2, 3]);
  });
});
