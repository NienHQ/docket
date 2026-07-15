import type { DocketDb } from "../db.js";
import type { BlobHash } from "../types.js";

/** Mirrors the documents table, camelCase, fields_json parsed. */
export interface DocumentRow {
  docId: string;
  kind: string;
  rootId: string;
  version: number;
  supersedes: string | null;
  partyId: string | null;
  blobHash: BlobHash | null;
  issuedDate: string | null;
  fields: Record<string, unknown>;
}

interface RawDocumentRow {
  doc_id: string;
  kind: string;
  root_id: string;
  version: number;
  supersedes: string | null;
  party_id: string | null;
  blob_hash: string | null;
  issued_date: string | null;
  fields_json: string;
}

function fromRaw(r: RawDocumentRow): DocumentRow {
  return {
    docId: r.doc_id,
    kind: r.kind,
    rootId: r.root_id,
    version: r.version,
    supersedes: r.supersedes,
    partyId: r.party_id,
    blobHash: r.blob_hash,
    issuedDate: r.issued_date,
    fields: JSON.parse(r.fields_json) as Record<string, unknown>,
  };
}

export class DocumentsStore {
  private readonly ddb: DocketDb;

  constructor(ddb: DocketDb) {
    this.ddb = ddb;
  }

  addDocument(row: DocumentRow): void {
    this.ddb.db
      .prepare(
        `INSERT INTO documents
           (doc_id, kind, root_id, version, supersedes, party_id, blob_hash, issued_date, fields_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.docId,
        row.kind,
        row.rootId,
        row.version,
        row.supersedes,
        row.partyId,
        row.blobHash,
        row.issuedDate,
        JSON.stringify(row.fields),
      );
  }

  get(docId: string): DocumentRow | null {
    const r = this.ddb.db
      .prepare("SELECT * FROM documents WHERE doc_id = ?")
      .get(docId) as RawDocumentRow | undefined;
    return r ? fromRaw(r) : null;
  }

  chain(rootId: string): DocumentRow[] {
    const rows = this.ddb.db
      .prepare("SELECT * FROM documents WHERE root_id = ? ORDER BY version")
      .all(rootId) as RawDocumentRow[];
    return rows.map(fromRaw);
  }
}
