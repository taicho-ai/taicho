import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../store/db";
import { putVector } from "../store/vectors";
import { KbNode } from "@taicho/contracts/knowledge";
import { writeNode, mkKbId } from "../store/knowledge";
import { searchKnowledge } from "./retrieval";

const setup = () => { const ws = mkdtempSync(join(tmpdir(), "taicho-kbr-")); return { ws, db: openDb(ws) }; };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkNode = (over: any) => KbNode.parse({ id: mkKbId(), title: "t", content: "body", created: new Date().toISOString(), ...over });

test("keyword seed finds a node by content, no embedder needed", async () => {
  const { ws, db } = setup();
  writeNode(ws, db, mkNode({ id: "kb_a", title: "Postgres pooling", content: "use pgbouncer for connection pooling" }));
  writeNode(ws, db, mkNode({ id: "kb_b", title: "Unrelated", content: "the moon is nice" }));
  const r = await searchKnowledge({ db, query: "connection pooling", hops: 0 });
  expect(r.mode).toBe("keyword");
  expect(r.hits.map((h) => h.id)).toContain("kb_a");
  expect(r.hits.map((h) => h.id)).not.toContain("kb_b");
});

test("graph expansion pulls in linked neighbors of a keyword seed", async () => {
  const { ws, db } = setup();
  writeNode(ws, db, mkNode({ id: "kb_a", title: "Auth decision", content: "we chose oauth pkce" }));
  writeNode(ws, db, mkNode({ id: "kb_b", title: "Token refresh gotcha", content: "refresh needs a fresh transport", edges: [{ to: "kb_a", rel: "depends_on" }] }));
  const r = await searchKnowledge({ db, query: "oauth pkce", hops: 1 });
  const ids = r.hits.map((h) => h.id);
  expect(ids).toContain("kb_a");                                   // keyword seed
  expect(ids).toContain("kb_b");                                   // graph neighbor of the seed
  expect(r.hits.find((h) => h.id === "kb_b")?.via).toBe("graph");
});

test("semantic seed is used when an embedder is provided (mode=semantic)", async () => {
  const { ws, db } = setup();
  const vecFor = (t: string): Float32Array => { const v = new Float32Array(4); for (const ch of t) v[ch.charCodeAt(0) % 4] += 1; return v; };
  writeNode(ws, db, mkNode({ id: "kb_a", title: "alpha", content: "alpha alpha" }));
  putVector(db, "kb_a", "kb", vecFor("alpha alpha"));              // index its vector so topK finds it
  const r = await searchKnowledge({ db, query: "alpha alpha", embed: async (t) => vecFor(t), hops: 0 });
  expect(r.mode).toBe("semantic");
  expect(r.hits[0]?.id).toBe("kb_a");
  expect(r.hits[0]?.via).toBe("semantic");
});
