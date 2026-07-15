import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocketDb } from "../db.js";
import { nowIso } from "../db.js";
import type {
  AttachmentParser,
  BlobHash,
  ChunkDraft,
  ChunkId,
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

/**
 * The one place chunk ids are minted (spec invariant 3: stable across
 * reindex). Message chunks: chk_<blob>_<n>. Attachment chunks are scoped per
 * message because attachment blobs are deduplicated: chk_<blob>_m<hash12>_<n>
 * where hash12 is the first 12 hex chars of sha256(messageId).
 */
function chunkIdFor(
  blobHash: BlobHash,
  chunkIndex: number,
  scopeMessageId?: MessageId,
): ChunkId {
  const suffix =
    scopeMessageId === undefined
      ? ""
      : `m${createHash("sha256").update(scopeMessageId).digest("hex").slice(0, 12)}_`;
  return `chk_${blobHash}_${suffix}${chunkIndex}`;
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
    dedupe?: boolean;
    expand?: "thread" | "none";
  }): Promise<SearchHit[]> {
    return hybridSearch(this.dbh, this.embedder, q);
  }

  /**
   * Fill missing embeddings for the configured embedder's model from stored
   * chunks, without re-chunking. Input composition matches writeChunks
   * (context + "\n" + text) so reembedded vectors equal ingest-time vectors.
   * Returns the number of chunks embedded.
   *
   * Schema note: embeddings keys chunk_id as its sole PRIMARY KEY, so a chunk
   * holds one vector total, not one per model. Switching models therefore
   * REPLACES the previous model's row for each chunk (search filters by
   * model, so replaced rows simply stop matching the old model). True
   * multi-model coexistence needs a PK of (chunk_id, model), a schema
   * migration out of scope here.
   */
  async reembedAll(): Promise<number> {
    const embedder = this.embedder;
    if (!embedder) {
      throw new Error(
        "docket: reembed requires an embedder; open the directory with DocketOptions.embedder set",
      );
    }

    const db = this.dbh.db;
    const rows = db
      .prepare(
        "SELECT c.chunk_id, c.context, c.text FROM chunks c" +
          " WHERE NOT EXISTS (SELECT 1 FROM embeddings e" +
          " WHERE e.chunk_id = c.chunk_id AND e.model = ?)" +
          " ORDER BY c.chunk_id",
      )
      .all(embedder.model) as Array<{ chunk_id: string; context: string; text: string }>;
    if (rows.length === 0) return 0;

    // PK is (chunk_id, model) since schema v4: models coexist side by side
    const insEmb = db.prepare(
      "INSERT OR IGNORE INTO embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?)",
    );
    const insertBatch = db.transaction(
      (batch: typeof rows, vectors: Float32Array[]) => {
        batch.forEach((row, i) => {
          const vec = vectors[i];
          if (!vec) throw new Error(`embedder returned no vector for ${row.chunk_id}`);
          insEmb.run(
            row.chunk_id,
            embedder.model,
            embedder.dim,
            Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
          );
        });
      },
    );

    const BATCH = 64;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      // await outside the transaction: better-sqlite3 transactions are sync
      const vectors = await embedder.embed(
        batch.map((r) => r.context + "\n" + r.text),
      );
      insertBatch(batch, vectors);
    }
    return rows.length;
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
    const db = this.dbh.db;
    // final ids, computed up front: the context cache below is keyed by the
    // exact chunk id the insert loop will use (same helper, cannot drift)
    const chunkIds = drafts.map((d) => chunkIdFor(d.blobHash, d.chunkIndex, scopeMessageId));

    const ctxTool = this.contextualizer;
    const contexts: string[] = [];
    if (ctxTool.cacheable === true) {
      // expensive contextualizer: consult context_cache keyed
      // (chunk id, tool, version) so reindex never re-pays the cost
      const getCtx = db.prepare(
        "SELECT context FROM context_cache WHERE chunk_id = ? AND tool = ? AND tool_version = ?",
      );
      const insCtx = db.prepare(
        "INSERT OR IGNORE INTO context_cache (chunk_id, tool, tool_version, context, created_at)" +
          " VALUES (?,?,?,?,?)",
      );
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i]!;
        const chunkId = chunkIds[i]!;
        const cached = getCtx.get(chunkId, ctxTool.tool, ctxTool.version) as
          | { context: string }
          | undefined;
        if (cached) {
          contexts.push(cached.context);
          continue;
        }
        const context = await ctxTool.contextualize(d);
        insCtx.run(chunkId, ctxTool.tool, ctxTool.version, context, nowIso());
        contexts.push(context);
      }
    } else {
      // cheap deterministic contextualizer: no cache table involvement
      for (const d of drafts) contexts.push(await ctxTool.contextualize(d));
    }

    let vectors: Float32Array[] = [];
    if (this.embedder && drafts.length > 0) {
      vectors = await this.embedder.embed(
        drafts.map((d, i) => (contexts[i] ?? "") + "\n" + d.text),
      );
    }

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

    db.transaction(() => {
      db.prepare(
        `DELETE FROM embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE ${scopeSql})`,
      ).run(...scopeArgs);
      db.prepare(
        `DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE ${scopeSql})`,
      ).run(...scopeArgs);
      db.prepare(`DELETE FROM chunks WHERE ${scopeSql}`).run(...scopeArgs);

      drafts.forEach((d, i) => {
        const chunkId = chunkIds[i]!;
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
