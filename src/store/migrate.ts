/** Minimal versioned schema migrator for the derived SQLite cache. The DB holds derived state only
 *  (files are canon — deleting the DB and re-indexing must always work), so migrations just create
 *  tables/indexes; a `meta` row tracks the applied version. Run once in openDb after the baseline. */
import type { Database } from "bun:sqlite";

export function getMeta(db: Database, key: string): string | null {
  const r = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return r?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

interface Migration { version: number; up: (db: Database) => void; }

const MIGRATIONS: Migration[] = [
  // v1: baseline — registry/embeddings/task_ledger already created by openDb's `CREATE TABLE IF NOT EXISTS`.
  { version: 1, up: () => {} },
  // v2: knowledgebase graph — typed nodes + typed edges. Embeddings reuse the existing table (kind='kb').
  {
    version: 2,
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS kb_nodes (
          id       TEXT PRIMARY KEY,
          kind     TEXT NOT NULL,
          title    TEXT NOT NULL,
          summary  TEXT,
          content  TEXT NOT NULL,
          source   TEXT,
          scope    TEXT NOT NULL DEFAULT 'deck',
          metadata TEXT,
          created  INTEGER DEFAULT (unixepoch()),
          updated  INTEGER DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS kb_edges (
          from_id  TEXT NOT NULL,
          to_id    TEXT NOT NULL,
          rel      TEXT NOT NULL,
          weight   REAL DEFAULT 1.0,
          metadata TEXT,
          created  INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (from_id, to_id, rel)
        );
        CREATE INDEX IF NOT EXISTS kb_edges_from ON kb_edges(from_id);
        CREATE INDEX IF NOT EXISTS kb_edges_to   ON kb_edges(to_id);
        CREATE INDEX IF NOT EXISTS kb_nodes_kind ON kb_nodes(kind);
      `),
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const cur = Number(getMeta(db, "schema_version") ?? "0");
  for (const m of MIGRATIONS) {
    if (m.version > cur) {
      db.transaction(() => m.up(db))();
      setMeta(db, "schema_version", String(m.version));
    }
  }
}

/** Guard against mixing embedding models/dimensions: if the active embedder changed, wipe stale kb
 *  vectors so cosine never compares incompatible spaces. Safe — embeddings are a derived cache that
 *  re-fills lazily on the next remember/recall. */
export function ensureEmbedSpace(db: Database, model: string, dim: number): void {
  const pm = getMeta(db, "embed_model");
  const pd = Number(getMeta(db, "embed_dim") ?? "0");
  if (pm !== model || pd !== dim) {
    db.query("DELETE FROM embeddings WHERE kind = 'kb'").run();
    setMeta(db, "embed_model", model);
    setMeta(db, "embed_dim", String(dim));
  }
}
