/** Deck knowledgebase store: one file per node at kb/nodes/<kb_id>.md (YAML frontmatter = the node
 *  minus `content`, body = content). Files are canon; kb_nodes/kb_edges in SQLite are a rebuildable
 *  index. Mirrors store/policy.ts + store/roster.ts. */
import { YAML } from "bun";
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { KbNode } from "../schemas/knowledge";
import { paths } from "./files";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function mkKbId(): string {
  return "kb_" + Math.random().toString(36).slice(2, 10);
}

export function serializeNode(n: KbNode): string {
  const { content, ...meta } = n;
  return `---\n${YAML.stringify(meta, null, 2)}\n---\n${content}\n`;
}

export function parseNode(text: string): KbNode {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("knowledge node missing YAML frontmatter");
  const meta = YAML.parse(m[1]) as Record<string, unknown>;
  return KbNode.parse({ ...meta, content: m[2].trim() });
}

/** Write a node's canonical file, then (re)index it into kb_nodes/kb_edges. */
export function writeNode(ws: string, db: Database, node: KbNode): void {
  mkdirSync(paths.kbNodeDir(ws), { recursive: true });
  writeFileSync(paths.kbNodeFile(ws, node.id), serializeNode(node));
  indexNode(db, node);
}

export function readNode(ws: string, id: string): KbNode | null {
  const f = paths.kbNodeFile(ws, id);
  if (!existsSync(f)) return null;
  try { return parseNode(readFileSync(f, "utf8")); } catch { return null; }
}

export function listNodes(ws: string): KbNode[] {
  const dir = paths.kbNodeDir(ws);
  if (!existsSync(dir)) return [];
  const out: KbNode[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try { out.push(parseNode(readFileSync(join(dir, f), "utf8"))); }
    catch (e) { console.error(`skipping kb node ${f}: ${String(e)}`); }
  }
  return out;
}

export function nodeExists(db: Database, id: string): boolean {
  return !!db.query("SELECT 1 FROM kb_nodes WHERE id = ?").get(id);
}

/** Upsert a node row and replace its outgoing edges. */
export function indexNode(db: Database, n: KbNode): void {
  db.query(
    `INSERT INTO kb_nodes (id, kind, title, summary, content, source, scope, metadata, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       kind=excluded.kind, title=excluded.title, summary=excluded.summary, content=excluded.content,
       source=excluded.source, scope=excluded.scope, metadata=excluded.metadata, updated=unixepoch()`,
  ).run(n.id, n.kind, n.title, n.summary ?? null, n.content, n.source ?? null, n.scope, n.metadata ? JSON.stringify(n.metadata) : null);
  db.query("DELETE FROM kb_edges WHERE from_id = ?").run(n.id);
  const ins = db.query("INSERT OR IGNORE INTO kb_edges (from_id, to_id, rel, weight, metadata) VALUES (?, ?, ?, ?, ?)");
  for (const e of n.edges) ins.run(n.id, e.to, e.rel, e.weight, e.metadata ? JSON.stringify(e.metadata) : null);
}

export interface KbRow { id: string; kind: string; title: string; summary: string | null; content: string; }

export function getNodes(db: Database, ids: string[]): Map<string, KbRow> {
  const out = new Map<string, KbRow>();
  if (!ids.length) return out;
  const placeholders = ids.map(() => "?").join(",");
  for (const r of db.query(`SELECT id, kind, title, summary, content FROM kb_nodes WHERE id IN (${placeholders})`).all(...ids) as KbRow[]) {
    out.set(r.id, r);
  }
  return out;
}

/** N-hop neighbors of a seed set, walking edges in BOTH directions, keeping each node's min depth.
 *  Optionally restricted to specific edge relations. Excludes the seeds themselves. */
export function neighbors(db: Database, seedIds: string[], hops: number, rels?: string[]): { id: string; depth: number }[] {
  if (seedIds.length === 0 || hops <= 0) return [];
  const seedJson = JSON.stringify(seedIds);
  const relFilter = rels && rels.length ? `AND e.rel IN (${rels.map(() => "?").join(",")})` : "";
  const sql = `
    WITH RECURSIVE reach(id, depth) AS (
      SELECT value, 0 FROM json_each(?)
      UNION
      SELECT CASE WHEN e.from_id = r.id THEN e.to_id ELSE e.from_id END, r.depth + 1
      FROM reach r JOIN kb_edges e ON (e.from_id = r.id OR e.to_id = r.id)
      WHERE r.depth < ? ${relFilter}
    )
    SELECT id, MIN(depth) AS depth FROM reach
    WHERE id NOT IN (SELECT value FROM json_each(?))
    GROUP BY id`;
  const params = [seedJson, hops, ...(rels && rels.length ? rels : []), seedJson];
  return db.query(sql).all(...params) as { id: string; depth: number }[];
}

/** Rebuild the kb_nodes/kb_edges index from the canonical files (proves files-are-canon). */
export function reindexKnowledge(ws: string, db: Database): void {
  db.exec("DELETE FROM kb_edges; DELETE FROM kb_nodes;");
  for (const n of listNodes(ws)) indexNode(db, n);
}

export interface NodeFilter { ids?: string[]; kind?: string; sourcePrefix?: string }

/** Node ids matching a filter. An EMPTY filter matches nothing (never "everything") — a safety
 *  guard so a mis-built prune can't wipe the whole graph. Combine clauses with AND. */
export function resolveNodeIds(db: Database, filter: NodeFilter): string[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.ids?.length) { where.push(`id IN (${filter.ids.map(() => "?").join(",")})`); params.push(...filter.ids); }
  if (filter.kind) { where.push("kind = ?"); params.push(filter.kind); }
  if (filter.sourcePrefix) { where.push("source LIKE ? ESCAPE '\\'"); params.push(likePrefix(filter.sourcePrefix)); }
  if (!where.length) return [];
  return (db.query(`SELECT id FROM kb_nodes WHERE ${where.join(" AND ")}`).all(...params) as { id: string }[]).map((r) => r.id);
}

/** Escape LIKE wildcards in a literal prefix, then append `%`. */
function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

/** Cascade delete: for the matched nodes, remove their edges (both directions), vectors, node rows,
 *  and canonical files — atomically. The single prune path for /kb forget and source re-sync. */
export function forgetNodes(ws: string, db: Database, filter: NodeFilter): { removedNodes: number; removedEdges: number } {
  const ids = resolveNodeIds(db, filter);
  if (!ids.length) return { removedNodes: 0, removedEdges: 0 };
  const ph = ids.map(() => "?").join(",");
  let removedEdges = 0;
  db.transaction(() => {
    removedEdges = (db.query(`SELECT COUNT(*) c FROM kb_edges WHERE from_id IN (${ph}) OR to_id IN (${ph})`).get(...ids, ...ids) as { c: number }).c;
    db.query(`DELETE FROM kb_edges WHERE from_id IN (${ph}) OR to_id IN (${ph})`).run(...ids, ...ids);
    db.query(`DELETE FROM embeddings WHERE kind = 'kb' AND ref IN (${ph})`).run(...ids);
    db.query(`DELETE FROM kb_nodes WHERE id IN (${ph})`).run(...ids);
  })();
  for (const id of ids) { try { rmSync(paths.kbNodeFile(ws, id)); } catch { /* file already gone */ } }
  return { removedNodes: ids.length, removedEdges };
}
