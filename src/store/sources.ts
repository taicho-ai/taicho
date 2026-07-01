/** Source-document discovery + hash tracking. Files in kb/sources/ are admin-authored inputs; each
 *  is hashed so the librarian re-extracts only what changed. Mirrors store/knowledge.ts (files canon,
 *  kb_sources = derived index of last-synced hashes). */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./files";

const SOURCE_EXT = /\.(md|txt)$/i;

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export interface DiscoveredSource { path: string; content: string; hash: string }

export function listSourceFiles(ws: string): DiscoveredSource[] {
  const dir = paths.kbSourceDir(ws);
  if (!existsSync(dir)) return [];
  const out: DiscoveredSource[] = [];
  for (const name of readdirSync(dir)) {
    if (!SOURCE_EXT.test(name)) continue;
    try {
      const content = readFileSync(join(dir, name), "utf8");
      out.push({ path: `sources/${name}`, content, hash: hashContent(content) });
    } catch (e) { console.error(`skipping source ${name}: ${String(e)}`); }
  }
  return out;
}

export function readTrackedSources(db: Database): Map<string, string> {
  const rows = db.query("SELECT path, hash FROM kb_sources").all() as { path: string; hash: string }[];
  return new Map(rows.map((r) => [r.path, r.hash]));
}

export function upsertSourceHash(db: Database, path: string, hash: string): void {
  db.query(
    "INSERT INTO kb_sources (path, hash, updated) VALUES (?, ?, unixepoch()) " +
    "ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, updated = unixepoch()",
  ).run(path, hash);
}

export function deleteSourceHash(db: Database, path: string): void {
  db.query("DELETE FROM kb_sources WHERE path = ?").run(path);
}

export interface SourceDiff { changed: DiscoveredSource[]; deleted: string[] }

export function diffSources(ws: string, db: Database): SourceDiff {
  const tracked = readTrackedSources(db);
  const onDisk = listSourceFiles(ws);
  const seen = new Set(onDisk.map((s) => s.path));
  const changed = onDisk.filter((s) => tracked.get(s.path) !== s.hash);
  const deleted = [...tracked.keys()].filter((p) => !seen.has(p));
  return { changed, deleted };
}
