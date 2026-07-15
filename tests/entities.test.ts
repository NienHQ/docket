import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocketDb } from "../src/db.js";
import { nowIso, openDb } from "../src/db.js";
import { SqliteEntities } from "../src/entities/entities.js";
import { SqliteFactLedger } from "../src/ledger/facts.js";

describe("SqliteEntities", () => {
  let dir: string;
  let ddb: DocketDb;
  let entities: SqliteEntities;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docket-entities-"));
    ddb = openDb(dir);
    entities = new SqliteEntities(ddb);
  });

  afterEach(() => {
    ddb.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves an address that moved between companies by date window", () => {
    entities.addParty({ partyId: "acme", name: "Acme Corp", kind: "company" });
    entities.addParty({ partyId: "globex", name: "Globex Inc", kind: "company" });
    // jane worked at acme until 2026-01-01, at globex from then on
    entities.mapAddress({ address: "Jane@Example.com", partyId: "acme", toDate: "2026-01-01" });
    entities.mapAddress({ address: "jane@example.com", partyId: "globex", fromDate: "2026-01-01" });

    expect(entities.resolve("JANE@EXAMPLE.COM", "2025-06-15")?.partyId).toBe("acme");
    // boundary: to_date exclusive, from_date inclusive
    expect(entities.resolve("jane@example.com", "2026-01-01")?.partyId).toBe("globex");
    expect(entities.resolve("jane@example.com", "2026-05-01")?.partyId).toBe("globex");
    // no date: latest from_date wins
    expect(entities.resolve("jane@example.com")?.partyId).toBe("globex");
    expect(entities.resolve("nobody@example.com")).toBeNull();
    expect(entities.resolve("jane@example.com", "1990-01-01")?.partyId).toBe("acme");
  });

  it("upserts are idempotent", () => {
    entities.addParty({ partyId: "acme", name: "Acme", kind: "company" });
    entities.addParty({ partyId: "acme", name: "Acme Corp", kind: "company" });
    expect(entities.resolve("x@acme.com")).toBeNull();

    entities.mapAddress({ address: "x@acme.com", partyId: "acme", fromDate: "2026-01-01" });
    entities.mapAddress({ address: "x@acme.com", partyId: "acme", fromDate: "2026-01-01", person: "X" });
    const p = entities.resolve("x@acme.com");
    expect(p?.name).toBe("Acme Corp");
    const n = ddb.db
      .prepare("SELECT count(*) AS n FROM party_addresses WHERE address = 'x@acme.com'")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("merges facts, documents and messages into one ordered timeline", () => {
    entities.addParty({ partyId: "acme", name: "Acme Corp", kind: "company" });
    entities.mapAddress({ address: "jane@acme.com", partyId: "acme", person: "Jane" });

    const ledger = new SqliteFactLedger(ddb);
    ledger.assert({
      entity: "acme",
      relation: "net_terms",
      value: 30,
      validFrom: "2026-01-10",
      source: { messageId: "msgA" },
    });

    const now = nowIso();
    ddb.db
      .prepare(
        `INSERT INTO documents (doc_id, kind, root_id, version, party_id, issued_date)
         VALUES ('doc_1', 'invoice', 'doc_1', 1, 'acme', '2026-01-20')`,
      )
      .run();

    ddb.db
      .prepare("INSERT INTO blobs (hash, size, mime, created_at) VALUES ('h1', 0, 'message/rfc822', ?)")
      .run(now);
    const insMsg = ddb.db.prepare(
      `INSERT INTO messages (message_id, blob_hash, subject, from_address, sent_at)
       VALUES (?, 'h1', ?, ?, ?)`,
    );
    // sent by the party (mixed case address in the message row)
    insMsg.run("msgA", "Kickoff", "Jane@Acme.com", "2026-01-05T10:00:00Z");
    // sent to the party
    insMsg.run("msgB", "Invoice attached", "vendor@ext.com", "2026-01-25T09:00:00Z");
    // both from and to the party: must appear once
    insMsg.run("msgC", "Note to self", "jane@acme.com", "2026-01-30T08:00:00Z");
    const insRcpt = ddb.db.prepare(
      "INSERT INTO message_recipients (message_id, address, kind) VALUES (?, ?, 'to')",
    );
    insRcpt.run("msgB", "Jane@Acme.com");
    insRcpt.run("msgC", "jane@acme.com");

    const tl = entities.timeline("acme");
    expect(tl.map((e) => e.type)).toEqual(["message", "fact", "document", "message", "message"]);
    expect(tl.map((e) => e.at)).toEqual([...tl.map((e) => e.at)].sort());
    expect(tl[0]?.ref).toBe("msgA");
    expect(tl[1]?.ref).toMatch(/^\d+$/); // fact id
    expect(tl[2]?.ref).toBe("doc_1");
    expect(tl[3]?.ref).toBe("msgB");
    expect(tl[4]?.ref).toBe("msgC");
    expect(tl[0]?.summary).toBe("Kickoff");
    expect(tl[1]?.summary).toBe("net_terms = 30");
    expect(tl[2]?.summary).toBe("invoice doc_1");
    expect(tl[3]?.summary).toBe("Invoice attached");

    // range: after inclusive, before exclusive
    const windowed = entities.timeline("acme", { after: "2026-01-10", before: "2026-01-25" });
    expect(windowed.map((e) => e.type)).toEqual(["fact", "document"]);

    expect(entities.timeline("unknown-party")).toEqual([]);
  });
});
