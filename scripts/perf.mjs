/**
 * Perf harness (plan task 1.3). Generates a deterministic synthetic mail
 * corpus, ingests it through the public Docket API, and reports ingest
 * throughput, on-disk sizes, hybrid search latency, and reindex time.
 *
 * Usage:
 *   pnpm build
 *   node scripts/perf.mjs [--messages 15000] [--out /tmp/dir] [--seed 42]
 *
 * Not a vitest suite on purpose: it measures wall time on real files.
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Docket } from "../dist/index.js";

// ------------------------------------------------------------------ cli args

function parseArgs(argv) {
  const out = { messages: 15000, out: null, seed: 42 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--messages") out.messages = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(out.messages) || out.messages < 1) {
    throw new Error("--messages must be a positive integer");
  }
  return out;
}

// ------------------------------------------------------- seeded random tools

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickFrom = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const intBetween = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive

// -------------------------------------------------------- corpus vocabulary

const WORD_POOL = (
  "invoice payment quarterly ledger shipment pallet freight customs quote " +
  "amendment purchase order revision schedule delivery warehouse manifest " +
  "contract lease renewal deposit escrow settlement wire remittance balance " +
  "reconciliation statement vendor supplier procurement tender bid margin " +
  "discount surcharge tariff duty clearance inspection certificate audit " +
  "compliance retention penalty milestone deliverable specification drawing " +
  "fittings valves gaskets flanges tubing brackets fasteners coating alloy " +
  "steel aluminum copper polymer batch lot serial calibration tolerance " +
  "approval signature countersign notarize execute effective terminate " +
  "extend expire notice cure breach waiver indemnity liability insurance " +
  "premium claim adjuster forecast budget variance accrual amortization " +
  "depreciation payroll headcount onboarding transfer allocation overhead " +
  "utilities maintenance repair downtime capacity throughput backlog " +
  "logistics carrier routing transit demurrage detention container vessel " +
  "booking manifest berth port terminal drayage chassis reefer drybulk"
)
  .split(/\s+/)
  .filter((w) => w.length > 0);

const FIRST_NAMES = [
  "ada", "boris", "carla", "denis", "erin", "farid", "greta", "hugo", "iris",
  "jonas", "karin", "leo", "mira", "nils", "olga", "priya", "quentin", "rosa",
  "sven", "tara",
];
const LAST_NAMES = [
  "alvarez", "brandt", "cole", "duran", "ebert", "fischer", "gupta", "hansen",
  "ivanov", "jensen",
];
const DOMAIN_STEMS = [
  "bluepine", "kestrel", "harborline", "graywolf", "ironbark", "meridian",
  "northgate", "oakfield", "pinnacle", "quarry", "redcedar", "silverbay",
  "timberline", "umbra", "vantage", "westford", "yellowtail", "zephyr",
  "anchor", "basalt", "cinder", "dunmore", "eastvale", "foxglove", "granite",
  "hollow", "ivory", "juniper", "krait", "larkspur", "mistral", "novella",
  "orchard", "pallium", "quill", "rivet", "sable", "tallow", "ursa", "verdant",
];

function buildSenders(rng) {
  const domains = DOMAIN_STEMS.map((s) => `${s}co.example`);
  const senders = [];
  for (let i = 0; i < 200; i++) {
    const first = pickFrom(rng, FIRST_NAMES);
    const last = pickFrom(rng, LAST_NAMES);
    const domain = domains[i % domains.length];
    senders.push({
      name: `${first[0].toUpperCase()}${first.slice(1)} ${last[0].toUpperCase()}${last.slice(1)}`,
      address: `${first}.${last}${i}@${domain}`,
      domain,
    });
  }
  return senders;
}

// ---------------------------------------------------------- email generation

function sentence(rng) {
  const n = intBetween(rng, 6, 14);
  const words = [];
  for (let i = 0; i < n; i++) words.push(pickFrom(rng, WORD_POOL));
  const s = words.join(" ");
  return s[0].toUpperCase() + s.slice(1) + ".";
}

function paragraph(rng) {
  const n = intBetween(rng, 2, 5);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(sentence(rng));
  return parts.join(" ");
}

function body(rng, sender, quoted) {
  const paras = [];
  const n = intBetween(rng, 3, 8);
  for (let i = 0; i < n; i++) paras.push(paragraph(rng));
  let text = paras.join("\n\n");
  if (quoted) {
    const quotedLines = quoted
      .split("\n")
      .slice(0, intBetween(rng, 2, 6))
      .map((l) => `> ${l}`);
    text += `\n\nOn an earlier date, they wrote:\n${quotedLines.join("\n")}`;
  }
  text += `\n\n--\n${sender.name}\n${sender.domain.replace("co.example", "")} operations\n`;
  return text;
}

function asctime(d) {
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    d.getUTCMonth()
  ];
  const p2 = (n) => String(n).padStart(2, "0");
  return `${dow} ${mon} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** Build one RFC822 message; optionally multipart with a text attachment. */
function renderEmail(rng, msg) {
  const headers = [
    `Message-ID: <${msg.messageId}>`,
    `From: ${msg.sender.name} <${msg.sender.address}>`,
    `To: ${msg.to.name} <${msg.to.address}>`,
    `Subject: ${msg.subject}`,
    `Date: ${msg.date.toUTCString()}`,
  ];
  if (msg.inReplyTo) headers.push(`In-Reply-To: <${msg.inReplyTo}>`);
  if (msg.references.length > 0) {
    headers.push(`References: ${msg.references.map((r) => `<${r}>`).join(" ")}`);
  }
  if (!msg.attachment) {
    headers.push("Content-Type: text/plain; charset=utf-8");
    return `${headers.join("\r\n")}\r\n\r\n${msg.body}`;
  }
  const boundary = `b-${msg.messageId.split("@")[0]}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const attBody = `${paragraph(rng)}\n${paragraph(rng)}\n`;
  return [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    msg.body,
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Disposition: attachment; filename="${msg.attachment}"`,
    "",
    attBody,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function generateCorpus(rng, total) {
  const senders = buildSenders(rng);
  const messages = [];
  let clock = Date.UTC(2023, 0, 3, 8, 0, 0);
  let threadIdx = 0;
  while (messages.length < total) {
    const threadLen = Math.min(intBetween(rng, 1, 8), total - messages.length);
    const root = pickFrom(rng, senders);
    const counterpart = pickFrom(rng, senders);
    const subject = `${pickFrom(rng, WORD_POOL)} ${pickFrom(rng, WORD_POOL)} T-${threadIdx}`;
    const chain = [];
    let lastBody = null;
    for (let i = 0; i < threadLen; i++) {
      clock += intBetween(rng, 20, 160) * 60000;
      const sender = i % 2 === 0 ? root : counterpart;
      const to = i % 2 === 0 ? counterpart : root;
      const messageId = `t${threadIdx}-m${i}@${sender.domain}`;
      const withAttachment = rng() < 0.2;
      const msg = {
        messageId,
        sender,
        to,
        subject: i === 0 ? subject : `Re: ${subject}`,
        date: new Date(clock),
        inReplyTo: i === 0 ? null : chain[i - 1],
        references: chain.slice(),
        body: body(rng, sender, i === 0 ? null : lastBody),
        attachment: withAttachment ? `doc-t${threadIdx}-m${i}.txt` : null,
      };
      lastBody = msg.body;
      chain.push(messageId);
      messages.push(msg);
    }
    threadIdx++;
  }
  return messages;
}

function writeMbox(rng, messages, path) {
  const parts = [];
  for (const msg of messages) {
    const raw = renderEmail(rng, msg).replace(/^(>*From )/gm, ">$1");
    parts.push(`From ${msg.sender.address} ${asctime(msg.date)}\n${raw}\n\n`);
  }
  writeFileSync(path, parts.join(""));
}

// ----------------------------------------------------------- measurement kit

function dirSize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else total += statSync(p).size;
    }
  }
  return total;
}

function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

function fmtDuration(ms) {
  if (ms >= 60000) return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(1)}s`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// --------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv);
  const outDir = args.out ?? mkdtempSync(join(tmpdir(), "docket-perf-"));
  mkdirSync(outDir, { recursive: true });
  const dbDir = join(outDir, "appliance");
  const mboxPath = join(outDir, "corpus.mbox");

  console.error(`corpus: ${args.messages} messages, seed ${args.seed}, out ${outDir}`);
  const rng = mulberry32(args.seed);
  const genStart = performance.now();
  const messages = generateCorpus(rng, args.messages);
  writeMbox(rng, messages, mboxPath);
  console.error(
    `generated ${messages.length} messages (${fmtBytes(statSync(mboxPath).size)} mbox) in ${fmtDuration(performance.now() - genStart)}`,
  );

  let dk = await Docket.open(dbDir);
  const ingestStart = performance.now();
  const results = await dk.ingest.mboxFile(mboxPath, {
    batchSize: 500,
    onProgress: (done, total) => {
      if (done % 2500 === 0 || done === total) console.error(`  ingested ${done}/${total}`);
    },
  });
  const ingestMs = performance.now() - ingestStart;
  dk.close(); // checkpoint WAL so the db size is honest

  const dbSize = statSync(join(dbDir, "docket.db")).size;
  const objectsSize = dirSize(join(dbDir, "objects"));

  dk = await Docket.open(dbDir);
  const queryRng = mulberry32(args.seed + 1);
  const latencies = [];
  for (let i = 0; i < 200; i++) {
    const terms = [];
    const n = intBetween(queryRng, 1, 3);
    for (let j = 0; j < n; j++) terms.push(pickFrom(queryRng, WORD_POOL));
    const q = terms.join(" ");
    const t0 = performance.now();
    await dk.tools.hybridSearch({ query: q, k: 10 });
    latencies.push(performance.now() - t0);
  }
  latencies.sort((a, b) => a - b);

  const reindexStart = performance.now();
  await dk.reindex();
  const reindexMs = performance.now() - reindexStart;
  dk.close();

  const rate = (results.length / (ingestMs / 1000)).toFixed(1);
  const rows = [
    ["messages ingested", String(results.length)],
    ["ingest wall time", fmtDuration(ingestMs)],
    ["ingest rate", `${rate} msg/s`],
    ["docket.db size", fmtBytes(dbSize)],
    ["objects/ size", fmtBytes(objectsSize)],
    ["search p50 (200 queries, k=10)", `${percentile(latencies, 50).toFixed(1)} ms`],
    ["search p95", `${percentile(latencies, 95).toFixed(1)} ms`],
    ["search max", `${latencies[latencies.length - 1].toFixed(1)} ms`],
    ["reindex wall time", fmtDuration(reindexMs)],
  ];
  console.log("| metric | value |");
  console.log("| --- | --- |");
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
