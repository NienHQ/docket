/**
 * Plan 3.1 done criterion: on the bench fixture, extraction + asOf answers
 * the temporal (category 3) questions at equal accuracy with the e2e's
 * hand-written regex path, behind a flag.
 *
 * The flag is the completion function itself: extractFacts runs only when a
 * caller supplies complete(), so extraction is off unless explicitly wired.
 * Here the completion is a deterministic stand-in that emulates an
 * extraction model by pattern-matching its own prompt input; a real
 * deployment passes a real completion function (any provider) in its place
 * and gets the same validation, grounding, and audit trail around it.
 *
 * Boundary rule (as in the e2e): the extraction and answering code sees only
 * the prompt input, the question records, and the public API. Ground truth
 * is read by assertion code only.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";
import type { ProposedFact } from "../src/types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/corpus-small", import.meta.url));
const MESSAGES_DIR = join(FIXTURE, "messages");

interface Question {
  question_id: string;
  category: number;
  template: string;
  text: string;
  answer: { type: string; value: unknown };
  params: Record<string, string>;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

// ------------------------------------------------- the mock extraction model

interface Block {
  id: string;
  text: string;
}

/** split the prompt into (chunk id, chunk text) blocks by the bracket markers */
function chunkBlocks(prompt: string): Block[] {
  const re = /\[chunk (chk_[a-z0-9_]+)\] /g;
  const marks: Array<{ id: string; bodyStart: number; markStart: number }> = [];
  for (const m of prompt.matchAll(re)) {
    marks.push({ id: m[1]!, bodyStart: m.index + m[0].length, markStart: m.index });
  }
  return marks.map((mark, i) => {
    const next = marks[i + 1];
    let text = prompt.slice(mark.bodyStart, next ? next.markStart : prompt.length);
    // a trailing "From ... on ...:" line belongs to the next message header
    text = text.replace(/\nFrom \S+ on [^\n]*:\s*$/, "");
    return { id: mark.id, text };
  });
}

const TERMS_PATTERNS = [
  /payment terms of (NET\s?\d+)\b[^.]*?effective (\d{4}-\d{2}-\d{2})/gi,
  /payment terms[^.]*?are (NET\s?\d+)\s+effective (\d{4}-\d{2}-\d{2})/gi,
];
const RENT_PATTERNS = [
  /Monthly rent is (\$[\d,]+\.\d{2})[^.]*?effective (\d{4}-\d{2}-\d{2})/gi,
  /rent[^.]*?revised to (\$[\d,]+\.\d{2})[^.]*?effective (\d{4}-\d{2}-\d{2})/gi,
];
const BETWEEN_RE =
  /between ([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*) and ([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*)/;
const LANDLORD_RE = /\b([A-Z][A-Za-z]+ Properties)\b/;

/**
 * Deterministic extraction-model stand-in: pattern-matches its own prompt
 * for the statement shapes the corpus generator emits. Values are proposed
 * EXACTLY as they appear in the chunk text (grounding is a case-insensitive,
 * whitespace-collapsed substring check, so "NET45" would not ground against
 * "NET 45"); normalization happens at query time instead.
 */
async function extractionModel(prompt: string): Promise<string> {
  const proposals: ProposedFact[] = [];
  for (const block of chunkBlocks(prompt)) {
    for (const re of TERMS_PATTERNS) {
      for (const m of block.text.matchAll(re)) {
        const between = BETWEEN_RE.exec(block.text);
        if (!between) continue;
        for (const entity of [between[1]!, between[2]!]) {
          proposals.push({
            entity,
            relation: "payment_terms",
            value: m[1]!,
            validFrom: m[2]!,
            sourceChunk: block.id,
          });
        }
      }
    }
    for (const re of RENT_PATTERNS) {
      for (const m of block.text.matchAll(re)) {
        // the landlord's name only appears in the attached lease document,
        // which is part of the same thread input; grounding accepts entities
        // present anywhere in the thread text
        const landlord = LANDLORD_RE.exec(prompt);
        if (!landlord) continue;
        proposals.push({
          entity: landlord[1]!,
          relation: "monthly_rent",
          value: m[1]!,
          validFrom: m[2]!,
          sourceChunk: block.id,
        });
      }
    }
  }
  return JSON.stringify(proposals);
}

// ------------------------------------------------------------- normalization

function normalizeTerms(v: unknown): string | null {
  return typeof v === "string" ? v.toUpperCase().replace(/\s+/g, "") : null;
}

function moneyCents(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^\$([\d,]+)\.(\d{2})$/.exec(v);
  if (!m) return null;
  return Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2]);
}

// ----------------------------------------------------------------- the test

describe("extraction bench: temporal questions via extractFacts + asOf", () => {
  let dir: string;
  let dk: Docket;
  let questions: Question[] = [];

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

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "docket-extract-bench-"));
    dk = await Docket.open(dir); // no embedder: fully deterministic
    await dk.ingest.dir(MESSAGES_DIR);
    questions = readJsonl<Question>(join(FIXTURE, "questions.jsonl"));
  }, 120_000);

  afterAll(() => {
    dk?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers all category 3 questions correctly with cited, grounded facts", async () => {
    const report = await dk.extractFacts({ complete: extractionModel });
    expect(report.skipped).toBe(0);
    expect(report.threads).toBeGreaterThan(0);
    expect(report.asserted).toBeGreaterThan(0);
    console.log(
      `extract report: threads=${report.threads} proposed=${report.proposed}` +
        ` asserted=${report.asserted} rejected=${report.rejected}`,
    );

    const cat3 = questions.filter((q) => q.category === 3);
    expect(cat3).toHaveLength(4);

    // the landlord entity is discovered from the extracted facts themselves,
    // not from ground truth: it is whatever entity carries monthly_rent
    const rentEntities = withRoDb((db) =>
      db
        .prepare("SELECT DISTINCT entity FROM facts WHERE relation = 'monthly_rent' ORDER BY entity")
        .all(),
    ) as Array<{ entity: string }>;
    expect(rentEntities).toHaveLength(1);
    const landlord = rentEntities[0]!.entity;

    let correct = 0;
    for (const q of cat3) {
      const asOf = q.params["as_of"] ?? "";
      expect(asOf).not.toBe("");

      if (q.template === "terms_as_of") {
        const party = /payment terms with (.+?) as of/.exec(q.text)?.[1] ?? "";
        expect(party).not.toBe("");
        const fact = dk.facts.asOf(party, "payment_terms", asOf);
        expect(fact, `${q.question_id}: asOf(${party}) answers`).not.toBeNull();
        if (!fact) continue;
        expect(fact.sourceChunk).not.toBeNull();
        const source = dk.tools.getSource(fact.sourceChunk!);
        expect(source?.text.toLowerCase()).toContain(String(fact.value).toLowerCase());
        if (normalizeTerms(fact.value) === q.answer.value) correct++;
      } else if (q.template === "rent_as_of") {
        const fact = dk.facts.asOf(landlord, "monthly_rent", asOf);
        expect(fact, `${q.question_id}: asOf(${landlord}) answers`).not.toBeNull();
        if (!fact) continue;
        expect(fact.sourceChunk).not.toBeNull();
        const source = dk.tools.getSource(fact.sourceChunk!);
        expect(source?.text).toContain(String(fact.value));
        const expected = q.answer.value as { amount_cents: number };
        if (moneyCents(fact.value) === expected.amount_cents) correct++;
      }
    }

    console.log(`temporal questions correct: ${correct}/${cat3.length}`);
    expect(correct).toBe(4); // equal accuracy with the e2e regex path
  }, 120_000);

  it("re-running extraction is a no-op: every thread skips, ledger unchanged", async () => {
    const before = withRoDb(
      (db) => (db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n,
    );
    const report = await dk.extractFacts({ complete: extractionModel });
    expect(report.threads).toBe(0);
    expect(report.asserted).toBe(0);
    const after = withRoDb(
      (db) => (db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n,
    );
    expect(after).toBe(before);
  }, 60_000);
});
