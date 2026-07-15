/**
 * Single source of DDL for the whole engine. Modules never issue CREATE
 * statements of their own.
 *
 * Two table classes (spec section 1): evidence tables are permanent,
 * derived tables (marked below) can be wiped and rebuilt by reindex().
 */
import type { Database } from "better-sqlite3";

/**
 * Version 1 schema, frozen. This string is history: it is replayed verbatim
 * on every fresh database and must never be edited. Later schema changes go
 * in new migration steps below.
 */
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

/**
 * Stepped migrations, one entry per schema version.
 *
 * THE RULE (plan task 1.6): schema changes always append a new migration
 * step. Existing steps are frozen history and are never edited, reordered,
 * or removed. SCHEMA_VERSION moves only by appending a step. Any database
 * ever produced by a released build must migrate forward through these
 * exact steps, so editing an old step silently forks on-disk history.
 */
const MIGRATIONS: ReadonlyArray<{ to: number; up: (db: Database) => void }> = [
  {
    to: 1,
    up: (db) => {
      db.exec(DDL_V1);
    },
  },
  {
    to: 2,
    up: (db) => {
      db.exec(`
-- quarantine: inputs that could not be ingested; raw bytes stay in the CAS
CREATE TABLE IF NOT EXISTS ingest_errors (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  blob_hash TEXT,                        -- null only when bytes could not be stored
  reason    TEXT NOT NULL,               -- parse_error | degenerate | oversize
  detail    TEXT NOT NULL DEFAULT ''
);
`);
    },
  },
  {
    to: 3,
    up: (db) => {
      db.exec(`
-- derived-text cache for attachment parsers (PDF etc). Expensive to
-- recompute, so reindex() keeps it; tombstone purges it; bumping a
-- parser's version key invalidates naturally.
CREATE TABLE IF NOT EXISTS parse_cache (
  blob_hash    TEXT NOT NULL REFERENCES blobs(hash),
  tool         TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  text         TEXT NOT NULL,
  meta_json    TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  PRIMARY KEY (blob_hash, tool, tool_version)
);
`);
    },
  },
  {
    to: 4,
    up: (db) => {
      // embeddings keyed per (chunk, model) so vectors from different
      // embedders coexist; search already filters by model
      db.exec(`
CREATE TABLE embeddings_v4 (
  chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id),
  model    TEXT NOT NULL,
  dim      INTEGER NOT NULL,
  vector   BLOB NOT NULL,
  PRIMARY KEY (chunk_id, model)
);
INSERT INTO embeddings_v4 SELECT chunk_id, model, dim, vector FROM embeddings;
DROP TABLE embeddings;
ALTER TABLE embeddings_v4 RENAME TO embeddings;
`);
    },
  },
  {
    to: 5,
    up: (db) => {
      db.exec(`
-- cache for expensive (LLM) contextual prefixes, keyed per chunk and
-- contextualizer version. reindex() reuses it; tombstone and
-- replaced-message purges remove it with the content.
CREATE TABLE IF NOT EXISTS context_cache (
  chunk_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  context      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (chunk_id, tool, tool_version)
);
`);
    },
  },
  {
    to: 6,
    up: (db) => {
      // fact extraction audit surface: every run and every rejection is
      // recorded; assertions themselves land in facts with source chunks
      db.exec(`
CREATE TABLE IF NOT EXISTS fact_extract_runs (
  thread_id    TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  thread_hash  TEXT NOT NULL,             -- state hash: re-runs skip unchanged threads
  at           TEXT NOT NULL,
  proposed     INTEGER NOT NULL,
  asserted     INTEGER NOT NULL,
  rejected     INTEGER NOT NULL,
  PRIMARY KEY (thread_id, tool_version, thread_hash)
);

CREATE TABLE IF NOT EXISTS fact_extract_rejects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  reason       TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
`);
    },
  },
  {
    to: 7,
    up: (db) => {
      // entity-resolution suggestions are recomputed on demand; only the
      // human decision persists, keyed by the suggestion's content hash
      db.exec(`
CREATE TABLE IF NOT EXISTS party_suggestion_decisions (
  suggestion_id TEXT PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('confirmed', 'dismissed')),
  decided_at    TEXT NOT NULL
);
`);
    },
  },
];

const LAST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1];
if (LAST_MIGRATION === undefined) throw new Error("MIGRATIONS must not be empty");

export const SCHEMA_VERSION = LAST_MIGRATION.to;

/**
 * Tables reindex() may wipe, children before parents so foreign keys hold.
 * Evidence tables are never in this list.
 */
export const DERIVED_TABLES = [
  "embeddings",
  "chunks_fts",
  "chunks",
  "fragments",
  "threads",
] as const;

export function migrate(db: Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} is newer than this build (supports ${SCHEMA_VERSION})`,
    );
  }
  for (const step of MIGRATIONS) {
    if (step.to <= version) continue;
    db.transaction(() => {
      step.up(db);
      db.pragma(`user_version = ${step.to}`);
    })();
  }
}
