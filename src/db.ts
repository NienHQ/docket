import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { migrate } from "./schema.js";

export interface DocketDb {
  db: Database;
  dir: string;
  objectsDir: string;
  /** true when sqlite-vec loaded; vector search falls back to a scan otherwise */
  hasVec: boolean;
}

export function openDb(dir: string): DocketDb {
  mkdirSync(dir, { recursive: true });
  const objectsDir = join(dir, "objects");
  mkdirSync(objectsDir, { recursive: true });
  const db = new DatabaseCtor(join(dir, "docket.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  let hasVec = false;
  try {
    const require = createRequire(import.meta.url);
    const vec = require("sqlite-vec") as { load(db: Database): void };
    vec.load(db);
    hasVec = true;
  } catch {
    hasVec = false; // optional dependency; scan fallback handles vector search
  }
  return { db, dir, objectsDir, hasVec };
}

export function nowIso(): string {
  return new Date().toISOString();
}
