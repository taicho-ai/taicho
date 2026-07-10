import { Database } from "bun:sqlite";
import { join } from "node:path";
import { migrate } from "./migrate";

/** Embedded store: derived state only (registry cache, embeddings, indexes).
 *  Files are canon — deleting the DB and re-indexing must always work. */
export function openDb(workspace: string): Database {
  const db = new Database(join(workspace, "taicho.db"), { create: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- team (Plan 19) is declared here for a FRESH workspace only. CREATE TABLE IF NOT EXISTS cannot add
    -- a column to a table that already exists, so every pre-Plan-19 database gets it from migration v8's
    -- guarded ALTER instead. Both must be present and both idempotent: baseline alone would silently
    -- skip existing workspaces, ALTER alone would throw "duplicate column" on new ones.
    CREATE TABLE IF NOT EXISTS registry (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, is_root INTEGER DEFAULT 0, team TEXT
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      ref TEXT PRIMARY KEY,            -- policy/exemplar id or expansion key
      kind TEXT NOT NULL,              -- 'policy' | 'exemplar'
      vec BLOB NOT NULL                -- float32 array (brute-force cosine in v0; sqlite-vec later)
    );
    CREATE TABLE IF NOT EXISTS task_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_hash TEXT NOT NULL,         -- dedup key for equivalent in-flight tasks
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'claimed',  -- claimed | done | blocked
      run_id TEXT,
      created INTEGER DEFAULT (unixepoch())
    );
  `);
  migrate(db); // versioned tables on top of the baseline (kb_nodes/kb_edges, meta)
  return db;
}
