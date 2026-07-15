/**
 * Regenerates the committed schema-version-1 fixture database at
 * tests/fixtures/db-v1/docket.db.
 *
 * The committed binary is the artifact of record: migration tests run
 * against that exact file, not against the output of this script. The
 * script exists so the fixture can be audited and regenerated if it is
 * ever lost. It inlines the frozen v1 DDL on purpose (a v1 database must
 * look like what version-1 builds produced, independent of src/schema.ts).
 *
 * Run from the repo root: node scripts/make-v1-fixture.mjs
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const DDL_V1 = `
-- evidence: immutable content-addressed blobs
CREATE TABLE IF NOT EXISTS blobs (
  hash        TEXT PRIMARY KEY,          -- sha256 hex of raw bytes
  size        INTEGER NOT NULL,
  mime        TEXT NOT NULL,
  created_at  TEXT NOT NULL,             -- ISO8601, first time seen
  tombstoned  INTEGER NOT NULL DEFAULT 0
);

-- evidence: where each blob came from (N sources may share one blob)
CREATE TABLE IF NOT EXISTS blob_sources (
  hash       TEXT NOT NULL REFERENCES blobs(hash),
  kind       TEXT NOT NULL CHECK (kind IN ('message', 'attachment')),
  message_id TEXT NOT NULL,              -- RFC5322 Message-ID (angle brackets stripped)
  att_index  INTEGER NOT NULL DEFAULT -1, -- -1 for the message itself
  filename   TEXT,
  PRIMARY KEY (hash, message_id, att_index)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id      TEXT PRIMARY KEY,      -- RFC5322 Message-ID, brackets stripped
  blob_hash       TEXT NOT NULL REFERENCES blobs(hash),
  thread_id       TEXT,                  -- derived by JWZ pass, thr_<hash>
  subject         TEXT NOT NULL DEFAULT '',
  from_name       TEXT NOT NULL DEFAULT '',
  from_address    TEXT NOT NULL DEFAULT '',
  sent_at         TEXT,                  -- ISO8601 or null
  in_reply_to     TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  body_text       TEXT NOT NULL DEFAULT '' -- decoded text/plain body (derived, kept for spans)
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_address);
CREATE INDEX IF NOT EXISTS idx_messages_sent ON messages(sent_at);

CREATE TABLE IF NOT EXISTS message_recipients (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  name       TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('to', 'cc', 'bcc')),
  PRIMARY KEY (message_id, address, kind)
);

CREATE TABLE IF NOT EXISTS attachments (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  att_index  INTEGER NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  blob_hash  TEXT NOT NULL REFERENCES blobs(hash),
  PRIMARY KEY (message_id, att_index)
);

-- derived: thread registry (rebuildable from message headers)
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  subject   TEXT NOT NULL DEFAULT '',
  first_at  TEXT,
  last_at   TEXT
);

-- derived: quote/signature stripped message parts
CREATE TABLE IF NOT EXISTS fragments (
  fragment_id TEXT PRIMARY KEY,          -- frg_<messageRowHash>_<n>
  message_id  TEXT NOT NULL REFERENCES messages(message_id),
  kind        TEXT NOT NULL CHECK (kind IN ('new', 'quote', 'signature')),
  span_start  INTEGER NOT NULL,          -- char offsets into messages.body_text
  span_end    INTEGER NOT NULL,
  text        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fragments_message ON fragments(message_id);

-- evidence-adjacent: logical business documents, version chains
CREATE TABLE IF NOT EXISTS documents (
  doc_id        TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  root_id       TEXT NOT NULL,
  version       INTEGER NOT NULL,
  supersedes    TEXT,
  party_id      TEXT,
  blob_hash     TEXT REFERENCES blobs(hash),
  issued_date   TEXT,
  fields_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_documents_root ON documents(root_id, version);

-- derived: retrieval chunks
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id    TEXT PRIMARY KEY,          -- chk_<blobHash>_<n>
  blob_hash   TEXT NOT NULL REFERENCES blobs(hash),
  chunk_index INTEGER NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'attachment')),
  message_id  TEXT,                      -- set for both kinds when known
  span_start  INTEGER NOT NULL,          -- char offsets into the decoded source text
  span_end    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  context     TEXT NOT NULL DEFAULT '',  -- contextual prefix, stored separately
  meta_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_chunks_blob ON chunks(blob_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_message ON chunks(message_id);

-- derived: FTS over context + text
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  context,
  text,
  tokenize = 'porter unicode61'
);

-- derived: chunk embeddings (optional)
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(chunk_id),
  model    TEXT NOT NULL,
  dim      INTEGER NOT NULL,
  vector   BLOB NOT NULL                 -- float32 little-endian
);

-- fact ledger: bi-temporal, append-only
CREATE TABLE IF NOT EXISTS facts (
  fact_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity         TEXT NOT NULL,
  relation       TEXT NOT NULL,
  value_json     TEXT NOT NULL,
  valid_from     TEXT NOT NULL,          -- event time, ISO8601 date
  valid_to       TEXT,                   -- null = still valid
  created_at     TEXT NOT NULL,          -- ingestion time, ISO8601
  expired_at     TEXT,                   -- null = current belief
  source_chunk   TEXT,
  source_message TEXT,
  CHECK (source_chunk IS NOT NULL OR source_message IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(entity, relation, valid_from);

-- entities
CREATE TABLE IF NOT EXISTS parties (
  party_id TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'company',
  notes    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS party_addresses (
  address   TEXT NOT NULL,
  party_id  TEXT NOT NULL REFERENCES parties(party_id),
  person    TEXT NOT NULL DEFAULT '',
  from_date TEXT,                        -- null = open start
  to_date   TEXT,                        -- null = open end
  PRIMARY KEY (address, party_id, from_date)
);
CREATE INDEX IF NOT EXISTS idx_party_addresses_party ON party_addresses(party_id);

-- append-only audit trail for destructive operations
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  action  TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);
`;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, "..", "tests", "fixtures", "db-v1");
const outPath = join(outDir, "docket.db");

mkdirSync(outDir, { recursive: true });
rmSync(outPath, { force: true });
rmSync(outPath + "-wal", { force: true });
rmSync(outPath + "-shm", { force: true });

const db = new Database(outPath);
// small page size keeps the committed binary tiny; it changes nothing about
// schema semantics and migration must work regardless of page size
db.pragma("page_size = 512");
db.pragma("foreign_keys = ON");
db.exec(DDL_V1);

// Sample rows migration tests assert survive intact. Values are fixed and
// referenced verbatim by tests/migrations.test.ts; do not change them
// without regenerating expectations there.
db.prepare(
  "INSERT INTO parties (party_id, name, kind, notes) VALUES (?, ?, ?, ?)",
).run("pty_acme", "Acme Corp", "company", "fixture party");

db.prepare(
  "INSERT INTO blobs (hash, size, mime, created_at, tombstoned) VALUES (?, ?, ?, ?, 0)",
).run(
  "a".repeat(64),
  42,
  "message/rfc822",
  "2025-06-01T00:00:00.000Z",
);

db.prepare(
  `INSERT INTO messages
     (message_id, blob_hash, thread_id, subject, from_name, from_address,
      sent_at, in_reply_to, references_json, body_text)
   VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?)`,
).run(
  "fixture-1@example.com",
  "a".repeat(64),
  "thr_fixture",
  "Fixture subject",
  "Fixture Sender",
  "sender@example.com",
  "2025-06-01T00:00:00.000Z",
  "Fixture body text.",
);

db.prepare(
  `INSERT INTO facts
     (entity, relation, value_json, valid_from, valid_to, created_at,
      expired_at, source_chunk, source_message)
   VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`,
).run(
  "pty_acme",
  "payment_terms",
  '"NET30"',
  "2025-06-01",
  "2025-06-01T00:00:00.000Z",
  "fixture-1@example.com",
);

db.prepare(
  "INSERT INTO audit_log (at, action, subject, detail) VALUES (?, ?, ?, ?)",
).run("2025-06-01T00:00:00.000Z", "fixture", "db-v1", "created by make-v1-fixture");

db.pragma("user_version = 1");
db.close();

console.log(`wrote ${outPath}`);
