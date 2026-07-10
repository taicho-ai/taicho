import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { migrate, getMeta, ensureEmbedSpace, SCHEMA_VERSION } from "./migrate";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-mig-"));
const count = (db: ReturnType<typeof openDb>, sql: string) => (db.query(sql).get() as { c: number }).c;

test("openDb migrates to the current schema version and creates the kb tables; migrate is idempotent", () => {
  const db = openDb(ws());
  expect(getMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
  expect(() => db.query("SELECT * FROM kb_nodes").all()).not.toThrow();
  expect(() => db.query("SELECT * FROM kb_edges").all()).not.toThrow();
  migrate(db); // run again — no-op, version unchanged
  expect(getMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
});

test("ensureEmbedSpace wipes kb vectors when the model/dim changes, and no-ops when unchanged", () => {
  const db = openDb(ws());
  db.query("INSERT INTO embeddings (ref, kind, vec) VALUES ('kb_1', 'kb', ?)").run(new Uint8Array([1, 2, 3, 4]));
  ensureEmbedSpace(db, "m1", 384); // none -> m1: wipe stale
  expect(count(db, "SELECT COUNT(*) c FROM embeddings WHERE kind='kb'")).toBe(0);

  db.query("INSERT INTO embeddings (ref, kind, vec) VALUES ('kb_2', 'kb', ?)").run(new Uint8Array([1, 2, 3, 4]));
  ensureEmbedSpace(db, "m1", 384); // unchanged: keep
  expect(count(db, "SELECT COUNT(*) c FROM embeddings WHERE kind='kb'")).toBe(1);

  ensureEmbedSpace(db, "m2", 384); // model changed: wipe
  expect(count(db, "SELECT COUNT(*) c FROM embeddings WHERE kind='kb'")).toBe(0);
});

test("v3 creates kb_sources (still exists in later versions)", () => {
  const db = openDb(ws());
  expect(() => db.query("SELECT path, hash, updated FROM kb_sources").all()).not.toThrow();
});

test("v4 creates the skills table", () => {
  const db = openDb(ws());
  expect(() => db.query("SELECT id, name, description, tags, status, body FROM skills").all()).not.toThrow();
});

test("v5 creates the tasks index table", () => {
  const db = openDb(ws());
  expect(() => db.query("SELECT id, agent, goal, status, kind, root_run_id, result_ref, summary, created, updated FROM tasks").all()).not.toThrow();
});

test("a fresh DB lands at the current schema: squad_spend (v7), registry.team (v8), plans (v10)", () => {
  const db = openDb(ws());
  expect(SCHEMA_VERSION).toBe(10);
  expect(getMeta(db, "schema_version")).toBe("10");
  expect(() => db.query("SELECT scope, period_kind, period_key, tokens, cost_usd, updated FROM squad_spend").all()).not.toThrow();
  expect(() => db.query("SELECT * FROM deck_spend").all()).toThrow(); // v6's name is gone
  expect(() => db.query("SELECT id, role, is_root, team FROM registry").all()).not.toThrow();
  expect(() => db.query("SELECT id, version, owner, goal, total, done, open, failed FROM plans").all()).not.toThrow();
});

/** Rewind a current DB to look exactly like one written by a pre-Plan-19 taicho: the counter table under
 *  its old name, kb rows scoped 'deck', a registry with NO team column, schema_version pinned at 6.
 *
 *  This is the ONLY shape that exercises v7/v8. A fresh openDb() has no legacy rows and already carries
 *  registry.team from the baseline DDL, so a test written against it would pass while every existing
 *  workspace broke on upgrade. */
function rewindToV6(db: ReturnType<typeof openDb>) {
  // Rebuild the counter as v6 actually wrote it: named deck_spend, and with NO scope column. Renaming
  // the current table would keep v9's shape and quietly under-test the rebuild.
  db.exec("DROP TABLE squad_spend");
  db.exec(`
    CREATE TABLE deck_spend (
      period_kind TEXT NOT NULL,
      period_key  TEXT NOT NULL,
      tokens      INTEGER NOT NULL DEFAULT 0,
      cost_usd    REAL NOT NULL DEFAULT 0,
      updated     INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (period_kind, period_key)
    );
  `);
  db.query("INSERT INTO deck_spend (period_kind, period_key, tokens, cost_usd) VALUES ('day', '2026-07-01', 4200, 1.5)").run();
  db.query("INSERT INTO kb_nodes (id, kind, title, content, scope) VALUES ('kb_legacy', 'fact', 'T', 'C', 'deck')").run();
  // Rebuild registry as v1's baseline wrote it — three columns, no `team`.
  db.exec("DROP INDEX IF EXISTS registry_team");
  db.exec("DROP TABLE registry");
  db.exec("CREATE TABLE registry (id TEXT PRIMARY KEY, role TEXT NOT NULL, is_root INTEGER DEFAULT 0)");
  db.query("INSERT INTO registry (id, role, is_root) VALUES ('root', 'Orchestrator', 1)").run();
  db.query("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
}

test("v7-v10 migrate a legacy v6 DB: kb scope, the spend table, registry.team, and plans", () => {
  const db = openDb(ws());
  rewindToV6(db);
  expect(() => db.query("SELECT team FROM registry").all()).toThrow(); // precondition: genuinely absent

  migrate(db);

  expect(getMeta(db, "schema_version")).toBe("10");
  // v7 — the scope value moved, and the row survived.
  expect((db.query("SELECT scope FROM kb_nodes WHERE id = 'kb_legacy'").get() as { scope: string }).scope).toBe("squad");
  // v7 renamed the table, v9 rebuilt it to widen the primary key — through BOTH, the counter carried
  // forward and landed under the 'squad' scope. Silently resetting a running weekly total would be rude.
  const row = db.query("SELECT scope, tokens, cost_usd FROM squad_spend WHERE period_key = '2026-07-01'").get() as { scope: string; tokens: number; cost_usd: number };
  expect(row.scope).toBe("squad");
  expect(row.tokens).toBe(4200);
  expect(row.cost_usd).toBeCloseTo(1.5, 6);
  expect(() => db.query("SELECT * FROM deck_spend").all()).toThrow();
  // v8 — the ALTER ran, and the existing agent row survived it.
  expect(() => db.query("SELECT team FROM registry").all()).not.toThrow();
  expect((db.query("SELECT team FROM registry WHERE id = 'root'").get() as { team: string | null }).team).toBeNull();

  // v10 — the plan index exists on an upgraded DB too.
  expect(() => db.query("SELECT id, owner FROM plans").all()).not.toThrow();

  migrate(db); // idempotent — a second boot must re-run neither the rename, the ALTER, nor the rebuild
  expect(getMeta(db, "schema_version")).toBe("10");
});

test("migrate() is safe standalone on a bare DB with no baseline tables (registry absent)", () => {
  // spend-ledger.test.ts drives migrate() over a raw in-memory Database. A migration that assumes a
  // baseline table exists would throw there — and v8 touches `registry`, which openDb owns.
  const db = new Database(":memory:");
  expect(() => migrate(db)).not.toThrow();
  expect(getMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
});
