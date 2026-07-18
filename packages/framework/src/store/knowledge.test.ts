import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { paths } from "./files";
import { putVector } from "./vectors";
import { KbNode } from "@taicho/contracts/knowledge";
import { serializeNode, parseNode, writeNode, readNode, nodeExists, neighbors, reindexKnowledge, mkKbId, resolveNodeIds, forgetNodes, reembedAll, listNodeRows, reconcileKbScope } from "./knowledge";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-kb-"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkNode = (over: any = {}) => KbNode.parse({ id: mkKbId(), title: "t", content: "body", created: new Date().toISOString(), ...over });
const count = (db: ReturnType<typeof openDb>, sql: string) => (db.query(sql).get() as { c: number }).c;

test("serialize/parse round-trips a node with typed edges", () => {
  const n = mkNode({ kind: "decision", summary: "s", edges: [{ to: "kb_x", rel: "depends_on" }] });
  const back = parseNode(serializeNode(n));
  expect(back.title).toBe("t");
  expect(back.content).toBe("body");
  expect(back.kind).toBe("decision");
  expect(back.edges[0]).toMatchObject({ to: "kb_x", rel: "depends_on", weight: 1 });
});

test("writeNode persists the canonical file + kb_nodes row + kb_edges", () => {
  const w = ws();
  const db = openDb(w);
  writeNode(w, db, mkNode({ id: "kb_a", title: "Alpha" }));
  writeNode(w, db, mkNode({ id: "kb_b", title: "Beta", edges: [{ to: "kb_a", rel: "depends_on" }] }));
  expect(existsSync(paths.kbNodeFile(w, "kb_a"))).toBe(true);
  expect(nodeExists(db, "kb_a")).toBe(true);
  expect(count(db, "SELECT COUNT(*) c FROM kb_edges")).toBe(1);
  expect(readNode(w, "kb_b")?.title).toBe("Beta");
});

test("neighbors walks typed edges both directions, honoring hops and rel filter", () => {
  const w = ws();
  const db = openDb(w);
  writeNode(w, db, mkNode({ id: "kb_a" }));
  writeNode(w, db, mkNode({ id: "kb_b", edges: [{ to: "kb_a", rel: "depends_on" }] })); // b -> a
  writeNode(w, db, mkNode({ id: "kb_c", edges: [{ to: "kb_b", rel: "relates_to" }] })); // c -> b
  expect(neighbors(db, ["kb_a"], 1).map((r) => r.id).sort()).toEqual(["kb_b"]);            // 1 hop: a↔b
  expect(neighbors(db, ["kb_a"], 2).map((r) => r.id).sort()).toEqual(["kb_b", "kb_c"]);   // 2 hops: reaches c
  expect(neighbors(db, ["kb_a"], 2, ["depends_on"]).map((r) => r.id).sort()).toEqual(["kb_b"]); // only depends_on: can't reach c
});

test("reindexKnowledge rebuilds kb_nodes/kb_edges from files (files are canon)", () => {
  const w = ws();
  const db = openDb(w);
  writeNode(w, db, mkNode({ id: "kb_a" }));
  writeNode(w, db, mkNode({ id: "kb_b", edges: [{ to: "kb_a", rel: "x" }] }));
  db.exec("DELETE FROM kb_nodes; DELETE FROM kb_edges;"); // simulate a blown-away derived DB
  expect(nodeExists(db, "kb_a")).toBe(false);
  reindexKnowledge(w, db);
  expect(nodeExists(db, "kb_a")).toBe(true);
  expect(count(db, "SELECT COUNT(*) c FROM kb_edges")).toBe(1);
});

test("forgetNodes cascades: removes matched nodes, their edges (both dirs), vectors, and files", () => {
  const w = ws();
  const db = openDb(w);
  writeNode(w, db, mkNode({ id: "kb_keep", kind: "fact", source: "worker-y:r1" }));
  writeNode(w, db, mkNode({ id: "kb_dec", kind: "decision", source: "worker-x:r1", edges: [{ to: "kb_keep", rel: "relates_to" }] }));
  writeNode(w, db, mkNode({ id: "kb_ref", kind: "fact", source: "worker-y:r2", edges: [{ to: "kb_dec", rel: "depends_on" }] })); // edge INTO kb_dec
  putVector(db, "kb_dec", "kb", new Float32Array([1, 0, 0]));

  const res = forgetNodes(w, db, { kind: "decision" });
  expect(res.removedNodes).toBe(1);
  expect(res.removedEdges).toBe(2); // kb_dec->kb_keep (out) AND kb_ref->kb_dec (in)
  expect(nodeExists(db, "kb_dec")).toBe(false);
  expect(existsSync(paths.kbNodeFile(w, "kb_dec"))).toBe(false);
  expect(nodeExists(db, "kb_keep")).toBe(true); // untouched
  expect(count(db, "SELECT COUNT(*) c FROM embeddings WHERE ref='kb_dec'")).toBe(0);
  expect(count(db, "SELECT COUNT(*) c FROM kb_edges WHERE from_id='kb_dec' OR to_id='kb_dec'")).toBe(0);
  expect(nodeExists(db, "kb_ref")).toBe(true); // the node that pointed IN to kb_dec still exists
});

test("resolveNodeIds matches by kind, ids, and sourcePrefix", () => {
  const w = ws();
  const db = openDb(w);
  writeNode(w, db, mkNode({ id: "kb_1", kind: "fact", source: "sources/a.md@h1" }));
  writeNode(w, db, mkNode({ id: "kb_2", kind: "fact", source: "worker-x:r1" }));
  expect(resolveNodeIds(db, { kind: "fact" }).sort()).toEqual(["kb_1", "kb_2"]);
  expect(resolveNodeIds(db, { sourcePrefix: "sources/a.md@" })).toEqual(["kb_1"]);
  expect(resolveNodeIds(db, { ids: ["kb_2"] })).toEqual(["kb_2"]);
  expect(resolveNodeIds(db, {})).toEqual([]); // empty filter matches nothing (safety)
});

test("listNodeRows lists all nodes on an empty filter, and filters by kind", () => {
  const w = ws();
  const db = openDb(w);
  writeNode(w, db, mkNode({ id: "kb_1", kind: "fact" }));
  writeNode(w, db, mkNode({ id: "kb_2", kind: "decision" }));
  expect(listNodeRows(db, {}).map((r) => r.id).sort()).toEqual(["kb_1", "kb_2"]); // empty → ALL
  expect(listNodeRows(db, { kind: "decision" }).map((r) => r.id)).toEqual(["kb_2"]);
});

test("reembedAll writes a vector per node from a stubbed embedder", async () => {
  const w = ws();
  const db = openDb(w);
  writeNode(w, db, mkNode({ id: "kb_a", title: "Alpha" }));
  writeNode(w, db, mkNode({ id: "kb_b", title: "Beta" }));
  const embed = async (t: string) => new Float32Array([t.length, 0, 0]); // deterministic stub
  const n = await reembedAll(db, embed);
  expect(n).toBe(2);
  expect(count(db, "SELECT COUNT(*) c FROM embeddings WHERE kind='kb'")).toBe(2);
});

// --- Plan 19 Ph1b: the "deck" -> "squad" scope retirement ------------------------------------------
// The scope is a PERSISTED value: it lives in kb/nodes/*.md frontmatter (canon) and in kb_nodes.scope
// (derived). A workspace written by a pre-Plan-19 taicho must still load, and must end up saying
// "squad" on disk. These three tests cover read, backfill, and idempotence respectively.

/** A node file exactly as a pre-Plan-19 taicho wrote it. */
function writeLegacyNode(ws: string, id: string): string {
  mkdirSync(paths.kbNodeDir(ws), { recursive: true });
  const file = paths.kbNodeFile(ws, id);
  writeFileSync(
    file,
    `---\nid: ${id}\nkind: fact\ntitle: legacy\nscope: deck\nedges: []\ncreated: 2026-07-01T00:00:00.000Z\n---\nlegacy body\n`,
  );
  return file;
}

test("KbScope normalizes the legacy on-disk value: parsing `scope: deck` yields squad", () => {
  const n = parseNode(`---\nid: kb_a\nkind: fact\ntitle: t\nscope: deck\nedges: []\ncreated: 2026-07-01T00:00:00.000Z\n---\nbody\n`);
  expect(n.scope).toBe("squad");
  // and an absent scope still defaults
  const d = parseNode(`---\nid: kb_b\nkind: fact\ntitle: t\nedges: []\ncreated: 2026-07-01T00:00:00.000Z\n---\nbody\n`);
  expect(d.scope).toBe("squad");
});

test("reconcileKbScope rewrites legacy node FILES (files are canon) and reindexes them", () => {
  const w = ws();
  const db = openDb(w);
  const file = writeLegacyNode(w, "kb_legacy");
  expect(readFileSync(file, "utf8")).toContain("scope: deck");

  expect(reconcileKbScope(w, db)).toBe(1);

  const after = readFileSync(file, "utf8");
  expect(after).toContain("scope: squad");
  expect(after).not.toContain("scope: deck");
  expect(after).toContain("legacy body"); // content preserved, not just the frontmatter
  expect((db.query("SELECT scope FROM kb_nodes WHERE id = 'kb_legacy'").get() as { scope: string }).scope).toBe("squad");
});

test("reconcileKbScope is idempotent and a no-op on a workspace with no legacy nodes", () => {
  const w = ws();
  const db = openDb(w);
  writeLegacyNode(w, "kb_legacy");
  expect(reconcileKbScope(w, db)).toBe(1);
  expect(reconcileKbScope(w, db)).toBe(0); // second boot rewrites nothing
  expect(reconcileKbScope(ws(), openDb(ws()))).toBe(0); // empty workspace: no kb dir at all
});
