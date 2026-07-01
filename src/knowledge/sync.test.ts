import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../store/db";
import { paths } from "../store/files";
import { KbNode } from "../schemas/knowledge";
import { writeNode, nodeExists, resolveNodeIds } from "../store/knowledge";
import { upsertSourceHash, hashContent } from "../store/sources";
import { syncKnowledgeSources } from "./sync";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-sync-"));
const write = (w: string, name: string, body: string) => {
  mkdirSync(paths.kbSourceDir(w), { recursive: true });
  writeFileSync(paths.kbSourceFile(w, name), body);
};
const mkNode = (over: object) => KbNode.parse({ id: "kb_x", title: "t", content: "c", created: new Date().toISOString(), ...over });

test("sync ingests changed docs, cleans deleted docs, and records hashes; is idempotent", async () => {
  const w = ws();
  const db = openDb(w);
  write(w, "a.md", "alpha v1");
  // stub ingest: each call writes one node stamped with the source provenance for that doc
  let calls = 0;
  const ingest = async (path: string, hash: string) => {
    calls++;
    writeNode(w, db, mkNode({ id: `kb_${calls}`, source: `${path}@${hash}` }));
  };

  const s1 = await syncKnowledgeSources({ ws: w, db, ingest });
  expect(s1.changedDocs).toBe(1);
  expect(resolveNodeIds(db, { sourcePrefix: "sources/a.md@" })).toHaveLength(1);

  // re-sync unchanged → no-op
  const s2 = await syncKnowledgeSources({ ws: w, db, ingest });
  expect(s2.changedDocs).toBe(0);
  expect(calls).toBe(1);

  // edit → old subgraph replaced, not appended
  write(w, "a.md", "alpha v2");
  const s3 = await syncKnowledgeSources({ ws: w, db, ingest });
  expect(s3.changedDocs).toBe(1);
  expect(s3.removedNodes).toBe(1); // the v1 node was forgotten before re-ingest
  expect(resolveNodeIds(db, { sourcePrefix: "sources/a.md@" })).toHaveLength(1);
  expect(resolveNodeIds(db, { sourcePrefix: `sources/a.md@${hashContent("alpha v2")}` })).toHaveLength(1);
});
