import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { migrate, SCHEMA_VERSION } from "./schema.js";

export interface OpenDbOptions {
  /** open the database read-only; it must exist and be at the current schema version */
  readonly?: boolean;
}

export interface DocketDb {
  db: Database;
  dir: string;
  objectsDir: string;
  readonly: boolean;
  /** true when sqlite-vec loaded; vector search falls back to a scan otherwise */
  hasVec: boolean;
}

export function openDb(dir: string, opts: OpenDbOptions = {}): DocketDb {
  const readonly = opts.readonly === true;
  const objectsDir = join(dir, "objects");
  if (!readonly) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(objectsDir, { recursive: true });
  }
  const db = new DatabaseCtor(join(dir, "docket.db"), {
    readonly,
    fileMustExist: readonly,
  });
  // one writer, many readers: readers retry briefly instead of failing on
  // a momentarily locked database
  db.pragma("busy_timeout = 5000");
  if (readonly) {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `read-only open requires schema version ${SCHEMA_VERSION}, found ${version}; ` +
          "open a writer once to migrate",
      );
    }
  } else {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
  }
  let hasVec = false;
  try {
    const require = createRequire(import.meta.url);
    const vec = require("sqlite-vec") as { load(db: Database): void };
    vec.load(db);
    hasVec = true;
  } catch {
    hasVec = false; // optional dependency; scan fallback handles vector search
  }
  return { db, dir, objectsDir, readonly, hasVec };
}

export function nowIso(): string {
  return new Date().toISOString();
}
