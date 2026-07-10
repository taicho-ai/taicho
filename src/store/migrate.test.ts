import { test, expect } from "bun:test";
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

test("v7 leaves a fresh DB with squad_spend (v6's deck_spend renamed) and bumps SCHEMA_VERSION to 7", () => {
  const db = openDb(ws());
  expect(SCHEMA_VERSION).toBe(7);
  expect(getMeta(db, "schema_version")).toBe("7");
  expect(() => db.query("SELECT period_kind, period_key, tokens, cost_usd, updated FROM squad_spend").all()).not.toThrow();
  expect(() => db.query("SELECT * FROM deck_spend").all()).toThrow(); // the old name is gone
});

/** Rewind a current DB to look like one written by a pre-Plan-19 taicho: the counter table under its old
 *  name, kb rows scoped 'deck', schema_version pinned at 6. This is the ONLY shape that exercises v7 —
 *  a fresh DB never has legacy rows, so testing against openDb() alone would pass while every real
 *  workspace broke. */
function rewindToV6(db: ReturnType<typeof openDb>) {
  db.exec("ALTER TABLE squad_spend RENAME TO deck_spend");
  db.query("INSERT INTO deck_spend (period_kind, period_key, tokens, cost_usd) VALUES ('day', '2026-07-01', 4200, 1.5)").run();
  db.query(
    "INSERT INTO kb_nodes (id, kind, title, content, scope) VALUES ('kb_legacy', 'fact', 'T', 'C', 'deck')",
  ).run();
  db.query("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
}

test("v7 migrates a legacy v6 DB: kb scope 'deck' -> 'squad', deck_spend -> squad_spend with rows intact", () => {
  const db = openDb(ws());
  rewindToV6(db);

  migrate(db);

  expect(getMeta(db, "schema_version")).toBe("7");
  // The scope value moved, and the row survived.
  expect((db.query("SELECT scope FROM kb_nodes WHERE id = 'kb_legacy'").get() as { scope: string }).scope).toBe("squad");
  // The counter carried forward — silently resetting someone's running weekly total would be rude.
  const row = db.query("SELECT tokens, cost_usd FROM squad_spend WHERE period_key = '2026-07-01'").get() as { tokens: number; cost_usd: number };
  expect(row.tokens).toBe(4200);
  expect(row.cost_usd).toBeCloseTo(1.5, 6);
  expect(() => db.query("SELECT * FROM deck_spend").all()).toThrow();

  migrate(db); // idempotent — a second boot must not re-run the rename and throw
  expect(getMeta(db, "schema_version")).toBe("7");
});
