import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DocketDb } from "../db.js";
import type {
  BatchOptions,
  BlobHash,
  EvidenceStore,
  Ingestor,
  IngestResult,
  MessageId,
} from "../types.js";
import type { ParsedEmail } from "./eml.js";
import { parseEml } from "./eml.js";
import { rethreadAll, rethreadIncremental } from "./jwz.js";
import { splitMbox } from "./mbox.js";
import { stripFragments } from "./strip.js";

interface InsertOutcome {
  messageId: MessageId;
  blobHash: BlobHash;
  attachments: number;
  fresh: boolean;
}

function collectEmlFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".eml")) out.push(p);
    }
  }
  return out.sort();
}

export class SqliteIngestor implements Ingestor {
  constructor(
    private readonly dk: DocketDb,
    private readonly store: EvidenceStore,
  ) {}

  async emlBytes(bytes: Uint8Array): Promise<IngestResult> {
    const out = await this.insertOne(bytes);
    if (out.fresh) rethreadIncremental(this.dk.db, out.messageId);
    return this.finalize(out);
  }

  async emlFile(path: string): Promise<IngestResult> {
    return this.emlBytes(new Uint8Array(readFileSync(path)));
  }

  async mboxFile(path: string, opts?: BatchOptions): Promise<IngestResult[]> {
    return this.insertMany(splitMbox(new Uint8Array(readFileSync(path))), opts);
  }

  async dir(path: string, opts?: BatchOptions): Promise<IngestResult[]> {
    const parts = collectEmlFiles(path).map((f) => new Uint8Array(readFileSync(f)));
    return this.insertMany(parts, opts);
  }

  /** Recompute every thread assignment from headers stored in the database. */
  rethreadAll(): void {
    rethreadAll(this.dk.db);
  }

  /** Rebuild fragments for every message from body_text (reindex path). */
  restripAll(): void {
    const db = this.dk.db;
    const rows = db
      .prepare("SELECT message_id, body_text FROM messages ORDER BY message_id")
      .all() as Array<{ message_id: string; body_text: string }>;
    const insFragment = db.prepare(
      "INSERT INTO fragments (fragment_id, message_id, kind, span_start, span_end, text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
      db.prepare("DELETE FROM fragments").run();
      for (const row of rows) {
        for (const f of stripFragments(row.body_text, row.message_id)) {
          insFragment.run(f.fragmentId, row.message_id, f.kind, f.span.start, f.span.end, f.text);
        }
      }
    })();
  }

  /**
   * Batched bulk path: parse (async) happens outside the transaction, then a
   * single write transaction per batch covers every per-message DB write.
   * putBlob's own transaction becomes a savepoint inside the batch, so blob
   * rows and message rows commit together.
   */
  private async insertMany(parts: Uint8Array[], opts?: BatchOptions): Promise<IngestResult[]> {
    const batchSize = Math.max(1, opts?.batchSize ?? 500);
    const total = parts.length;
    const outs: InsertOutcome[] = [];

    const writeBatch = this.dk.db.transaction(
      (batch: Array<{ bytes: Uint8Array; parsed: ParsedEmail }>): InsertOutcome[] => {
        const res: InsertOutcome[] = [];
        for (const item of batch) res.push(this.insertParsed(item.bytes, item.parsed));
        return res;
      },
    );

    for (let offset = 0; offset < total; offset += batchSize) {
      const slice = parts.slice(offset, offset + batchSize);
      const batch: Array<{ bytes: Uint8Array; parsed: ParsedEmail }> = [];
      for (const bytes of slice) {
        try {
          batch.push({ bytes, parsed: await parseEml(bytes) });
        } catch {
          // unparseable input must not sink the batch; task 1.4 adds a
          // quarantine table so these get recorded instead of skipped
        }
      }
      outs.push(...writeBatch(batch));
      opts?.onProgress?.(Math.min(offset + slice.length, total), total);
    }

    if (outs.some((o) => o.fresh)) this.rethreadAll();
    return outs.map((o) => this.finalize(o));
  }

  private async insertOne(bytes: Uint8Array): Promise<InsertOutcome> {
    return this.insertParsed(bytes, await parseEml(bytes));
  }

  /** Synchronous tail of ingestion: everything after MIME parsing. */
  private insertParsed(bytes: Uint8Array, parsed: ParsedEmail): InsertOutcome {
    const db = this.dk.db;
    const blobHash = this.store.putBlob(bytes, {
      mime: "message/rfc822",
      source: { kind: "message", messageId: parsed.messageId },
    });

    const existing = db
      .prepare("SELECT blob_hash FROM messages WHERE message_id = ?")
      .get(parsed.messageId) as { blob_hash: string } | undefined;
    if (existing && existing.blob_hash === blobHash) {
      const att = db
        .prepare("SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?")
        .get(parsed.messageId) as { n: number };
      return { messageId: parsed.messageId, blobHash, attachments: att.n, fresh: false };
    }
    if (existing) {
      // same Message-ID, different bytes: the old blob's index rows would
      // otherwise stay searchable as live evidence
      this.purgeIndexForBlob(existing.blob_hash);
      db.prepare(
        "DELETE FROM blob_sources WHERE message_id = ? AND hash = ?",
      ).run(parsed.messageId, existing.blob_hash);
    }

    const atts = parsed.attachments.map((a, i) => ({
      ...a,
      index: i,
      hash: this.store.putBlob(a.bytes, {
        mime: a.mime,
        source: {
          kind: "attachment",
          messageId: parsed.messageId,
          attIndex: i,
          ...(a.filename !== "" ? { filename: a.filename } : {}),
        },
      }),
    }));
    const fragments = stripFragments(parsed.bodyText, parsed.messageId);

    db.transaction(() => {
      db.prepare(
        `INSERT INTO messages
           (message_id, blob_hash, subject, from_name, from_address, sent_at, in_reply_to, references_json, body_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           blob_hash = excluded.blob_hash,
           subject = excluded.subject,
           from_name = excluded.from_name,
           from_address = excluded.from_address,
           sent_at = excluded.sent_at,
           in_reply_to = excluded.in_reply_to,
           references_json = excluded.references_json,
           body_text = excluded.body_text`,
      ).run(
        parsed.messageId,
        blobHash,
        parsed.subject,
        parsed.fromName,
        parsed.fromAddress,
        parsed.sentAt,
        parsed.inReplyTo,
        JSON.stringify(parsed.references),
        parsed.bodyText,
      );

      db.prepare("DELETE FROM message_recipients WHERE message_id = ?").run(parsed.messageId);
      db.prepare("DELETE FROM attachments WHERE message_id = ?").run(parsed.messageId);
      db.prepare("DELETE FROM fragments WHERE message_id = ?").run(parsed.messageId);

      const insRecipient = db.prepare(
        "INSERT OR IGNORE INTO message_recipients (message_id, name, address, kind) VALUES (?, ?, ?, ?)",
      );
      for (const r of parsed.recipients) {
        insRecipient.run(parsed.messageId, r.name, r.address, r.kind);
      }

      const insAttachment = db.prepare(
        "INSERT INTO attachments (message_id, att_index, filename, mime, blob_hash) VALUES (?, ?, ?, ?, ?)",
      );
      for (const a of atts) {
        insAttachment.run(parsed.messageId, a.index, a.filename, a.mime, a.hash);
      }

      const insFragment = db.prepare(
        "INSERT INTO fragments (fragment_id, message_id, kind, span_start, span_end, text) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const f of fragments) {
        insFragment.run(f.fragmentId, parsed.messageId, f.kind, f.span.start, f.span.end, f.text);
      }
    })();

    return { messageId: parsed.messageId, blobHash, attachments: atts.length, fresh: true };
  }

  private purgeIndexForBlob(blobHash: string): void {
    const db = this.dk.db;
    db.prepare(
      "DELETE FROM embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE blob_hash = ?)",
    ).run(blobHash);
    db.prepare(
      "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE blob_hash = ?)",
    ).run(blobHash);
    db.prepare("DELETE FROM chunks WHERE blob_hash = ?").run(blobHash);
  }

  private finalize(out: InsertOutcome): IngestResult {
    const row = this.dk.db
      .prepare("SELECT thread_id FROM messages WHERE message_id = ?")
      .get(out.messageId) as { thread_id: string | null } | undefined;
    return {
      messageId: out.messageId,
      threadId: row?.thread_id ?? "",
      blobHash: out.blobHash,
      attachments: out.attachments,
      fresh: out.fresh,
    };
  }
}
