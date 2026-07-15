import type { Database } from "better-sqlite3";
import type { DocketDb } from "../db.js";
import type { Entities, Party, TimelineEntry } from "../types.js";

interface PartyRow {
  party_id: string;
  name: string;
  kind: string;
}

/**
 * Deterministic address book: parties, address to party mappings with
 * validity windows, and a merged activity timeline. No knowledge graph.
 */
export class SqliteEntities implements Entities {
  private readonly db: Database;

  constructor(ddb: DocketDb) {
    this.db = ddb.db;
  }

  addParty(party: Party): void {
    this.db
      .prepare(
        `INSERT INTO parties (party_id, name, kind) VALUES (?, ?, ?)
         ON CONFLICT(party_id) DO UPDATE SET name = excluded.name, kind = excluded.kind`,
      )
      .run(party.partyId, party.name, party.kind);
  }

  mapAddress(m: {
    address: string;
    partyId: string;
    person?: string;
    fromDate?: string;
    toDate?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO party_addresses (address, party_id, person, from_date, to_date)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address, party_id, from_date) DO UPDATE SET
           person = excluded.person, to_date = excluded.to_date`,
      )
      .run(
        m.address.toLowerCase(),
        m.partyId,
        m.person ?? "",
        m.fromDate ?? null,
        m.toDate ?? null,
      );
  }

  resolve(address: string, date?: string): Party | null {
    let sql = `
      SELECT p.party_id, p.name, p.kind
      FROM party_addresses pa
      JOIN parties p ON p.party_id = pa.party_id
      WHERE pa.address = ?`;
    const params: string[] = [address.toLowerCase()];
    if (date !== undefined) {
      sql += `
        AND (pa.from_date IS NULL OR pa.from_date <= ?)
        AND (pa.to_date IS NULL OR ? < pa.to_date)`;
      params.push(date, date);
    }
    // DESC puts null from_date (open start) last, so the latest window wins.
    sql += " ORDER BY pa.from_date DESC LIMIT 1";
    const row = this.db.prepare(sql).get(...params) as PartyRow | undefined;
    return row ? { partyId: row.party_id, name: row.name, kind: row.kind } : null;
  }

  timeline(partyId: string, range?: { after?: string; before?: string }): TimelineEntry[] {
    const entries: TimelineEntry[] = [];

    const facts = this.db
      .prepare(
        `SELECT fact_id, relation, value_json, valid_from FROM facts
         WHERE expired_at IS NULL AND entity = ?`,
      )
      .all(partyId) as Array<{
      fact_id: number;
      relation: string;
      value_json: string;
      valid_from: string;
    }>;
    for (const f of facts) {
      entries.push({
        at: f.valid_from,
        type: "fact",
        ref: String(f.fact_id),
        summary: `${f.relation} = ${f.value_json}`,
      });
    }

    const docs = this.db
      .prepare(
        `SELECT doc_id, kind, issued_date FROM documents
         WHERE party_id = ? AND issued_date IS NOT NULL`,
      )
      .all(partyId) as Array<{ doc_id: string; kind: string; issued_date: string }>;
    for (const d of docs) {
      entries.push({
        at: d.issued_date,
        type: "document",
        ref: d.doc_id,
        summary: `${d.kind} ${d.doc_id}`,
      });
    }

    // party_addresses stores lowercased addresses; message tables may not.
    const msgs = this.db
      .prepare(
        `SELECT DISTINCT m.message_id, m.sent_at, m.subject
         FROM messages m
         WHERE m.sent_at IS NOT NULL AND (
           lower(m.from_address) IN
             (SELECT address FROM party_addresses WHERE party_id = ?)
           OR EXISTS (
             SELECT 1 FROM message_recipients r
             JOIN party_addresses pa ON pa.address = lower(r.address)
             WHERE r.message_id = m.message_id AND pa.party_id = ?
           )
         )`,
      )
      .all(partyId, partyId) as Array<{
      message_id: string;
      sent_at: string;
      subject: string;
    }>;
    for (const m of msgs) {
      entries.push({
        at: m.sent_at,
        type: "message",
        ref: m.message_id,
        summary: m.subject,
      });
    }

    const filtered = entries.filter(
      (e) =>
        (range?.after === undefined || e.at >= range.after) &&
        (range?.before === undefined || e.at < range.before),
    );
    filtered.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return filtered;
  }
}
