import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveArtifact, readArtifact, readArtifactBody, listArtifacts,
  artifactVersions, rebuildArtifactIndex, readManifest, gcArtifacts,
} from "./artifacts";
import { annotateArtifact } from "./annotations";
import { paths } from "./files";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-art-"));
const prov = { producer: "researcher", runId: "researcher/2026-07-04-run1" };

test("saveArtifact writes a v1 envelope + body and returns provenance", () => {
  const w = ws();
  const a = saveArtifact(w, { id: "research-foo", title: "Foo dossier", type: "dossier", summary: "on foo", body: "# Foo\nbig body", ...prov });
  expect(a.id).toBe("research-foo");
  expect(a.version).toBe(1);
  expect(a.type).toBe("dossier");
  expect(a.role).toBe("output");
  expect(a.producer).toBe("researcher");
  expect(a.runId).toBe("researcher/2026-07-04-run1");
  expect(a.location.kind).toBe("file");
  expect(existsSync(join(paths.artifactDir(w), "research-foo", "v1.json"))).toBe(true);
  expect(readArtifactBody(w, "research-foo")?.toString("utf8")).toBe("# Foo\nbig body");
});

test("a revision is a NEW version and NEVER overwrites the prior one (immutable-per-version)", () => {
  const w = ws();
  saveArtifact(w, { id: "doc", title: "Doc", body: "ONE", ...prov });
  const v2 = saveArtifact(w, { id: "doc", title: "Doc v2", body: "TWO", parents: ["doc@v1"], ...prov });
  expect(v2.version).toBe(2);
  expect(artifactVersions(w, "doc")).toEqual([1, 2]);
  // v1 is untouched — both bytes AND envelope
  expect(readArtifactBody(w, "doc@v1")?.toString("utf8")).toBe("ONE");
  expect(readArtifactBody(w, "doc@v2")?.toString("utf8")).toBe("TWO");
  expect(readArtifact(w, "doc@v1")!.title).toBe("Doc");
  // bare handle resolves to the LATEST version
  expect(readArtifact(w, "doc")!.version).toBe(2);
  expect(readArtifactBody(w, "doc")?.toString("utf8")).toBe("TWO");
  // lineage recorded on the revision
  expect(v2.parents).toEqual(["doc@v1"]);
});

test("id is derived from the title when omitted; the store never interprets the body", () => {
  const w = ws();
  const a = saveArtifact(w, { title: "My Great Report!!", body: "opaque\0bytes", ...prov });
  expect(a.id).toBe("my-great-report");
  // body stored verbatim (payload-agnostic — including a NUL byte)
  expect(readArtifactBody(w, a.id)?.toString("utf8")).toBe("opaque\0bytes");
});

test("body + envelope survive a workspace RELOCATION (rename the ws dir → body still reads back)", () => {
  const a = ws();
  saveArtifact(a, { id: "moved", title: "Moved", body: "portable bytes", ...prov });
  // move the whole workspace (the envelope still bakes the OLD absolute body path)
  const b = a + "-renamed";
  renameSync(a, b);
  // envelope addressing was already relocatable; body addressing must be too — recomputed from ws+id
  expect(readArtifact(b, "moved")!.title).toBe("Moved");
  expect(readArtifactBody(b, "moved")?.toString("utf8")).toBe("portable bytes");
  // the stale absolute path in the OLD location no longer exists, proving we did NOT read it verbatim
  const staleAbs = readArtifact(b, "moved")!.location;
  expect(staleAbs.kind === "file" && existsSync(staleAbs.path)).toBe(false);
});

test("an external-ref artifact stores only the envelope (locator, no local body)", () => {
  const w = ws();
  const a = saveArtifact(w, { id: "notion-page", title: "Spec", type: "notion-page", external: "notion://abc123", ...prov });
  expect(a.location).toEqual({ kind: "external", uri: "notion://abc123" });
  expect(readArtifactBody(w, "notion-page")).toBeNull(); // no local bytes
  expect(readArtifact(w, "notion-page")!.location.kind).toBe("external");
});

test("saveArtifact requires a body or an external locator", () => {
  const w = ws();
  expect(() => saveArtifact(w, { id: "empty", title: "Empty", ...prov })).toThrow(/body or an external/);
});

test("listArtifacts returns the latest version of each id and filters by producer/type/role/q", () => {
  const w = ws();
  saveArtifact(w, { id: "a", title: "Alpha report", type: "report", body: "x", producer: "r1", runId: "r1/1" });
  saveArtifact(w, { id: "a", title: "Alpha report v2", type: "report", body: "x2", producer: "r1", runId: "r1/2" }); // revision
  saveArtifact(w, { id: "b", title: "Beta brief", type: "brief", role: "input", body: "y", producer: "human", runId: "human/1" });

  const all = listArtifacts(w);
  expect(all.length).toBe(2);                                   // latest-per-id, not per-version
  expect(all.find((x) => x.id === "a")!.version).toBe(2);
  expect(listArtifacts(w, { producer: "r1" }).map((x) => x.id)).toEqual(["a"]);
  expect(listArtifacts(w, { type: "brief" }).map((x) => x.id)).toEqual(["b"]);
  expect(listArtifacts(w, { role: "input" }).map((x) => x.id)).toEqual(["b"]);
  expect(listArtifacts(w, { q: "beta" }).map((x) => x.id)).toEqual(["b"]);
});

test("readArtifact returns null for an unknown handle / version", () => {
  const w = ws();
  saveArtifact(w, { id: "known", title: "K", body: "z", ...prov });
  expect(readArtifact(w, "unknown")).toBeNull();
  expect(readArtifact(w, "known@v9")).toBeNull();
});

test("the manifest self-heals: listArtifacts rebuilds it from the canonical envelopes if deleted", () => {
  const w = ws();
  saveArtifact(w, { id: "a", title: "A", body: "1", ...prov });
  saveArtifact(w, { id: "b", title: "B", body: "2", ...prov });
  rmSync(join(paths.artifactDir(w), "_index.json"));           // nuke the index
  const rebuilt = rebuildArtifactIndex(w).map((x) => x.id).sort();
  expect(rebuilt).toEqual(["a", "b"]);
  expect(listArtifacts(w).map((x) => x.id).sort()).toEqual(["a", "b"]);
});

test("upsert after a deleted manifest keeps prior ids (no clobber)", () => {
  const w = ws();
  saveArtifact(w, { id: "a", title: "A", body: "1", ...prov });
  rmSync(join(paths.artifactDir(w), "_index.json"));
  saveArtifact(w, { id: "b", title: "B", body: "2", ...prov }); // upsert must re-seed from the scan, not just [b]
  expect(listArtifacts(w).map((x) => x.id).sort()).toEqual(["a", "b"]);
});

test("a valid-but-STALE manifest self-heals: a missing id is unioned back from the on-disk envelopes", () => {
  const w = ws();
  saveArtifact(w, { id: "a", title: "A", body: "1", ...prov });
  saveArtifact(w, { id: "b", title: "B", body: "2", ...prov });
  // simulate a cross-process last-writer-wins that dropped "b": a VALID (parseable) manifest with only "a".
  const onlyA = readManifest(w).filter((x) => x.id === "a");
  expect(onlyA.length).toBe(1);                                  // precondition: stale manifest is non-empty
  writeFileSync(join(paths.artifactDir(w), "_index.json"), JSON.stringify(onlyA, null, 2));
  // the read reconciles against the dir scan and surfaces "b" again (does NOT rely on empty/corrupt to rebuild)
  expect(listArtifacts(w).map((x) => x.id).sort()).toEqual(["a", "b"]);
  // and the heal is durable — the manifest file on disk now carries both ids
  const healed = JSON.parse(readFileSync(join(paths.artifactDir(w), "_index.json"), "utf8"));
  expect(healed.map((x: { id: string }) => x.id).sort()).toEqual(["a", "b"]);
});

test("the envelope on disk carries full provenance + lineage (readable without the store)", () => {
  const w = ws();
  saveArtifact(w, { id: "p", title: "P", body: "1", ...prov });
  const a = saveArtifact(w, { id: "p", title: "P2", body: "2", parents: ["p@v1"], producer: "writer", runId: "writer/2026-07-04-run3" });
  const onDisk = JSON.parse(readFileSync(join(paths.artifactDir(w), "p", "v2.json"), "utf8"));
  expect(onDisk).toMatchObject({ id: "p", version: 2, producer: "writer", runId: "writer/2026-07-04-run3", parents: ["p@v1"] });
  expect(a.producer).toBe("writer");
});

// ── Phase 4b — retention & GC ──────────────────────────────────────────────

test("gcArtifacts archives old unreferenced versions but keeps the latest N (default 3)", () => {
  const w = ws();
  for (let i = 1; i <= 5; i++) saveArtifact(w, { id: "doc", title: `Doc v${i}`, body: `${i}`, ...prov });
  expect(artifactVersions(w, "doc")).toEqual([1, 2, 3, 4, 5]);
  const r = gcArtifacts(w);                                   // keepLatest defaults to 3
  expect(r.archived.sort()).toEqual(["doc@v1", "doc@v2"]);
  expect(artifactVersions(w, "doc")).toEqual([3, 4, 5]);      // live scan no longer sees the archived versions
  expect(readArtifact(w, "doc@v1")).toBeNull();              // an archived version is gone from the addressable store
  expect(readArtifact(w, "doc")!.version).toBe(5);           // latest is untouched
  expect(readArtifactBody(w, "doc@v5")?.toString("utf8")).toBe("5");
});

test("gcArtifacts NEVER archives a version referenced by a trace, however old", () => {
  const w = ws();
  for (let i = 1; i <= 4; i++) saveArtifact(w, { id: "doc", title: `v${i}`, body: `${i}`, ...prov });
  // v1 is old (outside keep-latest-2) but a trace still points at it → must survive.
  const r = gcArtifacts(w, { keepLatest: 2, referenced: ["doc@v1"] });
  expect(r.archived).toEqual(["doc@v2"]);                     // only the old AND unreferenced one goes
  expect(readArtifact(w, "doc@v1")!.title).toBe("v1");        // referenced version preserved
  expect(readArtifact(w, "doc@v2")).toBeNull();
});

test("gcArtifacts preserves the parent-closure of a kept version (lineage integrity)", () => {
  const w = ws();
  saveArtifact(w, { id: "src", title: "Source", body: "s", ...prov });      // src@v1
  saveArtifact(w, { id: "src", title: "Source v2", body: "s2", ...prov });  // src@v2 (latest, kept)
  // a DIFFERENT id derives from the OLD src@v1; keeping the derived latest must keep src@v1 too.
  saveArtifact(w, { id: "derived", title: "Derived", body: "d", parents: ["src@v1"], ...prov });
  const r = gcArtifacts(w, { keepLatest: 1 });
  // src@v1 is outside keep-latest-1 AND unreferenced by a trace, but it's the parent of a kept artifact
  expect(r.archived).not.toContain("src@v1");
  expect(readArtifact(w, "src@v1")!.title).toBe("Source");
});

test("gcArtifacts never archives a version that carries an annotation", () => {
  const w = ws();
  for (let i = 1; i <= 4; i++) saveArtifact(w, { id: "doc", title: `v${i}`, body: `${i}`, ...prov });
  annotateArtifact(w, { target: "doc@v1", author: "human", body: "keep this one — it's the approved baseline" });
  const r = gcArtifacts(w, { keepLatest: 2 });
  expect(r.archived).not.toContain("doc@v1");                // annotated ⇒ protected
  expect(readArtifact(w, "doc@v1")!.title).toBe("v1");
  expect(r.archived).toEqual(["doc@v2"]);
});

test("gcArtifacts is a no-op when nothing is collectable", () => {
  const w = ws();
  saveArtifact(w, { id: "a", title: "A", body: "1", ...prov });
  saveArtifact(w, { id: "b", title: "B", body: "2", ...prov });
  const r = gcArtifacts(w);
  expect(r.archived).toEqual([]);
  expect(listArtifacts(w).map((x) => x.id).sort()).toEqual(["a", "b"]);
});
