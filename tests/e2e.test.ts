/**
 * End-to-end benchmark test (spec section 6). Ingests the committed
 * PaperTrail-Bench fixture corpus and answers its sampled questions using
 * only the public Docket API, then checks answers and citations against the
 * fixture ground truth.
 *
 * Boundary rule enforced here: the answering code sees only the question
 * records (template, text, params) and the public tools. Ground truth files
 * are read exclusively by the assertion side.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";
import type { FactInput, IngestResult, SearchHit } from "../src/types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/corpus-small", import.meta.url));
const MESSAGES_DIR = join(FIXTURE, "messages");

// ------------------------------------------------------------ fixture types

interface EvidenceRef {
  doc_id?: string;
  field?: string;
  message_id?: string;
  statement_id?: string;
}

interface Question {
  question_id: string;
  category: number;
  template: string;
  text: string;
  answer: { type: string; value: unknown };
  evidence: EvidenceRef[];
  params: Record<string, string>;
}

interface Manifest {
  counts: { messages: number; threads: number };
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** JSON with recursively sorted object keys, for order-insensitive equality. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableJson(rec[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

// --------------------------------------------------- deterministic answering

const MONEY_SRC = "\\$([0-9][0-9,]*)\\.([0-9]{2})";

interface Answered {
  value: unknown;
  /** chunk the value was parsed from, when the strategy pins one down */
  chunkId: string | null;
  /** the exact source substring the value was parsed from */
  parsedText: string | null;
}

const NO_ANSWER: Answered = { value: null, chunkId: null, parsedText: null };

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function centsOf(dollars: string, cents: string): number {
  return Number(dollars.replace(/,/g, "")) * 100 + Number(cents);
}

function docIdOf(q: Question): string {
  const fromParams = q.params["doc_id"];
  if (fromParams !== undefined) return fromParams;
  const m = /\b(?:INV|CN|PO)-\d{4}-\d{4}(?:-A\d+)?\b/.exec(q.text);
  if (!m) throw new Error(`no document id in question ${q.question_id}`);
  return m[0];
}

/**
 * Find the attachment chunk that carries a structured document: it must
 * contain the document number and the labeled field we intend to parse.
 */
async function findDocChunk(
  dk: Docket,
  docId: string,
  fieldLabel: string,
): Promise<SearchHit | null> {
  const hits = await dk.tools.hybridSearch({
    query: docId,
    k: 20,
    filter: { sourceKind: "attachment" },
  });
  for (const h of hits) {
    if (h.text.includes(docId) && h.text.includes(fieldLabel)) return h;
  }
  return null;
}

/** Category 1: parse 'Label: $X' from the document attachment. */
async function answerDocMoney(dk: Docket, docId: string, label: string): Promise<Answered> {
  const hit = await findDocChunk(dk, docId, `${label}:`);
  if (!hit) return NO_ANSWER;
  const m = new RegExp(`${reEscape(label)}: (${MONEY_SRC})`).exec(hit.text);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return NO_ANSWER;
  return {
    value: { amount_cents: centsOf(m[2], m[3]), currency: "USD" },
    chunkId: hit.chunkId,
    parsedText: m[1],
  };
}

/** Category 1: parse a labeled scalar field from the document attachment. */
async function answerDocField(
  dk: Docket,
  docId: string,
  label: string,
  valueRe: RegExp,
): Promise<Answered> {
  const hit = await findDocChunk(dk, docId, `${label}:`);
  if (!hit) return NO_ANSWER;
  const m = valueRe.exec(hit.text);
  if (!m || m[1] === undefined) return NO_ANSWER;
  return { value: m[1], chunkId: hit.chunkId, parsedText: m[1] };
}

/**
 * Category 2: collect every version id sharing the PO root from search hit
 * texts and contexts, ordered root first then A1, A2, ...
 */
async function poChain(dk: Docket, rootParam: string): Promise<string[]> {
  const root = rootParam.replace(/-A\d+$/, "");
  const hits = await dk.tools.hybridSearch({ query: root, k: 40 });
  const versions = new Set<number>([0]); // the root always exists
  const re = new RegExp(`${reEscape(root)}(?:-A(\\d+))?`, "g");
  for (const h of hits) {
    const hay = h.context + " " + h.text;
    for (const m of hay.matchAll(re)) {
      versions.add(m[1] !== undefined ? Number(m[1]) : 0);
    }
  }
  return [...versions]
    .sort((a, b) => a - b)
    .map((v) => (v === 0 ? root : `${root}-A${v}`));
}

async function answerFinalQuantity(dk: Docket, rootParam: string): Promise<Answered> {
  const chain = await poChain(dk, rootParam);
  const finalId = chain[chain.length - 1];
  if (finalId === undefined) return NO_ANSWER;
  const hit = await findDocChunk(dk, finalId, "Qty:");
  if (!hit) return NO_ANSWER;
  const m = /Qty: (\d+)/.exec(hit.text);
  if (!m || m[1] === undefined) return NO_ANSWER;
  return { value: Number(m[1]), chunkId: hit.chunkId, parsedText: m[1] };
}

/**
 * Category 3: extraction pass over search results into the fact ledger, then
 * a point-in-time asOf query. This fixture's 12 questions happen to cover
 * categories 1 and 2 only, so with corpus-small these handlers are wired but
 * unexercised; they run as soon as a fixture samples terms_as_of or
 * rent_as_of questions.
 */
async function answerAsOf(
  dk: Docket,
  q: Question,
  relation: "payment_terms" | "monthly_rent",
): Promise<Answered> {
  // params.entity is an opaque party id; the corpus only ever mentions party
  // NAMES, so the searchable name comes from the question text itself.
  const party = q.params["entity"] ?? "";
  const asOf = q.params["as_of"] ?? q.params["date"] ?? "";
  if (party.length === 0 || asOf.length === 0) return NO_ANSWER;
  const partyName =
    relation === "payment_terms"
      ? (/payment terms with (.+?) as of/.exec(q.text)?.[1] ?? "")
      : "";
  if (relation === "payment_terms" && partyName.length === 0) return NO_ANSWER;

  const probe =
    relation === "payment_terms"
      ? `${partyName} payment terms`
      : "monthly rent effective revised";
  const hits = await dk.tools.hybridSearch({ query: probe, k: 20 });

  const patterns: RegExp[] =
    relation === "payment_terms"
      ? [
          /payment terms of (NET\s?\d+)\b[^.]*?effective (\d{4}-\d{2}-\d{2})/gi,
          /payment terms[^.]*?are (NET\s?\d+)\s+effective (\d{4}-\d{2}-\d{2})/gi,
        ]
      : [
          new RegExp(`Monthly rent is (${MONEY_SRC})[^.]*?effective (\\d{4}-\\d{2}-\\d{2})`, "gi"),
          new RegExp(`rent[^.]*?revised to (${MONEY_SRC})[^.]*?effective (\\d{4}-\\d{2}-\\d{2})`, "gi"),
        ];

  const inputs: FactInput[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const relevant =
      relation === "payment_terms"
        ? h.text.toLowerCase().includes(partyName.toLowerCase())
        : /monthly rent/i.test(h.text);
    if (!relevant) continue;
    for (const re of patterns) {
      for (const m of h.text.matchAll(re)) {
        const raw = m[1];
        const validFrom = m[m.length - 1];
        if (raw === undefined || validFrom === undefined) continue;
        const value: string | number =
          relation === "payment_terms"
            ? raw.toUpperCase().replace(/\s+/g, "")
            : (() => {
                const mm = new RegExp(MONEY_SRC).exec(raw);
                return mm && mm[1] !== undefined && mm[2] !== undefined
                  ? centsOf(mm[1], mm[2])
                  : -1;
              })();
        const key = `${String(value)}|${validFrom}`;
        if (seen.has(key)) continue;
        seen.add(key);
        inputs.push({
          entity: party,
          relation,
          value,
          validFrom,
          source: { chunkId: h.chunkId },
        });
      }
    }
  }
  if (inputs.length === 0) return NO_ANSWER;
  dk.facts.backfill(inputs);
  const fact = dk.facts.asOf(party, relation, asOf);
  if (!fact) return NO_ANSWER;
  const chunkId = fact.sourceChunk;
  if (relation === "monthly_rent" && typeof fact.value === "number") {
    return {
      value: { amount_cents: fact.value, currency: "USD" },
      chunkId,
      parsedText: null,
    };
  }
  return { value: fact.value, chunkId, parsedText: null };
}

async function answerQuestion(dk: Docket, q: Question): Promise<Answered> {
  switch (q.template) {
    case "invoice_total":
      return answerDocMoney(dk, docIdOf(q), "Total");
    case "credit_note_amount":
      return answerDocMoney(dk, docIdOf(q), "Amount");
    case "invoice_due_date":
      return answerDocField(dk, docIdOf(q), "Due date", /Due date: (\d{4}-\d{2}-\d{2})/);
    case "invoice_po_ref":
      return answerDocField(dk, docIdOf(q), "Po ref", /Po ref: (\S+)/);
    case "amendment_chain": {
      const root = q.params["root_id"] ?? docIdOf(q);
      const chain = await poChain(dk, root);
      return { value: chain, chunkId: null, parsedText: null };
    }
    case "amendment_count": {
      const root = q.params["root_id"] ?? docIdOf(q);
      const chain = await poChain(dk, root);
      return { value: chain.length - 1, chunkId: null, parsedText: null };
    }
    case "final_quantity":
      return answerFinalQuantity(dk, q.params["root_id"] ?? docIdOf(q));
    case "terms_as_of":
      return answerAsOf(dk, q, "payment_terms");
    case "rent_as_of":
      return answerAsOf(dk, q, "monthly_rent");
    default:
      throw new Error(`no handler for template ${q.template}`);
  }
}

// ----------------------------------------------------------------- the test

interface Outcome extends Answered {
  q: Question;
  pass: boolean;
  error: string | null;
}

describe("e2e: benchmark corpus through the public API", () => {
  let dir: string;
  let dk: Docket;
  let ingestResults: IngestResult[] = [];
  let questions: Question[] = [];
  let manifest: Manifest;
  const outcomes: Outcome[] = [];

  function withRoDb<T>(fn: (db: Database) => T): T {
    const db = new DatabaseCtor(join(dir, "docket.db"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function chunkSnapshot(): string[] {
    return withRoDb((db) => {
      const rows = db
        .prepare("SELECT chunk_id, span_start, span_end FROM chunks ORDER BY chunk_id")
        .all() as Array<{ chunk_id: string; span_start: number; span_end: number }>;
      return rows.map((r) => `${r.chunk_id}:${r.span_start}:${r.span_end}`);
    });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "docket-e2e-"));
    dk = await Docket.open(dir); // no embedder: fully deterministic (spec invariant 7)
    ingestResults = await dk.ingest.dir(MESSAGES_DIR);
    questions = readJsonl<Question>(join(FIXTURE, "questions.jsonl"));
    manifest = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")) as Manifest;
  }, 120_000);

  afterAll(() => {
    dk?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ingests the corpus: all fresh, thread count matches the manifest, no orphans", () => {
    expect(ingestResults).toHaveLength(manifest.counts.messages);
    expect(ingestResults.every((r) => r.fresh)).toBe(true);

    const threads = dk.tools.sqlFilter({ table: "threads", limit: 500 });
    expect(threads).toHaveLength(manifest.counts.threads);

    const messages = dk.tools.sqlFilter({ table: "messages", limit: 500 });
    expect(messages).toHaveLength(manifest.counts.messages);
    const orphans = messages.filter((m) => m["thread_id"] === null);
    expect(orphans).toHaveLength(0);
  });

  it("re-ingesting the same directory changes nothing (invariant 1)", async () => {
    const messagesBefore = dk.tools.sqlFilter({ table: "messages", limit: 500 }).length;
    const chunksBefore = withRoDb(
      (db) => (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n,
    );
    expect(chunksBefore).toBeGreaterThan(0);

    const again = await dk.ingest.dir(MESSAGES_DIR);
    expect(again).toHaveLength(manifest.counts.messages);
    expect(again.every((r) => r.fresh === false)).toBe(true);

    expect(dk.tools.sqlFilter({ table: "messages", limit: 500 })).toHaveLength(messagesBefore);
    const chunksAfter = withRoDb(
      (db) => (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n,
    );
    expect(chunksAfter).toBe(chunksBefore);
  }, 60_000);

  it("answers at least 11 of 12 benchmark questions with public tools only", async () => {
    expect(questions).toHaveLength(12);
    for (const q of questions) {
      let got: Answered = NO_ANSWER;
      let error: string | null = null;
      try {
        got = await answerQuestion(dk, q);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const pass = error === null && stableJson(got.value) === stableJson(q.answer.value);
      outcomes.push({ q, ...got, pass, error });
    }

    const cell = (s: string, w: number): string => s.slice(0, w).padEnd(w);
    console.log(
      cell("question", 9) +
        cell("template", 18) +
        cell("expected", 44) +
        cell("got", 44) +
        "result",
    );
    for (const o of outcomes) {
      console.log(
        cell(o.q.question_id, 9) +
          cell(o.q.template, 18) +
          cell(stableJson(o.q.answer.value), 44) +
          cell(o.error ?? stableJson(o.value), 44) +
          (o.pass ? "pass" : "FAIL"),
      );
    }

    const passed = outcomes.filter((o) => o.pass).length;
    expect(passed).toBeGreaterThanOrEqual(11);
  }, 120_000);

  it("correct category 1 answers cite chunks that resolve to frozen source", () => {
    const cited = outcomes.filter((o) => o.q.category === 1 && o.pass);
    expect(cited.length).toBeGreaterThan(0);
    for (const o of cited) {
      expect(o.chunkId, `${o.q.question_id} carries a citation`).not.toBeNull();
      expect(o.parsedText, `${o.q.question_id} carries the parsed string`).not.toBeNull();
      if (o.chunkId === null || o.parsedText === null) continue;

      const source = dk.tools.getSource(o.chunkId);
      expect(source, `${o.q.question_id}: ${o.chunkId} resolves`).not.toBeNull();
      if (source === null) continue;

      expect(source.text).toContain(o.parsedText);
      expect(source.raw.length).toBeGreaterThan(0);

      const evidenceDocIds = o.q.evidence
        .map((e) => e.doc_id)
        .filter((d): d is string => typeof d === "string");
      expect(evidenceDocIds.length).toBeGreaterThan(0);
      expect(
        evidenceDocIds.some((d) => source.text.includes(d)),
        `${o.q.question_id}: cited chunk names a ground-truth evidence doc`,
      ).toBe(true);
    }
  });

  it("reindex() reproduces identical chunk ids and spans (invariant 3)", async () => {
    const before = chunkSnapshot();
    expect(before.length).toBeGreaterThan(0);
    await dk.reindex();
    const after = chunkSnapshot();
    expect(after).toEqual(before);
  }, 120_000);

  it("hybridSearch is deterministic with no embedder (invariant 7)", async () => {
    const query = { query: "invoice INV-2024-0007 total", k: 15 };
    const first = await dk.tools.hybridSearch(query);
    const second = await dk.tools.hybridSearch(query);
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((h) => h.chunkId)).toEqual(first.map((h) => h.chunkId));
  });
});
