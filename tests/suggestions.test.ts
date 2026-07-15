/**
 * Entity resolution v2 (plan 3.2, spec 3.5): deterministic suggestions over
 * message headers, confirm/dismiss decisions, and the windowed mappings a
 * confirmed person move produces. Everything goes through the public Docket
 * facade on temp dirs with synthetic emails; suggestions never write.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";
import type { PartySuggestion } from "../src/types.js";

const envs: Array<{ dk: Docket; dir: string }> = [];

async function open(): Promise<{ dk: Docket; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "docket-suggest-"));
  const dk = await Docket.open(dir);
  const env = { dk, dir };
  envs.push(env);
  return env;
}

afterEach(() => {
  for (const env of envs.splice(0)) {
    env.dk.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

const PLAIN = 'text/plain; charset="utf-8"';

function makeEml(headers: Record<string, string>, body: string): Uint8Array {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return new TextEncoder().encode(`${head}\r\n\r\n${body}`);
}

interface Mail {
  id: string;
  from: string;
  to: string;
  date: string;
  subject: string;
  body: string;
}

const AVA = "Ava Keller <ava@kestrel.example>";

/**
 * Scenario corpus:
 * - kestrel.example: vendor domain, 2 unmapped addresses, 5 messages
 * - gmail.com: freemail, never grouped by domain
 * - Jordan Rao: jordan@oldco.example (mapped to party:oldco) active through
 *   2024-03-10, then jordan@newco.example from 2024-04-02; newco.example has
 *   a second address (pat@) so its domain suggestion fires too
 * - Ava Keller: ava@kestrel.example mapped to party:kestrel, plus an
 *   unmapped freemail address
 */
const CORPUS: Mail[] = [
  { id: "k1@kestrel.example", from: "Kestrel Ops <ops@kestrel.example>", to: AVA,
    date: "Mon, 05 Feb 2024 09:00:00 +0000", subject: "Glazing quote",
    body: "Quote for the atrium glazing panels goes out this week." },
  { id: "k2@kestrel.example", from: "Kestrel Ops <ops@kestrel.example>", to: AVA,
    date: "Mon, 12 Feb 2024 09:00:00 +0000", subject: "Glazing schedule",
    body: "Revised glazing schedule attached for the lobby phase." },
  { id: "k3@kestrel.example", from: "Kestrel Ops <ops@kestrel.example>", to: AVA,
    date: "Mon, 19 Feb 2024 09:00:00 +0000", subject: "Mullion delivery",
    body: "Site delivery of the mullion frames is confirmed for friday." },
  { id: "k4@kestrel.example", from: "Kestrel Billing <billing@kestrel.example>", to: AVA,
    date: "Thu, 08 Feb 2024 09:00:00 +0000", subject: "Invoice 2231",
    body: "Invoice 2231 for the february panel shipment is due net thirty." },
  { id: "k5@kestrel.example", from: "Kestrel Billing <billing@kestrel.example>", to: AVA,
    date: "Mon, 26 Feb 2024 09:00:00 +0000", subject: "February statement",
    body: "Statement of account for february is enclosed." },
  { id: "g1@gmail.example", from: "Casey Fox Media <casey.fox@gmail.com>", to: AVA,
    date: "Wed, 14 Feb 2024 09:00:00 +0000", subject: "Press kit draft",
    body: "Draft press kit for the spring showcase is ready for review." },
  { id: "g2@gmail.example", from: "Casey Fox Media <casey.fox@gmail.com>", to: AVA,
    date: "Wed, 21 Feb 2024 09:00:00 +0000", subject: "Press kit update",
    body: "Updated press kit with the new photography selects." },
  { id: "o1@oldco.example", from: "Jordan Rao <jordan@oldco.example>", to: AVA,
    date: "Mon, 15 Jan 2024 09:00:00 +0000", subject: "Winter audit kickoff",
    body: "Kickoff for the granite ledger reconciliation ahead of the winter audit." },
  { id: "o2@oldco.example", from: "Jordan Rao <jordan@oldco.example>", to: AVA,
    date: "Tue, 20 Feb 2024 09:00:00 +0000", subject: "Interim numbers",
    body: "Interim granite ledger reconciliation numbers look clean so far." },
  { id: "o3@oldco.example", from: "Jordan Rao <jordan@oldco.example>", to: AVA,
    date: "Sun, 10 Mar 2024 09:00:00 +0000", subject: "Final memo",
    body: "Final granite ledger reconciliation memo is filed; wrapping up here." },
  { id: "a1@gmail.example", from: "Ava Keller <ava.keller@gmail.com>",
    to: "Jordan Rao <jordan@oldco.example>",
    date: "Sat, 10 Feb 2024 09:00:00 +0000", subject: "Checklist",
    body: "Can you send over the vendor onboarding checklist when you get a chance?" },
  { id: "n1@newco.example", from: "Jordan Rao <jordan@newco.example>", to: AVA,
    date: "Tue, 02 Apr 2024 09:00:00 +0000", subject: "First week update",
    body: "First week update: the turbine gasket order ships thursday." },
  { id: "n2@newco.example", from: "Jordan Rao <jordan@newco.example>", to: AVA,
    date: "Sat, 20 Apr 2024 09:00:00 +0000", subject: "Batch cleared",
    body: "Second turbine gasket batch cleared inspection this morning." },
  { id: "p1@newco.example", from: "Pat Lund <pat@newco.example>", to: AVA,
    date: "Wed, 10 Apr 2024 09:00:00 +0000", subject: "Onboarding",
    body: "Welcome aboard; badge and laptop are ready at the front desk." },
];

async function seed(dk: Docket): Promise<void> {
  dk.entities.addParty({ partyId: "party:oldco", name: "Oldco Consulting", kind: "company" });
  dk.entities.addParty({ partyId: "party:kestrel", name: "Kestrel Building Supply", kind: "company" });
  dk.entities.mapAddress({ address: "jordan@oldco.example", partyId: "party:oldco", person: "Jordan Rao" });
  dk.entities.mapAddress({ address: "ava@kestrel.example", partyId: "party:kestrel", person: "Ava Keller" });
  for (const m of CORPUS) {
    await dk.ingest.emlBytes(
      makeEml(
        {
          From: m.from,
          To: m.to,
          Subject: m.subject,
          Date: m.date,
          "Message-ID": `<${m.id}>`,
          "Content-Type": PLAIN,
        },
        m.body,
      ),
    );
  }
}

function snapshot(dir: string): Record<string, unknown[]> {
  const db = new DatabaseCtor(join(dir, "docket.db"));
  try {
    return {
      parties: db.prepare("SELECT * FROM parties ORDER BY party_id").all() as unknown[],
      addresses: db
        .prepare("SELECT * FROM party_addresses ORDER BY address, party_id, from_date")
        .all() as unknown[],
      decisions: db
        .prepare("SELECT suggestion_id, status FROM party_suggestion_decisions ORDER BY suggestion_id")
        .all() as unknown[],
    };
  } finally {
    db.close();
  }
}

function domainSuggestion(suggestions: PartySuggestion[], partyId: string): PartySuggestion {
  const s = suggestions.find(
    (x) => x.kind === "domain_party" && x.mappings[0]?.partyId === partyId,
  );
  expect(s, `expected a domain_party suggestion for ${partyId}`).toBeDefined();
  return s as PartySuggestion;
}

function onlyMove(suggestions: PartySuggestion[]): PartySuggestion {
  const moves = suggestions.filter((s) => s.kind === "person_move");
  expect(moves).toHaveLength(1);
  return moves[0] as PartySuggestion;
}

describe("suggestParties", () => {
  it("groups unmapped addresses by non-freemail domain with stable ids", async () => {
    const { dk } = await open();
    await seed(dk);
    const suggestions = dk.entities.suggestParties();

    const domains = suggestions.filter((s) => s.kind === "domain_party");
    const partyIds = domains.map((d) => d.mappings[0]?.partyId).sort();
    // kestrel and newco fire; gmail.com is freemail; oldco.example's only
    // address is already mapped, so the unmapped-only rule leaves nothing
    expect(partyIds).toEqual(["party:kestrel.example", "party:newco.example"]);

    const kestrel = domainSuggestion(suggestions, "party:kestrel.example");
    // ava@kestrel.example is mapped (to party:kestrel) and stays out
    expect(kestrel.mappings.map((m) => m.address)).toEqual([
      "billing@kestrel.example",
      "ops@kestrel.example",
    ]);
    expect(kestrel.newParty).toEqual({
      partyId: "party:kestrel.example",
      name: "Kestrel",
      kind: "company",
    });
    expect(kestrel.mappings.map((m) => m.person)).toEqual(["Kestrel Billing", "Kestrel Ops"]);
    for (const m of kestrel.mappings) {
      expect(m.fromDate).toBeUndefined();
      expect(m.toDate).toBeUndefined();
    }

    const newco = domainSuggestion(suggestions, "party:newco.example");
    expect(newco.mappings.map((m) => m.address)).toEqual([
      "jordan@newco.example",
      "pat@newco.example",
    ]);
    expect(newco.newParty?.name).toBe("Newco");

    // content-hash ids are stable across recomputation
    const again = dk.entities.suggestParties();
    expect(again.map((s) => s.suggestionId)).toEqual(suggestions.map((s) => s.suggestionId));
  });

  it("suggests mapping a same-person address to the party it already belongs to", async () => {
    const { dk } = await open();
    await seed(dk);
    const same = dk.entities.suggestParties().filter((s) => s.kind === "same_person");
    expect(same).toHaveLength(1);
    expect(same[0]?.newParty).toBeUndefined();
    expect(same[0]?.mappings).toEqual([
      { address: "ava.keller@gmail.com", partyId: "party:kestrel", person: "Ava Keller" },
    ]);
  });

  it("detects a person move with sequential windows and a boundary date", async () => {
    const { dk } = await open();
    await seed(dk);
    const move = onlyMove(dk.entities.suggestParties());

    expect(move.newParty).toEqual({
      partyId: "party:newco.example",
      name: "Newco",
      kind: "company",
    });
    const later = move.mappings.find((m) => m.address === "jordan@newco.example");
    expect(later?.partyId).toBe("party:newco.example");
    expect(later?.person).toBe("Jordan Rao");
    expect(later?.fromDate).toBe("2024-04-02"); // first newco activity
    expect(later?.toDate).toBeUndefined();
    const earlier = move.mappings.find((m) => m.address === "jordan@oldco.example");
    expect(earlier?.partyId).toBe("party:oldco"); // closing edit keeps its party
    expect(earlier?.toDate).toBe("2024-04-02"); // same boundary
    expect(earlier?.fromDate).toBeUndefined();
  });

  it("never auto-merges: computing suggestions changes no tables", async () => {
    const { dk, dir } = await open();
    await seed(dk);
    const before = snapshot(dir);
    dk.entities.suggestParties();
    dk.tools.suggestParties();
    expect(snapshot(dir)).toEqual(before);
  });

  it("confirm domain_party creates the party, maps addresses and records the decision", async () => {
    const { dk, dir } = await open();
    await seed(dk);
    const s = domainSuggestion(dk.entities.suggestParties(), "party:kestrel.example");

    expect(() => dk.entities.confirmSuggestion("0000000000000000")).toThrow(/unknown suggestion/);
    dk.entities.confirmSuggestion(s.suggestionId);

    expect(dk.entities.resolve("ops@kestrel.example")?.partyId).toBe("party:kestrel.example");
    expect(dk.entities.resolve("billing@kestrel.example")?.name).toBe("Kestrel");
    const snap = snapshot(dir);
    expect(snap["parties"]).toContainEqual(
      expect.objectContaining({ party_id: "party:kestrel.example", name: "Kestrel" }),
    );
    expect(snap["decisions"]).toEqual([
      { suggestion_id: s.suggestionId, status: "confirmed" },
    ]);

    // the applied proposal recomputes to the same content hash
    const recomputed = dk.entities
      .suggestParties()
      .find((x) => x.suggestionId === s.suggestionId);
    expect(recomputed?.status).toBe("confirmed");

    expect(() => dk.entities.confirmSuggestion(s.suggestionId)).toThrow(/already decided/);
  });

  it("confirm person_move windows both addresses at the boundary", async () => {
    const { dk, dir } = await open();
    await seed(dk);
    // the move carries its own newParty for newco.example, so no prior
    // domain_party confirmation is needed
    const move = onlyMove(dk.entities.suggestParties());
    dk.entities.confirmSuggestion(move.suggestionId);

    // before the boundary the old address resolves to oldco...
    expect(dk.entities.resolve("jordan@oldco.example", "2024-03-01")?.partyId).toBe("party:oldco");
    // ...and after it the oldco window is closed (from_date inclusive,
    // to_date exclusive at the boundary itself)
    expect(dk.entities.resolve("jordan@oldco.example", "2024-05-01")).toBeNull();
    expect(dk.entities.resolve("jordan@oldco.example", "2024-04-02")).toBeNull();
    expect(dk.entities.resolve("jordan@newco.example", "2024-04-02")?.partyId).toBe(
      "party:newco.example",
    );
    expect(dk.entities.resolve("jordan@newco.example", "2024-05-01")?.partyId).toBe(
      "party:newco.example",
    );
    expect(dk.entities.resolve("jordan@newco.example", "2024-03-01")).toBeNull();

    // the closing edit replaced the open-ended row instead of adding one
    const oldRows = (snapshot(dir)["addresses"] as Array<Record<string, unknown>>).filter(
      (r) => r["address"] === "jordan@oldco.example",
    );
    expect(oldRows).toHaveLength(1);
    expect(oldRows[0]?.["to_date"]).toBe("2024-04-02");
  });

  it("dismiss keeps the decision on recompute and hides it from the suggested-only view", async () => {
    const { dk } = await open();
    await seed(dk);
    const same = dk.entities.suggestParties().find((s) => s.kind === "same_person");
    expect(same).toBeDefined();
    const id = (same as PartySuggestion).suggestionId;

    dk.entities.dismissSuggestion(id);
    // dismissal changes no mappings
    expect(dk.entities.resolve("ava.keller@gmail.com")).toBeNull();

    const recomputed = dk.entities.suggestParties();
    expect(recomputed.find((s) => s.suggestionId === id)?.status).toBe("dismissed");
    // same predicate docket_suggest_parties applies without includeDecided
    const visible = recomputed.filter((s) => s.status === "suggested");
    expect(visible.some((s) => s.suggestionId === id)).toBe(false);
    expect(visible.length).toBeGreaterThan(0);

    expect(() => dk.entities.dismissSuggestion(id)).toThrow(/already decided/);
    expect(() => dk.entities.dismissSuggestion("ffffffffffffffff")).toThrow(/unknown suggestion/);
  });

  // The bench B1 category 5 fixture ("everything agreed with Jordan Rao"
  // across an employer change) will replace this synthetic check when it
  // exists (plan 3.3); until then this asserts the same shape end to end.
  it("answers the category-5 shape after confirming the move", async () => {
    const { dk } = await open();
    await seed(dk);
    dk.entities.confirmSuggestion(onlyMove(dk.entities.suggestParties()).suggestionId);

    const newcoHits = await dk.tools.hybridSearch({
      query: "turbine gasket order",
      filter: { partyId: "party:newco.example" },
    });
    expect(newcoHits.length).toBeGreaterThan(0);
    for (const h of newcoHits) {
      expect(["n1@newco.example", "n2@newco.example"]).toContain(h.messageId);
    }

    const oldcoHits = await dk.tools.hybridSearch({
      query: "granite ledger reconciliation",
      filter: { partyId: "party:oldco" },
    });
    expect(oldcoHits.length).toBeGreaterThan(0);
    for (const h of oldcoHits) {
      expect(["o1@oldco.example", "o2@oldco.example", "o3@oldco.example"]).toContain(h.messageId);
    }

    const newcoRefs = dk.entities.timeline("party:newco.example").map((e) => e.ref);
    expect(newcoRefs).toContain("n1@newco.example");
    expect(newcoRefs).toContain("n2@newco.example");
    expect(newcoRefs).not.toContain("o1@oldco.example");

    const oldcoRefs = dk.entities.timeline("party:oldco").map((e) => e.ref);
    for (const id of ["o1@oldco.example", "o2@oldco.example", "o3@oldco.example"]) {
      expect(oldcoRefs).toContain(id);
    }
    expect(oldcoRefs).not.toContain("n1@newco.example");
  });

  it("is deterministic and read-safe; deciding requires a writer", async () => {
    const { dk, dir } = await open();
    await seed(dk);
    const first = dk.entities.suggestParties();
    expect(first).toHaveLength(4);
    expect(dk.entities.suggestParties()).toEqual(first);

    const ro = await Docket.open(dir, { readonly: true });
    try {
      expect(ro.entities.suggestParties()).toEqual(first);
      const id = (first[0] as PartySuggestion).suggestionId;
      expect(() => ro.entities.confirmSuggestion(id)).toThrow(/read-only/);
      expect(() => ro.entities.dismissSuggestion(id)).toThrow(/read-only/);
    } finally {
      ro.close();
    }
  });
});
