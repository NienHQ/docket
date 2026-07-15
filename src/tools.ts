import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DocketDb } from "./db.js";
import type {
  Entities,
  Indexer,
  PartySuggestion,
  SearchFilter,
  SearchHit,
  SourceView,
  SqlFilterQuery,
  ThreadView,
  TimelineEntry,
  Tools,
} from "./types.js";

/** Columns exposed per table; sqlFilter never sees raw SQL from callers. */
const TABLE_COLUMNS: Record<SqlFilterQuery["table"], string[]> = {
  messages: [
    "message_id", "thread_id", "subject", "from_name", "from_address",
    "sent_at", "blob_hash",
  ],
  threads: ["thread_id", "subject", "first_at", "last_at"],
  documents: [
    "doc_id", "kind", "root_id", "version", "supersedes", "party_id",
    "issued_date", "fields_json",
  ],
  facts: [
    "fact_id", "entity", "relation", "value_json", "valid_from", "valid_to",
    "created_at", "expired_at", "source_chunk", "source_message",
  ],
  attachments: ["message_id", "att_index", "filename", "mime", "blob_hash"],
  parties: ["party_id", "name", "kind"],
  ingest_errors: ["id", "at", "blob_hash", "reason", "detail"],
};

const OPS = new Set(["=", "!=", "<", "<=", ">", ">=", "like"]);

export class SqliteTools implements Tools {
  constructor(
    private readonly dbx: DocketDb,
    private readonly indexer: Indexer,
    private readonly entities: Entities,
  ) {}

  sqlFilter(q: SqlFilterQuery): Array<Record<string, unknown>> {
    const columns = TABLE_COLUMNS[q.table];
    if (!columns) throw new Error(`table not exposed: ${q.table}`);
    const where: string[] = [];
    const params: Array<string | number> = [];
    for (const cond of q.where ?? []) {
      if (!columns.includes(cond.column)) {
        throw new Error(`column not exposed on ${q.table}: ${cond.column}`);
      }
      if (!OPS.has(cond.op)) throw new Error(`bad op: ${cond.op}`);
      where.push(`"${cond.column}" ${cond.op === "like" ? "LIKE" : cond.op} ?`);
      params.push(cond.value);
    }
    let sql = `SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM ${q.table}`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    if (q.orderBy) {
      if (!columns.includes(q.orderBy.column)) {
        throw new Error(`column not exposed on ${q.table}: ${q.orderBy.column}`);
      }
      sql += ` ORDER BY "${q.orderBy.column}" ${q.orderBy.dir === "desc" ? "DESC" : "ASC"}`;
    }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    sql += ` LIMIT ${limit}`;
    return this.dbx.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  }

  hybridSearch(q: {
    query: string;
    k?: number;
    filter?: SearchFilter;
    dedupe?: boolean;
    expand?: "thread" | "none";
  }): Promise<SearchHit[]> {
    return this.indexer.hybridSearch(q);
  }

  getThread(threadId: string): ThreadView | null {
    const thread = this.dbx.db
      .prepare("SELECT thread_id, subject FROM threads WHERE thread_id = ?")
      .get(threadId) as { thread_id: string; subject: string } | undefined;
    if (!thread) return null;
    const messages = this.dbx.db
      .prepare(
        `SELECT message_id, sent_at, from_name, from_address FROM messages
         WHERE thread_id = ? ORDER BY sent_at, message_id`,
      )
      .all(threadId) as Array<{
      message_id: string;
      sent_at: string | null;
      from_name: string;
      from_address: string;
    }>;
    const fragStmt = this.dbx.db.prepare(
      `SELECT text FROM fragments WHERE message_id = ? AND kind = 'new'
       ORDER BY span_start`,
    );
    const attStmt = this.dbx.db.prepare(
      `SELECT att_index, filename, blob_hash FROM attachments
       WHERE message_id = ? ORDER BY att_index`,
    );
    return {
      threadId: thread.thread_id,
      subject: thread.subject,
      messages: messages.map((m) => ({
        messageId: m.message_id,
        sentAt: m.sent_at,
        fromName: m.from_name,
        fromAddress: m.from_address,
        newText: (fragStmt.all(m.message_id) as Array<{ text: string }>)
          .map((f) => f.text)
          .join("\n"),
        attachments: (attStmt.all(m.message_id) as Array<{
          att_index: number;
          filename: string;
          blob_hash: string;
        }>).map((a) => ({
          attIndex: a.att_index,
          filename: a.filename,
          blobHash: a.blob_hash,
        })),
      })),
    };
  }

  getEntityTimeline(
    partyId: string,
    range?: { after?: string; before?: string },
  ): TimelineEntry[] {
    return this.entities.timeline(partyId, range);
  }

  suggestParties(): PartySuggestion[] {
    return this.entities.suggestParties();
  }

  getSource(chunkId: string): SourceView | null {
    const chunk = this.dbx.db
      .prepare(
        `SELECT c.chunk_id, c.blob_hash, c.span_start, c.span_end, c.text,
                c.message_id, b.mime, b.tombstoned
         FROM chunks c JOIN blobs b ON b.hash = c.blob_hash
         WHERE c.chunk_id = ?`,
      )
      .get(chunkId) as
      | {
          chunk_id: string;
          blob_hash: string;
          span_start: number;
          span_end: number;
          text: string;
          message_id: string | null;
          mime: string;
          tombstoned: number;
        }
      | undefined;
    if (!chunk || chunk.tombstoned) return null;
    const objectPath = join(
      this.dbx.objectsDir,
      chunk.blob_hash.slice(0, 2),
      chunk.blob_hash.slice(2),
    );
    if (!existsSync(objectPath)) return null;
    return {
      chunkId: chunk.chunk_id,
      blobHash: chunk.blob_hash,
      span: { start: chunk.span_start, end: chunk.span_end },
      text: chunk.text,
      mime: chunk.mime,
      messageId: chunk.message_id ?? undefined,
      raw: readFileSync(objectPath),
    };
  }
}
