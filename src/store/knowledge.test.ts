import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { paths } from "./files";
import { putVector } from "./vectors";
import { KbNode } from "../schemas/knowledge";
import { serializeNode, parseNode, writeNode, readNode, nodeExists, neighbors, reindexKnowledge, mkKbId, resolveNodeIds, forgetNodes, reembedAll } from "./knowledge";

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
