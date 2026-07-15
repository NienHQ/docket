import type { DocketDb } from "./db.js";
import { openDb } from "./db.js";
import { DERIVED_TABLES } from "./schema.js";
import { SqliteEvidenceStore } from "./store/evidence.js";
import { SqliteIngestor } from "./ingest/ingest.js";
import { SqliteIndexer } from "./indexer/indexer.js";
import { SqliteFactLedger } from "./ledger/facts.js";
import { SqliteEntities } from "./entities/entities.js";
import { SqliteTools } from "./tools.js";
import type {
  BatchOptions,
  DocketOptions,
  Entities,
  EvidenceStore,
  FactLedger,
  IngestResult,
  Tools,
} from "./types.js";

function readonlyThrow(): never {
  throw new Error(
    "docket: this instance was opened read-only; writes are not allowed",
  );
}

/**
 * The facade: opens the appliance directory and wires the layers together.
 * Ingest methods here also index; the raw modules stay single-purpose.
 */
export class Docket {
  readonly store: EvidenceStore;
  readonly facts: FactLedger;
  readonly entities: Entities;
  readonly tools: Tools;
  readonly ingest: {
    emlBytes(bytes: Uint8Array): Promise<IngestResult>;
    emlFile(path: string): Promise<IngestResult>;
    mboxFile(path: string, opts?: BatchOptions): Promise<IngestResult[]>;
    dir(path: string, opts?: BatchOptions): Promise<IngestResult[]>;
  };

  private constructor(
    private readonly dbx: DocketDb,
    private readonly ingestor: SqliteIngestor,
    private readonly indexer: SqliteIndexer,
    store: EvidenceStore,
    facts: FactLedger,
    entities: Entities,
    tools: Tools,
  ) {
    const ro = dbx.readonly;
    this.store = ro
      ? {
          putBlob: readonlyThrow,
          tombstone: readonlyThrow,
          getBlob: (h) => store.getBlob(h),
          hasBlob: (h) => store.hasBlob(h),
        }
      : store;
    this.facts = ro
      ? {
          assert: readonlyThrow,
          backfill: readonlyThrow,
          asOf: (e, r, d) => facts.asOf(e, r, d),
          history: (e, r) => facts.history(e, r),
        }
      : facts;
    this.entities = ro
      ? {
          addParty: readonlyThrow,
          mapAddress: readonlyThrow,
          resolve: (a, d) => entities.resolve(a, d),
          timeline: (p, r) => entities.timeline(p, r),
        }
      : entities;
    this.tools = tools;
    this.ingest = ro
      ? {
          // async-typed surfaces reject rather than throw synchronously
          emlBytes: async () => readonlyThrow(),
          emlFile: async () => readonlyThrow(),
          mboxFile: async () => readonlyThrow(),
          dir: async () => readonlyThrow(),
        }
      : {
      emlBytes: async (bytes) => {
        const r = await this.ingestor.emlBytes(bytes);
        await this.indexIngested([r]);
        return r;
      },
      emlFile: async (path) => {
        const r = await this.ingestor.emlFile(path);
        await this.indexIngested([r]);
        return r;
      },
      mboxFile: async (path, opts) => {
        const rs = await this.ingestor.mboxFile(path, opts);
        await this.indexIngested(rs);
        return rs;
      },
      dir: async (path, opts) => {
        const rs = await this.ingestor.dir(path, opts);
        await this.indexIngested(rs);
        return rs;
      },
    };
  }

  static async open(dir: string, options: DocketOptions = {}): Promise<Docket> {
    const dbx = openDb(dir, { readonly: options.readonly === true });
    const store = new SqliteEvidenceStore(dbx);
    const ingestor = new SqliteIngestor(dbx, store);
    const indexer = new SqliteIndexer(dbx, options);
    const facts = new SqliteFactLedger(dbx);
    const entities = new SqliteEntities(dbx);
    const tools = new SqliteTools(dbx, indexer, entities);
    return new Docket(dbx, ingestor, indexer, store, facts, entities, tools);
  }

  /** Wipe all derived state and rebuild it from evidence (spec invariant 3). */
  async reindex(): Promise<void> {
    if (this.dbx.readonly) readonlyThrow();
    const { db } = this.dbx;
    for (const table of DERIVED_TABLES) {
      db.exec(`DELETE FROM ${table}`);
    }
    this.ingestor.rethreadAll();
    this.ingestor.restripAll();
    const messages = db
      .prepare("SELECT message_id FROM messages ORDER BY message_id")
      .all() as Array<{ message_id: string }>;
    for (const m of messages) {
      await this.indexer.indexMessage(m.message_id);
      const atts = db
        .prepare("SELECT att_index FROM attachments WHERE message_id = ? ORDER BY att_index")
        .all(m.message_id) as Array<{ att_index: number }>;
      for (const a of atts) {
        await this.indexer.indexAttachment(m.message_id, a.att_index);
      }
    }
  }

  close(): void {
    this.dbx.db.close();
  }

  private async indexIngested(results: IngestResult[]): Promise<void> {
    const attStmt = this.dbx.db.prepare(
      "SELECT att_index FROM attachments WHERE message_id = ? ORDER BY att_index",
    );
    for (const r of results) {
      if (!r.fresh) continue;
      await this.indexer.indexMessage(r.messageId);
      const atts = attStmt.all(r.messageId) as Array<{ att_index: number }>;
      for (const a of atts) {
        await this.indexer.indexAttachment(r.messageId, a.att_index);
      }
    }
  }
}
