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

test("v3 creates kb_sources and bumps SCHEMA_VERSION to 3", () => {
  const db = openDb(ws());
  expect(SCHEMA_VERSION).toBe(3);
  expect(getMeta(db, "schema_version")).toBe("3");
  expect(() => db.query("SELECT path, hash, updated FROM kb_sources").all()).not.toThrow();
});
