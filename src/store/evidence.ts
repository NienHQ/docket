import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocketDb } from "../db.js";
import { nowIso } from "../db.js";
import type { BlobHash, BlobMeta, EvidenceStore } from "../types.js";

export function objectPath(objectsDir: string, hash: BlobHash): string {
  return join(objectsDir, hash.slice(0, 2), hash.slice(2));
}

export class SqliteEvidenceStore implements EvidenceStore {
  private readonly ddb: DocketDb;

  constructor(ddb: DocketDb) {
    this.ddb = ddb;
  }

  putBlob(bytes: Uint8Array, meta: BlobMeta): BlobHash {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const { db, objectsDir } = this.ddb;

    const row = db
      .prepare("SELECT hash FROM blobs WHERE hash = ?")
      .get(hash) as { hash: string } | undefined;

    const path = objectPath(objectsDir, hash);
    if (!existsSync(path)) {
      const dir = join(objectsDir, hash.slice(0, 2));
      mkdirSync(dir, { recursive: true });
      // temp file + rename keeps the object either absent or complete
      const tmp = join(dir, `.tmp-${hash.slice(2, 10)}-${randomBytes(6).toString("hex")}`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }

    const attIndex = meta.source.kind === "attachment" ? meta.source.attIndex : -1;
    const filename = meta.source.kind === "attachment" ? (meta.source.filename ?? null) : null;

    db.transaction(() => {
      if (!row) {
        db.prepare(
          "INSERT INTO blobs (hash, size, mime, created_at) VALUES (?, ?, ?, ?)",
        ).run(hash, bytes.byteLength, meta.mime, nowIso());
      }
      db.prepare(
        `INSERT INTO blob_sources (hash, kind, message_id, att_index, filename)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (hash, message_id, att_index) DO UPDATE SET
           kind = excluded.kind, filename = excluded.filename`,
      ).run(hash, meta.source.kind, meta.source.messageId, attIndex, filename);
    })();

    return hash;
  }

  getBlob(hash: BlobHash): Uint8Array | null {
    const row = this.ddb.db
      .prepare("SELECT tombstoned FROM blobs WHERE hash = ?")
      .get(hash) as { tombstoned: number } | undefined;
    if (!row || row.tombstoned !== 0) return null;
    return new Uint8Array(readFileSync(objectPath(this.ddb.objectsDir, hash)));
  }

  hasBlob(hash: BlobHash): boolean {
    const row = this.ddb.db
      .prepare("SELECT tombstoned FROM blobs WHERE hash = ?")
      .get(hash) as { tombstoned: number } | undefined;
    return row !== undefined && row.tombstoned === 0;
  }

  tombstone(hash: BlobHash, reason: string): void {
    const { db, objectsDir } = this.ddb;
    const row = db
      .prepare("SELECT hash FROM blobs WHERE hash = ?")
      .get(hash) as { hash: string } | undefined;
    if (!row) throw new Error(`tombstone: unknown blob ${hash}`);

    db.transaction(() => {
      db.prepare("UPDATE blobs SET tombstoned = 1 WHERE hash = ?").run(hash);
      // embeddings reference chunks, so purge them before the chunks rows
      db.prepare(
        "DELETE FROM embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE blob_hash = ?)",
      ).run(hash);
      db.prepare(
        "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE blob_hash = ?)",
      ).run(hash);
      db.prepare("DELETE FROM chunks WHERE blob_hash = ?").run(hash);
      // messages carry the blob's decoded content in body_text and fragments;
      // erasure must remove those too or getThread would leak the content
      db.prepare(
        `DELETE FROM fragments WHERE message_id IN
         (SELECT message_id FROM messages WHERE blob_hash = ?)`,
      ).run(hash);
      db.prepare(
        "UPDATE messages SET body_text = '' WHERE blob_hash = ?",
      ).run(hash);
      db.prepare(
        "INSERT INTO audit_log (at, action, subject, detail) VALUES (?, 'tombstone', ?, ?)",
      ).run(nowIso(), hash, reason);
    })();

    // filesystem work stays outside the transaction
    rmSync(objectPath(objectsDir, hash), { force: true });
  }
}
