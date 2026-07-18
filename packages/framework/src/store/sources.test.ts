import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { paths } from "./files";
import { hashContent, listSourceFiles, diffSources, upsertSourceHash, readTrackedSources } from "./sources";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-src-"));
const write = (w: string, name: string, body: string) => {
  mkdirSync(paths.kbSourceDir(w), { recursive: true });
  writeFileSync(paths.kbSourceFile(w, name), body);
};

test("hashContent is stable and content-sensitive", () => {
  expect(hashContent("hello")).toBe(hashContent("hello"));
  expect(hashContent("hello")).not.toBe(hashContent("world"));
  expect(hashContent("hello")).toHaveLength(12);
});

test("listSourceFiles finds .md/.txt with relative sources/<name> paths", () => {
  const w = ws();
  write(w, "a.md", "alpha");
  write(w, "b.txt", "beta");
  write(w, "ignore.png", "x");
  const found = listSourceFiles(w).map((s) => s.path).sort();
  expect(found).toEqual(["sources/a.md", "sources/b.txt"]);
});

test("diffSources reports new/changed/deleted against kb_sources", () => {
  const w = ws();
  const db = openDb(w);
  write(w, "a.md", "alpha");
  write(w, "b.md", "beta");
  // a.md tracked at an OLD hash (changed); b.md untracked (new); c.md tracked but gone (deleted)
  upsertSourceHash(db, "sources/a.md", "oldhash00000");
  upsertSourceHash(db, "sources/c.md", "deadbeef0000");
  const diff = diffSources(w, db);
  expect(diff.changed.map((c) => c.path).sort()).toEqual(["sources/a.md", "sources/b.md"]);
  expect(diff.deleted).toEqual(["sources/c.md"]);
  expect(readTrackedSources(db).get("sources/a.md")).toBe("oldhash00000");
});
