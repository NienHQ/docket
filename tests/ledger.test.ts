import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocketDb } from "../src/db.js";
import { openDb } from "../src/db.js";
import { SqliteFactLedger } from "../src/ledger/facts.js";
import type { FactInput } from "../src/types.js";

const src = { messageId: "msg-1" };

function fact(entity: string, relation: string, value: string | number, validFrom: string): FactInput {
  return { entity, relation, value, validFrom, source: src };
}

/** Spec invariant 5: per key, current intervals contiguous, at most one open. */
function checkIntervals(ddb: DocketDb, entity: string, relation: string): void {
  const rows = ddb.db
    .prepare(
      `SELECT valid_from, valid_to FROM facts
       WHERE entity = ? AND relation = ? AND expired_at IS NULL
       ORDER BY valid_from`,
    )
    .all(entity, relation) as Array<{ valid_from: string; valid_to: string | null }>;
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const next = rows[i + 1];
    if (!cur) continue;
    if (next) {
      expect(cur.valid_to).toBe(next.valid_from);
    } else {
      expect(cur.valid_to).toBeNull();
    }
  }
}

describe("SqliteFactLedger", () => {
  let dir: string;
  let ddb: DocketDb;
  let ledger: SqliteFactLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docket-ledger-"));
    ddb = openDb(dir);
    ledger = new SqliteFactLedger(ddb);
  });

  afterEach(() => {
    ddb.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a fact whose source has neither chunkId nor messageId", () => {
    expect(() =>
      ledger.assert({ entity: "e", relation: "r", value: 1, validFrom: "2026-01-01", source: {} }),
    ).toThrow();
  });

  it("builds a contiguous supersession chain from in-order asserts", () => {
    ledger.assert(fact("acme", "net_terms", 30, "2026-01-01"));
    ledger.assert(fact("acme", "net_terms", 45, "2026-02-01"));
    ledger.assert(fact("acme", "net_terms", 60, "2026-03-01"));

    const current = ddb.db
      .prepare(
        `SELECT value_json, valid_from, valid_to FROM facts
         WHERE entity = 'acme' AND relation = 'net_terms' AND expired_at IS NULL
         ORDER BY valid_from`,
      )
      .all() as Array<{ value_json: string; valid_from: string; valid_to: string | null }>;

    expect(current.map((r) => [JSON.parse(r.value_json), r.valid_from, r.valid_to])).toEqual([
      [30, "2026-01-01", "2026-02-01"],
      [45, "2026-02-01", "2026-03-01"],
      [60, "2026-03-01", null],
    ]);
    checkIntervals(ddb, "acme", "net_terms");
  });

  it("answers asOf at and around interval boundaries", () => {
    ledger.assert(fact("acme", "net_terms", 30, "2026-01-01"));
    ledger.assert(fact("acme", "net_terms", 45, "2026-02-01"));

    expect(ledger.asOf("acme", "net_terms", "2025-12-31")).toBeNull();
    expect(ledger.asOf("acme", "net_terms", "2026-01-01")?.value).toBe(30);
    expect(ledger.asOf("acme", "net_terms", "2026-01-31")?.value).toBe(30);
    // valid_to is exclusive: on the boundary the newer fact answers.
    expect(ledger.asOf("acme", "net_terms", "2026-02-01")?.value).toBe(45);
    expect(ledger.asOf("acme", "net_terms", "2026-06-15")?.value).toBe(45);
    expect(ledger.asOf("nobody", "net_terms", "2026-06-15")).toBeNull();
  });

  it("splices an out-of-order assert into the chain", () => {
    ledger.assert(fact("acme", "address", "March St", "2026-03-01"));
    const jan = ledger.assert(fact("acme", "address", "January Ave", "2026-01-01"));

    expect(jan.validTo).toBe("2026-03-01");
    expect(ledger.asOf("acme", "address", "2026-02-15")?.value).toBe("January Ave");
    expect(ledger.asOf("acme", "address", "2026-03-15")?.value).toBe("March St");
    checkIntervals(ddb, "acme", "address");
  });

  it("backfill of shuffled facts equals the in-order result", () => {
    const dates = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"];
    const shuffled = [2, 0, 3, 1].map((i) => {
      const d = dates[i];
      if (d === undefined) throw new Error("bad index");
      return fact("shuf", "status", `v${i}`, d);
    });
    const returned = ledger.backfill(shuffled);
    // returned in insertion order, which is validFrom ascending
    expect(returned.map((r) => r.validFrom)).toEqual(dates);

    for (const [i, d] of dates.entries()) {
      ledger.assert(fact("ordered", "status", `v${i}`, d));
    }

    const chainOf = (entity: string) =>
      ddb.db
        .prepare(
          `SELECT value_json, valid_from, valid_to FROM facts
           WHERE entity = ? AND relation = 'status' AND expired_at IS NULL
           ORDER BY valid_from`,
        )
        .all(entity) as Array<{ value_json: string; valid_from: string; valid_to: string | null }>;

    expect(chainOf("shuf")).toEqual(chainOf("ordered"));
    checkIntervals(ddb, "shuf", "status");
    checkIntervals(ddb, "ordered", "status");
  });

  it("re-asserting the same (entity, relation, valid_from) replaces the belief", () => {
    ledger.assert(fact("acme", "owner", "alice", "2026-01-01"));
    ledger.assert(fact("acme", "owner", "bob", "2026-01-01"));

    expect(ledger.asOf("acme", "owner", "2026-01-01")?.value).toBe("bob");

    const current = ddb.db
      .prepare(
        `SELECT count(*) AS n FROM facts
         WHERE entity = 'acme' AND relation = 'owner' AND expired_at IS NULL`,
      )
      .get() as { n: number };
    expect(current.n).toBe(1);

    const hist = ledger.history("acme", "owner");
    expect(hist.length).toBe(2);
    expect(hist.some((r) => r.value === "alice" && r.expiredAt !== null)).toBe(true);
    checkIntervals(ddb, "acme", "owner");
  });

  it("history keeps expired rows and never deletes", () => {
    ledger.assert(fact("acme", "plan", "basic", "2026-02-01"));
    ledger.assert(fact("acme", "plan", "pro", "2026-04-01"));
    // out of order: forces an expire + corrected replacement of the Feb row
    ledger.assert(fact("acme", "plan", "trial", "2026-01-01"));

    const hist = ledger.history("acme", "plan");
    // 3 asserts, plus 1 corrected replacement for the Feb row (valid_to unchanged
    // by the trial splice only for rows after it; trial closes at 2026-02-01)
    expect(hist.length).toBeGreaterThanOrEqual(3);
    expect(hist.filter((r) => r.expiredAt !== null).length).toBeGreaterThanOrEqual(1);
    // the expired row keeps the interval as it was believed at the time
    const expiredBasic = hist.find((r) => r.value === "basic" && r.expiredAt !== null);
    expect(expiredBasic?.validTo).toBeNull();
    // the corrected replacement carries the closed interval and stays current
    const currentBasic = hist.find((r) => r.value === "basic" && r.expiredAt === null);
    expect(currentBasic?.validTo).toBe("2026-04-01");
    checkIntervals(ddb, "acme", "plan");
  });

  it("keeps per-key intervals non-overlapping under mixed-order asserts", () => {
    const order = ["2026-05-01", "2026-01-01", "2026-03-01", "2026-02-01", "2026-04-01"];
    for (const d of order) ledger.assert(fact("mix", "state", d, d));
    checkIntervals(ddb, "mix", "state");

    // each month answers with its own value
    for (const d of order) {
      expect(ledger.asOf("mix", "state", d)?.value).toBe(d);
    }
    expect(ledger.asOf("mix", "state", "2026-02-15")?.value).toBe("2026-02-01");
    expect(ledger.asOf("mix", "state", "2027-01-01")?.value).toBe("2026-05-01");
  });

  it("roundtrips object values through value_json", () => {
    const value = { limit: 5000, currency: "USD" };
    ledger.assert({ entity: "acme", relation: "credit", value, validFrom: "2026-01-01", source: src });
    expect(ledger.asOf("acme", "credit", "2026-01-02")?.value).toEqual(value);
  });
});
