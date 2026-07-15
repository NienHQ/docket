import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocketDb } from "../db.js";
import { nowIso } from "../db.js";
import type {
  AttachmentParser,
  BlobHash,
  ChunkDraft,
  Contextualizer,
  Embedder,
  Indexer,
  MessageId,
  SearchFilter,
  SearchHit,
} from "../types.js";
import { chunkSpans } from "./chunk.js";
import { MetaContextualizer } from "./context.js";
import { hybridSearch } from "./search.js";

interface MessageRow {
  message_id: string;
  blob_hash: string;
  subject: string;
  from_name: string;
  from_address: string;
  sent_at: string | null;
  body_text: string;
}

interface AttachmentRow {
  filename: string;
  mime: string;
  blob_hash: string;
}

interface FragmentRow {
  span_start: number;
  span_end: number;
}

export interface SqliteIndexerOptions {
  embedder?: Embedder;
  contextualizer?: Contextualizer;
  parsers?: AttachmentParser[];
}

export class SqliteIndexer implements Indexer {
  private readonly dbh: DocketDb;
  private readonly contextualizer: Contextualizer;
  private readonly embedder: Embedder | undefined;
  private readonly parsers: AttachmentParser[];

  constructor(dbh: DocketDb, options?: SqliteIndexerOptions) {
    this.dbh = dbh;
    this.contextualizer = options?.contextualizer ?? new MetaContextualizer();
    this.embedder = options?.embedder;
    this.parsers = options?.parsers ?? [];
  }

  private getMessage(messageId: MessageId): MessageRow {
    const row = this.dbh.db
      .prepare(
        "SELECT message_id, blob_hash, subject, from_name, from_address, sent_at, body_text" +
          " FROM messages WHERE message_id = ?",
      )
      .get(messageId) as MessageRow | undefined;
    if (!row) throw new Error(`unknown message: ${messageId}`);
    return row;
  }

  private recipientAddresses(messageId: MessageId): string[] {
    const rows = this.dbh.db
      .prepare(
        "SELECT address FROM message_recipients WHERE message_id = ?" +
          " ORDER BY CASE kind WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END, address",
      )
      .all(messageId) as Array<{ address: string }>;
    return rows.map((r) => r.address);
  }

  async indexMessage(messageId: MessageId): Promise<void> {
    const msg = this.getMessage(messageId);
    const fragments = this.dbh.db
      .prepare(
        "SELECT span_start, span_end FROM fragments" +
          " WHERE message_id = ? AND kind = 'new' ORDER BY span_start",
      )
      .all(messageId) as FragmentRow[];

    const meta: Record<string, string> = {
      from: [msg.from_name, msg.from_address].filter((s) => s.length > 0).join(" "),
      to: this.recipientAddresses(messageId).join(", "),
      date: msg.sent_at ?? "",
      subject: msg.subject,
    };

    const drafts: ChunkDraft[] = [];
    for (const f of fragments) {
      // chunk the body slice itself so chunk text always equals body_text.slice(start, end)
      const fragText = msg.body_text.slice(f.span_start, f.span_end);
      for (const s of chunkSpans(fragText)) {
        const start = f.span_start + s.start;
        const end = f.span_start + s.end;
        drafts.push({
          blobHash: msg.blob_hash,
          chunkIndex: 0,
          sourceKind: "message",
          messageId,
          span: { start, end },
          text: msg.body_text.slice(start, end),
          meta,
        });
      }
    }
    drafts.sort((a, b) => a.span.start - b.span.start);
    drafts.forEach((d, i) => {
      d.chunkIndex = i;
    });
    await this.writeChunks(msg.blob_hash, drafts);
  }

  async indexAttachment(messageId: MessageId, attIndex: number): Promise<void> {
    const att = this.dbh.db
      .prepare(
        "SELECT filename, mime, blob_hash FROM attachments" +
          " WHERE message_id = ? AND att_index = ?",
      )
      .get(messageId, attIndex) as AttachmentRow | undefined;
    if (!att) throw new Error(`unknown attachment: ${messageId} #${attIndex}`);

    let text: string;
    let parserMeta: Record<string, string> = {};
    if (att.mime.startsWith("text/")) {
      const blobRow = this.dbh.db
        .prepare("SELECT tombstoned FROM blobs WHERE hash = ?")
        .get(att.blob_hash) as { tombstoned: number } | undefined;
      if (!blobRow || blobRow.tombstoned !== 0) return; // erased content stays erased

      const path = join(this.dbh.objectsDir, att.blob_hash.slice(0, 2), att.blob_hash.slice(2));
      if (!existsSync(path)) return;
      text = new TextDecoder("utf-8").decode(readFileSync(path));
    } else {
      const parser = this.parsers.find((p) => p.mimes.includes(att.mime));
      if (!parser) return; // unhandled mime stays unindexed
      const parsed = await this.parsedAttachmentText(att.blob_hash, parser);
      // null: tombstoned, missing, or parse failure; empty: no text layer
      if (parsed === null || parsed.trim().length === 0) return;
      text = parsed;
      parserMeta = { parser: parser.tool, parserVersion: parser.version };
    }

    const msg = this.getMessage(messageId);
    const meta: Record<string, string> = {
      filename: att.filename,
      subject: msg.subject,
      from: msg.from_address,
      date: msg.sent_at ?? "",
      ...parserMeta,
    };

    const drafts: ChunkDraft[] = chunkSpans(text).map((s, i) => ({
      blobHash: att.blob_hash,
      chunkIndex: i,
      sourceKind: "attachment",
      messageId,
      span: s,
      text: text.slice(s.start, s.end),
      meta,
    }));
    // attachment blobs can be shared by N messages (dedup), so chunk rows are
    // scoped per (blob, message) or the last indexed message would clobber the
    // attribution and filters of the others
    await this.writeChunks(att.blob_hash, drafts, messageId);
  }

  /**
   * Derived text for a non-text attachment, via parse_cache (spec 3.3). The
   * cache is keyed (blob hash, tool, tool version): reindex reuses it and a
   * parser version bump invalidates it. Empty text (no text layer) is cached
   * too so the blob is never re-parsed. A parser throw caches nothing: the
   * blob stays eligible for retry under a fixed parser version.
   */
  private async parsedAttachmentText(
    blobHash: BlobHash,
    parser: AttachmentParser,
  ): Promise<string | null> {
    const db = this.dbh.db;
    const cached = db
      .prepare(
        "SELECT text FROM parse_cache WHERE blob_hash = ? AND tool = ? AND tool_version = ?",
      )
      .get(blobHash, parser.tool, parser.version) as { text: string } | undefined;
    if (cached) return cached.text;

    const blobRow = db
      .prepare("SELECT tombstoned FROM blobs WHERE hash = ?")
      .get(blobHash) as { tombstoned: number } | undefined;
    if (!blobRow || blobRow.tombstoned !== 0) return null; // erased content stays erased
    const path = join(this.dbh.objectsDir, blobHash.slice(0, 2), blobHash.slice(2));
    if (!existsSync(path)) return null;

    let parsed: { text: string; meta?: Record<string, string> };
    try {
      parsed = await parser.parse(new Uint8Array(readFileSync(path)));
    } catch {
      return null;
    }
    db.prepare(
      "INSERT OR IGNORE INTO parse_cache (blob_hash, tool, tool_version, text, meta_json, created_at)" +
        " VALUES (?,?,?,?,?,?)",
    ).run(blobHash, parser.tool, parser.version, parsed.text, JSON.stringify(parsed.meta ?? {}), nowIso());
    return parsed.text;
  }

  hybridSearch(q: {
    query: string;
    k?: number;
    filter?: SearchFilter;
  }): Promise<SearchHit[]> {
    return hybridSearch(this.dbh, this.embedder, q);
  }

  /**
   * Delete-then-insert keeps reindexing idempotent (spec invariant 3). Scope
   * is the blob for message chunks (an RFC822 blob belongs to one message)
   * and (blob, message) for attachment chunks (blobs are deduplicated).
   */
  private async writeChunks(
    blobHash: BlobHash,
    drafts: ChunkDraft[],
    scopeMessageId?: MessageId,
  ): Promise<void> {
    const contexts: string[] = [];
    for (const d of drafts) contexts.push(await this.contextualizer.contextualize(d));

    let vectors: Float32Array[] = [];
    if (this.embedder && drafts.length > 0) {
      vectors = await this.embedder.embed(
        drafts.map((d, i) => (contexts[i] ?? "") + "\n" + d.text),
      );
    }

    const db = this.dbh.db;
    const insChunk = db.prepare(
      "INSERT INTO chunks (chunk_id, blob_hash, chunk_index, source_kind, message_id," +
        " span_start, span_end, text, context, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    const insFts = db.prepare(
      "INSERT INTO chunks_fts (chunk_id, context, text) VALUES (?,?,?)",
    );
    const insEmb = db.prepare(
      "INSERT INTO embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?)",
    );
    const embedder = this.embedder;

    const scopeSql = scopeMessageId === undefined
      ? "blob_hash = ?"
      : "blob_hash = ? AND message_id = ?";
    const scopeArgs: string[] = scopeMessageId === undefined
      ? [blobHash]
      : [blobHash, scopeMessageId];
    const idSuffix = scopeMessageId === undefined
      ? ""
      : `m${createHash("sha256").update(scopeMessageId).digest("hex").slice(0, 12)}_`;

    db.transaction(() => {
      db.prepare(
        `DELETE FROM embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE ${scopeSql})`,
      ).run(...scopeArgs);
      db.prepare(
        `DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE ${scopeSql})`,
      ).run(...scopeArgs);
      db.prepare(`DELETE FROM chunks WHERE ${scopeSql}`).run(...scopeArgs);

      drafts.forEach((d, i) => {
        const chunkId = `chk_${d.blobHash}_${idSuffix}${d.chunkIndex}`;
        const context = contexts[i] ?? "";
        insChunk.run(
          chunkId,
          d.blobHash,
          d.chunkIndex,
          d.sourceKind,
          d.messageId ?? null,
          d.span.start,
          d.span.end,
          d.text,
          context,
          JSON.stringify(d.meta),
        );
        insFts.run(chunkId, context, d.text);
        const vec = vectors[i];
        if (embedder && vec) {
          insEmb.run(
            chunkId,
            embedder.model,
            embedder.dim,
            Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
          );
        }
      });
    })();
  }
}
