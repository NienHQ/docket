import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { DocketDb } from "../db.js";
import { nowIso } from "../db.js";
import type {
  AddressMapping,
  Entities,
  Party,
  PartySuggestion,
  TimelineEntry,
} from "../types.js";

interface PartyRow {
  party_id: string;
  name: string;
  kind: string;
}

/** Consumer mail providers: excluded from domain grouping only. */
const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
]);

/** lowercase, collapse whitespace, strip surrounding quotes */
function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/^["']+/, "")
    .replace(/["']+$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** domain of an already-lowercased address, "" when malformed */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return "";
  return address.slice(at + 1);
}

/** "kestrel-hq.example" -> "Kestrel Hq": label before the TLD, title-cased */
function domainDisplayName(domain: string): string {
  const labels = domain.split(".").filter((l) => l.length > 0);
  const stem = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  return (stem ?? domain)
    .split(/[-.]+/)
    .filter((w) => w.length > 0)
    .map((w) => (w[0] ?? "").toUpperCase() + w.slice(1))
    .join(" ");
}

/** most frequent key; ties break to the lexicographically smallest */
function mostFrequent(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [key, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && key < best)) {
      best = key;
      bestN = n;
    }
  }
  return best;
}

function sortMappings(mappings: AddressMapping[]): AddressMapping[] {
  return [...mappings].sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
}

/** sha256 (first 16 hex chars) over a canonical JSON of the proposal */
function computeSuggestionId(
  kind: PartySuggestion["kind"],
  newParty: Party | undefined,
  mappings: AddressMapping[],
): string {
  const canonical = {
    kind,
    ...(newParty !== undefined
      ? { newParty: { partyId: newParty.partyId, name: newParty.name, kind: newParty.kind } }
      : {}),
    mappings: sortMappings(mappings).map((m) => ({
      address: m.address,
      partyId: m.partyId,
      ...(m.person !== undefined ? { person: m.person } : {}),
      ...(m.fromDate !== undefined ? { fromDate: m.fromDate } : {}),
      ...(m.toDate !== undefined ? { toDate: m.toDate } : {}),
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/** per-address activity gathered from message headers */
interface AddressStat {
  domain: string;
  /** raw display name -> occurrence count */
  names: Map<string, number>;
  messageIds: Set<string>;
  minAt: string | null;
  maxAt: string | null;
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

  /**
   * Deterministic entity-resolution proposals (spec 3.5), recomputed on
   * demand from message headers. Read-only: nothing is written and nothing
   * ever auto-merges; only confirm/dismiss decisions persist, keyed by the
   * suggestion's content hash so a proposal survives recomputation.
   */
  suggestParties(): PartySuggestion[] {
    const stats = this.collectAddressStats();

    // party_addresses stores lowercased addresses
    const mapped = new Map<string, Set<string>>();
    for (const row of this.db
      .prepare("SELECT address, party_id FROM party_addresses")
      .all() as Array<{ address: string; party_id: string }>) {
      let set = mapped.get(row.address);
      if (!set) {
        set = new Set();
        mapped.set(row.address, set);
      }
      set.add(row.party_id);
    }

    const parties = new Map<string, { name: string; kind: string }>();
    for (const row of this.db
      .prepare("SELECT party_id, name, kind FROM parties")
      .all() as PartyRow[]) {
      parties.set(row.party_id, { name: row.name, kind: row.kind });
    }

    // domain -> parties that already own mapped addresses at that domain
    const domainOwners = new Map<string, Set<string>>();
    for (const [address, partyIds] of mapped) {
      const domain = domainOf(address);
      if (domain === "") continue;
      let set = domainOwners.get(domain);
      if (!set) {
        set = new Set();
        domainOwners.set(domain, set);
      }
      for (const p of partyIds) set.add(p);
    }

    /** existing party responsible for a domain, when unambiguous */
    const existingDomainParty = (domain: string): string | null => {
      const owners = domainOwners.get(domain);
      if (owners !== undefined && owners.size === 1) {
        for (const p of owners) return p;
      }
      return parties.has(`party:${domain}`) ? `party:${domain}` : null;
    };

    /**
     * Party proposal for a domain. newParty is included when the party does
     * not exist yet, or exists exactly as this proposal would create it (the
     * upsert is a no-op then), so a confirmed domain suggestion recomputes to
     * the same content hash. A party customized by the user is never touched.
     */
    const proposeParty = (domain: string): { partyId: string; newParty?: Party } => {
      const partyId = `party:${domain}`;
      const proposal: Party = { partyId, name: domainDisplayName(domain), kind: "company" };
      const existing = parties.get(partyId);
      if (
        existing === undefined ||
        (existing.name === proposal.name && existing.kind === proposal.kind)
      ) {
        return { partyId, newParty: proposal };
      }
      return { partyId };
    };

    const draft: Array<Omit<PartySuggestion, "suggestionId" | "status">> = [];

    // ---- kind 1: domain_party ------------------------------------------
    // Unmapped addresses grouped by full domain (freemail skipped). An
    // address already mapped to exactly the domain's own suggested party is
    // kept in the group so a confirmed suggestion recomputes identically.
    const domainGroups = new Map<string, string[]>();
    for (const [address, stat] of stats) {
      if (stat.domain === "" || FREEMAIL.has(stat.domain)) continue;
      const partyIds = mapped.get(address);
      const own = `party:${stat.domain}`;
      const included =
        partyIds === undefined || (partyIds.size === 1 && partyIds.has(own));
      if (!included) continue;
      let group = domainGroups.get(stat.domain);
      if (!group) {
        group = [];
        domainGroups.set(stat.domain, group);
      }
      group.push(address);
    }
    for (const [domain, addresses] of domainGroups) {
      const messages = new Set<string>();
      for (const a of addresses) {
        for (const id of stats.get(a)?.messageIds ?? []) messages.add(id);
      }
      if (addresses.length < 2 && messages.size < 5) continue;
      const { partyId, newParty } = proposeParty(domain);
      const mappings = sortMappings(
        addresses.map((address) => {
          const person = mostFrequent(stats.get(address)?.names ?? new Map());
          return {
            address,
            partyId,
            ...(person !== null ? { person } : {}),
          };
        }),
      );
      draft.push({
        kind: "domain_party",
        summary: `map ${mappings.length} address(es) at ${domain} to ${partyId}`,
        ...(newParty !== undefined ? { newParty } : {}),
        mappings,
      });
    }

    // ---- kinds 2 and 3: same_person / person_move ----------------------
    const { nameAddresses, nameSpellings } = this.collectNames(stats);
    const sortedNames = [...nameAddresses.keys()].sort();
    for (const norm of sortedNames) {
      // too ambiguous to match on ("sam", "info")
      if (norm.length < 6 || !norm.includes(" ")) continue;
      const addressSet = nameAddresses.get(norm);
      if (addressSet === undefined || addressSet.size < 2) continue;
      const person = mostFrequent(nameSpellings.get(norm) ?? new Map()) ?? norm;
      const addresses = [...addressSet].sort();

      // party context per address: its mapping, else its domain's party
      // (existing or hypothetical), else null (freemail / malformed)
      const contexts = new Map<string, string | null>();
      for (const address of addresses) {
        const partyIds = mapped.get(address);
        if (partyIds !== undefined && partyIds.size > 0) {
          if (partyIds.size === 1) {
            for (const p of partyIds) contexts.set(address, p);
          } else {
            contexts.set(
              address,
              this.resolve(address)?.partyId ?? [...partyIds].sort()[0] ?? null,
            );
          }
          continue;
        }
        const domain = domainOf(address);
        if (domain === "" || FREEMAIL.has(domain)) {
          contexts.set(address, null);
        } else {
          contexts.set(address, existingDomainParty(domain) ?? `party:${domain}`);
        }
      }
      const defined = new Set<string>();
      for (const c of contexts.values()) if (c !== null) defined.add(c);

      if (defined.size <= 1) {
        // same party context everywhere: not a move. Map the unmapped
        // addresses to the party some address already belongs to.
        const unmapped = addresses.filter((a) => !mapped.has(a));
        const hasMapped = addresses.some((a) => mapped.has(a));
        if (defined.size !== 1 || !hasMapped || unmapped.length === 0) continue;
        let target = "";
        for (const c of defined) target = c;
        draft.push({
          kind: "same_person",
          summary: `map ${unmapped.join(", ")} to ${target} (same person: ${person})`,
          mappings: sortMappings(
            unmapped.map((address) => ({ address, partyId: target, person })),
          ),
        });
        continue;
      }

      // conflicting party contexts: person_move candidates, ordered by
      // first activity so "earlier" and "later" are well defined
      const ordered = [...addresses].sort((a, b) => {
        const sa = stats.get(a)?.minAt ?? "\uffff";
        const sb = stats.get(b)?.minAt ?? "\uffff";
        if (sa !== sb) return sa < sb ? -1 : 1;
        return a < b ? -1 : 1;
      });
      for (let i = 0; i + 1 < ordered.length; i++) {
        const earlier = ordered[i];
        const later = ordered[i + 1];
        if (earlier === undefined || later === undefined) continue;
        const earlierParty = contexts.get(earlier) ?? null;
        const laterContext = contexts.get(later) ?? null;
        if (earlierParty === null || laterContext === null) continue;
        if (earlierParty === laterContext) continue;
        // the closing edit re-maps the earlier address's existing mapping
        if (!mapped.has(earlier)) continue;

        let laterParty: string;
        let newParty: Party | undefined;
        if (mapped.has(later)) {
          laterParty = laterContext;
        } else {
          const domain = domainOf(later);
          if (domain === "" || FREEMAIL.has(domain)) continue;
          const existing = existingDomainParty(domain);
          if (existing !== null) {
            laterParty = existing;
          } else {
            const proposed = proposeParty(domain);
            laterParty = proposed.partyId;
            if (proposed.newParty !== undefined) newParty = proposed.newParty;
          }
        }

        const earlierStat = stats.get(earlier);
        const laterStat = stats.get(later);
        const sequential =
          earlierStat?.maxAt != null &&
          laterStat?.minAt != null &&
          earlierStat.maxAt <= laterStat.minAt;
        const boundary = sequential ? (laterStat?.minAt ?? "").slice(0, 10) : null;
        const mappings = sortMappings([
          {
            address: later,
            partyId: laterParty,
            person,
            ...(boundary !== null ? { fromDate: boundary } : {}),
          },
          {
            address: earlier,
            partyId: earlierParty,
            person,
            ...(boundary !== null ? { toDate: boundary } : {}),
          },
        ]);
        draft.push({
          kind: "person_move",
          summary:
            `${person} appears to move from ${earlierParty} (${earlier}) to ` +
            `${laterParty} (${later})` +
            (boundary !== null ? ` around ${boundary}` : " (overlapping activity)"),
          ...(newParty !== undefined ? { newParty } : {}),
          mappings,
        });
      }
    }

    // ---- ids, decision status, canonical order -------------------------
    const decisions = new Map<string, "confirmed" | "dismissed">();
    for (const row of this.db
      .prepare("SELECT suggestion_id, status FROM party_suggestion_decisions")
      .all() as Array<{ suggestion_id: string; status: "confirmed" | "dismissed" }>) {
      decisions.set(row.suggestion_id, row.status);
    }
    const seen = new Set<string>();
    const suggestions: PartySuggestion[] = [];
    for (const d of draft) {
      const suggestionId = computeSuggestionId(d.kind, d.newParty, d.mappings);
      if (seen.has(suggestionId)) continue;
      seen.add(suggestionId);
      suggestions.push({
        suggestionId,
        status: decisions.get(suggestionId) ?? "suggested",
        ...d,
      });
    }
    suggestions.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      return a.suggestionId < b.suggestionId ? -1 : a.suggestionId > b.suggestionId ? 1 : 0;
    });
    return suggestions;
  }

  confirmSuggestion(suggestionId: string): void {
    const suggestion = this.findSuggestion(suggestionId);
    this.db.transaction(() => {
      if (suggestion.newParty !== undefined) this.addParty(suggestion.newParty);
      // The party_addresses PK treats null from_date rows as distinct, so
      // the upsert in mapAddress can never replace an open-ended row.
      // Windowless mappings (the person_move closing edit in particular)
      // therefore delete the old open-ended (address, party) rows first.
      const deleteOpen = this.db.prepare(
        "DELETE FROM party_addresses WHERE address = ? AND party_id = ? AND from_date IS NULL",
      );
      for (const m of suggestion.mappings) {
        if (m.fromDate === undefined) {
          deleteOpen.run(m.address.toLowerCase(), m.partyId);
        }
        this.mapAddress(m);
      }
      this.db
        .prepare(
          `INSERT INTO party_suggestion_decisions (suggestion_id, status, decided_at)
           VALUES (?, 'confirmed', ?)`,
        )
        .run(suggestionId, nowIso());
    })();
  }

  dismissSuggestion(suggestionId: string): void {
    this.findSuggestion(suggestionId);
    this.db
      .prepare(
        `INSERT INTO party_suggestion_decisions (suggestion_id, status, decided_at)
         VALUES (?, 'dismissed', ?)`,
      )
      .run(suggestionId, nowIso());
  }

  /** current computation of one suggestion; rejects unknown and decided ids */
  private findSuggestion(suggestionId: string): PartySuggestion {
    const suggestion = this.suggestParties().find((s) => s.suggestionId === suggestionId);
    if (suggestion === undefined) {
      throw new Error(`unknown suggestion: ${suggestionId}`);
    }
    if (suggestion.status !== "suggested") {
      throw new Error(`already decided: ${suggestionId} is ${suggestion.status}`);
    }
    return suggestion;
  }

  /** header activity per lowercased address (sender and recipient sides) */
  private collectAddressStats(): Map<string, AddressStat> {
    const rows = this.db
      .prepare(
        `SELECT m.message_id AS message_id, lower(m.from_address) AS address,
                m.from_name AS name, m.sent_at AS sent_at
         FROM messages m WHERE m.from_address != ''
         UNION ALL
         SELECT r.message_id, lower(r.address), r.name, m.sent_at
         FROM message_recipients r JOIN messages m ON m.message_id = r.message_id`,
      )
      .all() as Array<{
      message_id: string;
      address: string;
      name: string;
      sent_at: string | null;
    }>;
    const stats = new Map<string, AddressStat>();
    for (const row of rows) {
      const address = row.address.trim();
      const domain = domainOf(address);
      if (domain === "") continue;
      let stat = stats.get(address);
      if (!stat) {
        stat = { domain, names: new Map(), messageIds: new Set(), minAt: null, maxAt: null };
        stats.set(address, stat);
      }
      stat.messageIds.add(row.message_id);
      if (row.sent_at !== null) {
        if (stat.minAt === null || row.sent_at < stat.minAt) stat.minAt = row.sent_at;
        if (stat.maxAt === null || row.sent_at > stat.maxAt) stat.maxAt = row.sent_at;
      }
      const raw = row.name.trim();
      if (raw !== "") stat.names.set(raw, (stat.names.get(raw) ?? 0) + 1);
    }
    return stats;
  }

  /** normalized display name -> addresses seen with it, and raw spellings */
  private collectNames(stats: Map<string, AddressStat>): {
    nameAddresses: Map<string, Set<string>>;
    nameSpellings: Map<string, Map<string, number>>;
  } {
    const nameAddresses = new Map<string, Set<string>>();
    const nameSpellings = new Map<string, Map<string, number>>();
    for (const [address, stat] of stats) {
      for (const [raw, count] of stat.names) {
        const norm = normalizeName(raw);
        if (norm === "") continue;
        let addrs = nameAddresses.get(norm);
        if (!addrs) {
          addrs = new Set();
          nameAddresses.set(norm, addrs);
        }
        addrs.add(address);
        let spellings = nameSpellings.get(norm);
        if (!spellings) {
          spellings = new Map();
          nameSpellings.set(norm, spellings);
        }
        spellings.set(raw, (spellings.get(raw) ?? 0) + count);
      }
    }
    return { nameAddresses, nameSpellings };
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
