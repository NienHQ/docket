import type { Database } from "better-sqlite3";
import type { DocketDb } from "../db.js";
import { nowIso } from "../db.js";
import type { FactInput, FactLedger, FactRow, FactValue } from "../types.js";

interface RawFactRow {
  fact_id: number;
  entity: string;
  relation: string;
  value_json: string;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  expired_at: string | null;
  source_chunk: string | null;
  source_message: string | null;
}

function toFactRow(r: RawFactRow): FactRow {
  return {
    factId: r.fact_id,
    entity: r.entity,
    relation: r.relation,
    value: JSON.parse(r.value_json) as FactValue,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    createdAt: r.created_at,
    expiredAt: r.expired_at,
    sourceChunk: r.source_chunk,
    sourceMessage: r.source_message,
  };
}

/**
 * Bi-temporal fact ledger over the `facts` table. Rows are never deleted:
 * superseded beliefs get expired_at set and a corrected replacement row is
 * inserted, so history stays queryable (spec invariant 5).
 */
export class SqliteFactLedger implements FactLedger {
  private readonly db: Database;

  constructor(ddb: DocketDb) {
    this.db = ddb.db;
  }

  assert(input: FactInput): FactRow {
    if (!input.source.chunkId && !input.source.messageId) {
      throw new Error("fact rejected: source must carry a chunkId or a messageId");
    }
    const db = this.db;

    const splice = db.transaction((): number => {
      const now = nowIso();
      const current = db
        .prepare(
          `SELECT * FROM facts
           WHERE entity = ? AND relation = ? AND expired_at IS NULL
           ORDER BY valid_from`,
        )
        .all(input.entity, input.relation) as RawFactRow[];

      const expire = db.prepare("UPDATE facts SET expired_at = ? WHERE fact_id = ?");
      const insert = db.prepare(
        `INSERT INTO facts
           (entity, relation, value_json, valid_from, valid_to,
            created_at, expired_at, source_chunk, source_message)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      );

      // Same (entity, relation, valid_from): the later assert replaces the belief.
      const kept = current.filter((row) => {
        if (row.valid_from === input.validFrom) {
          expire.run(now, row.fact_id);
          return false;
        }
        return true;
      });

      // Interval chain with the new fact spliced in by valid_from.
      // ISO 8601 strings compare correctly as strings.
      type Link = { kind: "old"; row: RawFactRow } | { kind: "new" };
      const validFromOf = (l: Link): string =>
        l.kind === "old" ? l.row.valid_from : input.validFrom;
      const chain: Link[] = [
        ...kept.map((row): Link => ({ kind: "old", row })),
        { kind: "new" } as Link,
      ].sort((a, b) => (validFromOf(a) < validFromOf(b) ? -1 : 1));

      let newFactId = -1;
      for (let i = 0; i < chain.length; i++) {
        const link = chain[i];
        if (!link) continue;
        const next = chain[i + 1];
        const validTo = next === undefined ? null : validFromOf(next);
        if (link.kind === "new") {
          const res = insert.run(
            input.entity,
            input.relation,
            JSON.stringify(input.value),
            input.validFrom,
            validTo,
            now,
            input.source.chunkId ?? null,
            input.source.messageId ?? null,
          );
          newFactId = Number(res.lastInsertRowid);
        } else if (link.row.valid_to !== validTo) {
          expire.run(now, link.row.fact_id);
          insert.run(
            link.row.entity,
            link.row.relation,
            link.row.value_json,
            link.row.valid_from,
            validTo,
            now,
            link.row.source_chunk,
            link.row.source_message,
          );
        }
      }
      return newFactId;
    });

    const factId = splice();
    const raw = db.prepare("SELECT * FROM facts WHERE fact_id = ?").get(factId) as RawFactRow;
    return toFactRow(raw);
  }

  backfill(inputs: FactInput[]): FactRow[] {
    const sorted = [...inputs].sort((a, b) =>
      a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0,
    );
    return sorted.map((input) => this.assert(input));
  }

  asOf(entity: string, relation: string, date: string): FactRow | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM facts
         WHERE entity = ? AND relation = ? AND expired_at IS NULL
           AND valid_from <= ? AND (valid_to IS NULL OR ? < valid_to)
         ORDER BY valid_from DESC LIMIT 1`,
      )
      .get(entity, relation, date, date) as RawFactRow | undefined;
    return raw ? toFactRow(raw) : null;
  }

  history(entity: string, relation: string): FactRow[] {
    const raws = this.db
      .prepare(
        `SELECT * FROM facts
         WHERE entity = ? AND relation = ?
         ORDER BY created_at, fact_id`,
      )
      .all(entity, relation) as RawFactRow[];
    return raws.map(toFactRow);
  }
}
