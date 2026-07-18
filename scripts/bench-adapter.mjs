#!/usr/bin/env node
/**
 * PaperTrail-Bench subprocess adapter (papertrail-protocol v1) over Docket's
 * public API. Reads newline-delimited JSON on stdin, answers on stdout, per
 * papertrail-bench/harness/PROTOCOL.md. Build docket first: the adapter
 * imports from dist/ so it exercises exactly what a consumer installs.
 *
 * The adapter sees only messagesDir/attachmentsDir and the question text,
 * never ground truth. Answering mirrors the template families proven in
 * tests/e2e.test.ts, driven through the public tools only.
 *
 * Ablation switches (read from the environment at ingest time):
 *   DOCKET_ABL_EMBEDDER  hash | none   hash = HashEmbedder (fnv1a bag of
 *                                      words, 64 dims) from the embedders
 *                                      subpath; none = FTS only
 *   DOCKET_ABL_CONTEXT   meta | none   none swaps in a contextualizer that
 *                                      returns "" so contextual prefixes are
 *                                      ablated from FTS and embeddings
 *   DOCKET_ABL_LEDGER    1 | 0        1 runs dk.extractFacts after ingest and
 *                                      answers category 3 via facts.asOf
 *   DOCKET_ABL_DEDUPE    1 | 0        hybridSearch dedupe flag
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Docket } from "../dist/index.js";
import { HashEmbedder } from "../dist/embedders/index.js";

const EMBEDDER = process.env.DOCKET_ABL_EMBEDDER ?? "none";
const CONTEXT = process.env.DOCKET_ABL_CONTEXT ?? "meta";
const LEDGER = process.env.DOCKET_ABL_LEDGER === "1";
const DEDUPE = process.env.DOCKET_ABL_DEDUPE !== "0";

const MONEY_SRC = "\\$([0-9][0-9,]*)\\.([0-9]{2})";

/** @type {import("../dist/index.js").Docket | null} */
let dk = null;
/** @type {string | null} */
let dataDir = null;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(s) {
  process.stderr.write(`[docket-adapter] ${s}\n`);
}

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function centsOf(dollars, cents) {
  return Number(dollars.replace(/,/g, "")) * 100 + Number(cents);
}

// ------------------------------------------- deterministic fact extraction
//
// Deterministic stand-in for a model-backed extractor: it pattern-matches
// its own prompt input for the statement shapes the corpus generator emits,
// exactly like the completion used by tests/extract-bench.test.ts. The
// ledger row of the ablation matrix therefore measures the extraction
// pipeline (grounding, validation, asOf) rather than any particular model;
// a real deployment passes a real completion function in its place.

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

/** split the prompt into (chunk id, chunk text) blocks by the bracket markers */
function chunkBlocks(prompt) {
  const re = /\[chunk (chk_[a-z0-9_]+)\] /g;
  const marks = [];
  for (const m of prompt.matchAll(re)) {
    marks.push({ id: m[1], bodyStart: m.index + m[0].length, markStart: m.index });
  }
  return marks.map((mark, i) => {
    const next = marks[i + 1];
    let text = prompt.slice(mark.bodyStart, next ? next.markStart : prompt.length);
    text = text.replace(/\nFrom \S+ on [^\n]*:\s*$/, "");
    return { id: mark.id, text };
  });
}

async function extractionCompletion(prompt) {
  const proposals = [];
  for (const block of chunkBlocks(prompt)) {
    for (const re of TERMS_PATTERNS) {
      for (const m of block.text.matchAll(re)) {
        const between = BETWEEN_RE.exec(block.text);
        if (!between) continue;
        for (const entity of [between[1], between[2]]) {
          proposals.push({
            entity,
            relation: "payment_terms",
            value: m[1],
            validFrom: m[2],
            sourceChunk: block.id,
          });
        }
      }
    }
    for (const re of RENT_PATTERNS) {
      for (const m of block.text.matchAll(re)) {
        // the landlord's name may only appear in the attached lease document,
        // which is part of the same thread input
        const landlord = LANDLORD_RE.exec(prompt);
        if (!landlord) continue;
        proposals.push({
          entity: landlord[1],
          relation: "monthly_rent",
          value: m[1],
          validFrom: m[2],
          sourceChunk: block.id,
        });
      }
    }
  }
  return JSON.stringify(proposals);
}

// --------------------------------------------------------------- answering

function search(query, extra = {}) {
  return dk.tools.hybridSearch({ query, k: 40, dedupe: DEDUPE, ...extra });
}

function messageIdOf(hit) {
  if (hit.messageId !== undefined && hit.messageId !== null) return hit.messageId;
  const src = dk.tools.getSource(hit.chunkId);
  return src?.messageId ?? null;
}

/** citations list: drop nulls, dedupe, keep insertion order */
function cites(...ids) {
  return [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0))];
}

function docIdOf(text) {
  const m = /\b(?:INV|CN|PO)-\d{4}-\d{4}(?:-A\d+)?\b/.exec(text);
  return m ? m[0] : null;
}

/**
 * Find the attachment chunk carrying a structured document: it must contain
 * the document number and the labeled field we intend to parse.
 */
async function findDocChunk(docId, fieldLabel) {
  const hits = await search(docId, { filter: { sourceKind: "attachment" } });
  for (const h of hits) {
    if (h.text.includes(docId) && h.text.includes(fieldLabel)) return h;
  }
  return null;
}

const REFUSE = { answer: null, citations: [] };

/** category 1: parse 'Label: $X' from the document attachment */
async function answerDocMoney(docId, label) {
  const hit = await findDocChunk(docId, `${label}:`);
  if (!hit) return REFUSE;
  const m = new RegExp(`${reEscape(label)}: ${MONEY_SRC}`).exec(hit.text);
  if (!m) return REFUSE;
  return {
    answer: { amount_cents: centsOf(m[1], m[2]), currency: "USD" },
    citations: cites(docId, messageIdOf(hit)),
  };
}

/** category 1: parse a labeled scalar field from the document attachment */
async function answerDocField(docId, label, valueRe) {
  const hit = await findDocChunk(docId, `${label}:`);
  if (!hit) return REFUSE;
  const m = valueRe.exec(hit.text);
  if (!m || m[1] === undefined) return REFUSE;
  return { answer: m[1], citations: cites(docId, messageIdOf(hit)) };
}

/**
 * category 2: collect every version id sharing the PO root from search hit
 * texts and contexts, ordered root first then A1, A2, ...
 */
async function poChain(rootParam) {
  const root = rootParam.replace(/-A\d+$/, "");
  const hits = await search(root);
  const versions = new Set([0]); // the root always exists
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

/** doc ids of every chain version plus the message carrying the final one */
async function chainCitations(chain) {
  const finalId = chain[chain.length - 1];
  const hit = finalId ? await findDocChunk(finalId, "Po number:") : null;
  return cites(...chain, hit ? messageIdOf(hit) : null);
}

async function answerFinalQuantity(root) {
  const chain = await poChain(root);
  const finalId = chain[chain.length - 1];
  if (finalId === undefined) return REFUSE;
  const hit = await findDocChunk(finalId, "Qty:");
  if (!hit) return REFUSE;
  const m = /Qty: (\d+)/.exec(hit.text);
  if (!m) return REFUSE;
  return { answer: Number(m[1]), citations: cites(finalId, messageIdOf(hit)) };
}

function normalizeTerms(v) {
  return typeof v === "string" ? v.toUpperCase().replace(/\s+/g, "") : null;
}

function moneyCents(v) {
  if (typeof v !== "string") return null;
  const m = /^\$([\d,]+)\.(\d{2})$/.exec(v);
  return m ? centsOf(m[1], m[2]) : null;
}

/** map a fact's source chunk to a message-id citation via getSource */
function factCitations(fact) {
  if (fact.sourceChunk === null) return cites(fact.sourceMessage);
  const src = dk.tools.getSource(fact.sourceChunk);
  return cites(src?.messageId ?? fact.sourceMessage);
}

/** category 3 with the ledger: extraction already ran, so this is asOf only */
function answerAsOfLedger(relation, entity, asOf) {
  const fact = dk.facts.asOf(entity, relation, asOf);
  if (!fact) return REFUSE;
  if (relation === "monthly_rent") {
    const cents = moneyCents(fact.value);
    if (cents === null) return REFUSE;
    return {
      answer: { amount_cents: cents, currency: "USD" },
      citations: factCitations(fact),
    };
  }
  return { answer: normalizeTerms(fact.value), citations: factCitations(fact) };
}

/**
 * category 3 without the ledger: search, regex-extract (value, effective
 * date) pairs, pick the latest effective date at or before the as-of date.
 */
async function answerAsOfSearch(relation, partyName, asOf) {
  const probe =
    relation === "payment_terms"
      ? `${partyName} payment terms`
      : "monthly rent effective revised";
  const hits = await search(probe);

  const patterns = relation === "payment_terms" ? TERMS_PATTERNS : RENT_PATTERNS;
  const found = []; // { value, validFrom, hit }
  const seen = new Set();
  for (const h of hits) {
    const relevant =
      relation === "payment_terms"
        ? h.text.toLowerCase().includes(partyName.toLowerCase())
        : /monthly rent/i.test(h.text);
    if (!relevant) continue;
    for (const re of patterns) {
      for (const m of h.text.matchAll(re)) {
        const key = `${m[1]}|${m[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ value: m[1], validFrom: m[2], hit: h });
      }
    }
  }

  const eligible = found
    .filter((f) => f.validFrom <= asOf)
    .sort((a, b) =>
      a.validFrom === b.validFrom
        ? a.value.localeCompare(b.value)
        : a.validFrom.localeCompare(b.validFrom),
    );
  const best = eligible[eligible.length - 1];
  if (!best) return REFUSE;
  if (relation === "monthly_rent") {
    const cents = moneyCents(best.value);
    if (cents === null) return REFUSE;
    return {
      answer: { amount_cents: cents, currency: "USD" },
      citations: cites(messageIdOf(best.hit)),
    };
  }
  return { answer: normalizeTerms(best.value), citations: cites(messageIdOf(best.hit)) };
}

/** the landlord party is discovered from the extracted facts, never assumed */
function rentEntityFromLedger() {
  const rows = dk.tools.sqlFilter({
    table: "facts",
    where: [{ column: "relation", op: "=", value: "monthly_rent" }],
    limit: 500,
  });
  const entities = [...new Set(rows.map((r) => r.entity))].sort();
  return entities.length === 1 ? entities[0] : null;
}

/** template families are recognized from the question text alone */
async function answerQuestion(text) {
  const asOfMatch = /as of (\d{4}-\d{2}-\d{2})/.exec(text);

  if (/total amount of invoice/i.test(text)) {
    const docId = docIdOf(text);
    return docId ? answerDocMoney(docId, "Total") : REFUSE;
  }
  if (/amount of credit note/i.test(text)) {
    const docId = docIdOf(text);
    return docId ? answerDocMoney(docId, "Amount") : REFUSE;
  }
  if (/invoice .* due\b/i.test(text)) {
    const docId = docIdOf(text);
    return docId
      ? answerDocField(docId, "Due date", /Due date: (\d{4}-\d{2}-\d{2})/)
      : REFUSE;
  }
  if (/which purchase order does invoice/i.test(text)) {
    const docId = docIdOf(text);
    return docId ? answerDocField(docId, "Po ref", /Po ref: (\S+)/) : REFUSE;
  }
  if (/list every version of purchase order/i.test(text)) {
    const root = docIdOf(text);
    if (!root) return REFUSE;
    const chain = await poChain(root);
    return { answer: chain, citations: await chainCitations(chain) };
  }
  if (/how many times was purchase order .* amended/i.test(text)) {
    const root = docIdOf(text);
    if (!root) return REFUSE;
    const chain = await poChain(root);
    const finalId = chain[chain.length - 1];
    const hit = finalId ? await findDocChunk(finalId, "Po number:") : null;
    return {
      answer: chain.length - 1,
      citations: cites(finalId, hit ? messageIdOf(hit) : null),
    };
  }
  if (/agreed quantity on purchase order/i.test(text)) {
    const root = docIdOf(text);
    return root ? answerFinalQuantity(root) : REFUSE;
  }
  if (/payment terms with (.+?) as of/.test(text) && asOfMatch) {
    const party = /payment terms with (.+?) as of/.exec(text)[1];
    if (LEDGER) return answerAsOfLedger("payment_terms", party, asOfMatch[1]);
    return answerAsOfSearch("payment_terms", party, asOfMatch[1]);
  }
  if (/monthly rent/i.test(text) && asOfMatch) {
    if (LEDGER) {
      const landlord = rentEntityFromLedger();
      if (landlord === null) return REFUSE;
      return answerAsOfLedger("monthly_rent", landlord, asOfMatch[1]);
    }
    return answerAsOfSearch("monthly_rent", "", asOfMatch[1]);
  }
  return REFUSE; // unrecognized question family: refuse rather than guess
}

// ---------------------------------------------------------------- protocol

async function handleIngest(msg) {
  dataDir = mkdtempSync(join(tmpdir(), "docket-bench-adapter-"));
  const options = {};
  if (EMBEDDER === "hash") options.embedder = new HashEmbedder();
  if (CONTEXT === "none") {
    options.contextualizer = {
      tool: "ablation-empty-context",
      version: "1",
      contextualize: async () => "",
    };
  }
  dk = await Docket.open(dataDir, options);
  const results = await dk.ingest.dir(msg.messagesDir);
  log(
    `ingested ${results.length} messages` +
      ` (embedder=${EMBEDDER} context=${CONTEXT} ledger=${LEDGER ? 1 : 0}` +
      ` dedupe=${DEDUPE ? 1 : 0})`,
  );
  if (LEDGER) {
    const report = await dk.extractFacts({ complete: extractionCompletion });
    log(
      `extractFacts: threads=${report.threads} proposed=${report.proposed}` +
        ` asserted=${report.asserted} rejected=${report.rejected}`,
    );
  }
  send({ type: "ready" });
}

async function handleQuestion(msg) {
  let result = REFUSE;
  try {
    result = await answerQuestion(msg.text);
  } catch (err) {
    log(`question ${msg.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    result = REFUSE;
  }
  send({ type: "answer", id: msg.id, answer: result.answer, citations: result.citations });
}

function cleanup() {
  try {
    dk?.close();
  } catch {
    // already closed
  }
  if (dataDir !== null) rmSync(dataDir, { recursive: true, force: true });
}

const rl = createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  queue = queue
    .then(async () => {
      const msg = JSON.parse(trimmed);
      if (msg.type === "ingest") await handleIngest(msg);
      else if (msg.type === "question") await handleQuestion(msg);
      else if (msg.type === "shutdown") {
        cleanup();
        process.exit(0);
      }
    })
    .catch((err) => {
      log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      cleanup();
      process.exit(1);
    });
});

rl.on("close", () => {
  queue = queue.then(() => {
    cleanup();
    process.exit(0);
  });
});
