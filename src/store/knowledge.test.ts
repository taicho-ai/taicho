import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { paths } from "./files";
import { KbNode } from "../schemas/knowledge";
import { serializeNode, parseNode, writeNode, readNode, nodeExists, neighbors, reindexKnowledge, mkKbId } from "./knowledge";

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
