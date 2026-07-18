import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveArtifact, readArtifact, readArtifactBody, listArtifacts,
  artifactVersions, rebuildArtifactIndex, readManifest, gcArtifacts,
  collectReferencedArtifacts, artifactBodyPath,
} from "./artifacts";
import { artifactHandle } from "@taicho/contracts/artifact";
import { annotateArtifact } from "./annotations";
import { writeTrace, listTraces } from "./trace";
import type { RunTrace } from "@taicho/contracts/trace";
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

// ── collectReferencedArtifacts (the /artifacts gc protected-set gather) ───────────────────────────

test("collectReferencedArtifacts draws from the HAND-OFF graph, NOT a producing run's own artifacts", () => {
  // The producing trace lists every version it emitted in `artifacts` — that MUST NOT protect them
  // (else keep-latest-N is shadowed and gc archives nothing). Only inputArtifacts/outputArtifacts count.
  const traces = [
    { artifacts: ["doc@v1", "doc@v2", "doc@v3"], inputArtifacts: ["src@v1"], outputArtifacts: ["out@v2"] },
    { artifacts: ["doc@v4"], inputArtifacts: [], outputArtifacts: [] },
  ];
  const refs = collectReferencedArtifacts({ traces }).sort();
  expect(refs).toEqual(["out@v2", "src@v1"]);          // hand-off edges only
  expect(refs).not.toContain("doc@v1");                // producing record is NOT a reference
  expect(refs).not.toContain("doc@v4");
});

test("collectReferencedArtifacts unions task resultRefs, exemplars and extras, deduped & trimmed", () => {
  const refs = collectReferencedArtifacts({
    traces: [{ inputArtifacts: ["a@v1"], outputArtifacts: [] }],
    taskResultRefs: ["b@v2", "researcher/2026-07-04-run3", null, undefined, "  c@v1  "],
    exemplarArtifacts: ["d@v9", "a@v1"],               // a@v1 already present ⇒ deduped
    extra: ["e@v1", ""],
  }).sort();
  expect(refs).toEqual(["a@v1", "b@v2", "c@v1", "d@v9", "e@v1", "researcher/2026-07-04-run3"]);
  // empty/null entries dropped; whitespace trimmed
  expect(refs).not.toContain("");
  expect(refs).toContain("c@v1");
});

test("collectReferencedArtifacts is empty for no sources", () => {
  expect(collectReferencedArtifacts({})).toEqual([]);
});

// ── PRODUCTION-CONDITION gc (real traces pin each version, as executeRun writes them) ─────────────
// The existing gc tests seed versions via raw saveArtifact with NO run/trace, so listTraces() is []
// and the protected set is trivially just keep-latest-N. That never reproduces production, where
// EVERY save pushes the version into its run's ctx.artifacts → persisted as trace.artifacts. These
// tests write real traces (exactly what run.ts writes) and drive the SAME protected-set gather the
// /artifacts gc handler uses (collectReferencedArtifacts), catching the "gc is a no-op" regression.

/** A real per-run trace, mirroring run.ts: `artifacts` = every version this run emitted. */
function writeProductionTrace(
  w: string, agent: string, n: number,
  emitted: string[], handoff: { inputArtifacts?: string[]; outputArtifacts?: string[] } = {},
): void {
  const trace: RunTrace = {
    id: `${agent}/2026-07-04-run${n}`, agent, task: "(chat)", triggeredBy: "user",
    ledger: { retrieved: [], applied: [], skipped: [], knowledge: [], skills: [] },
    toolCalls: [{ tool: "save_artifact", count: 1 }],
    artifacts: emitted,                                        // ← the production pin: what THIS run produced
    inputArtifacts: handoff.inputArtifacts ?? [],
    outputArtifacts: handoff.outputArtifacts ?? [],
    delegatedOut: [], verification: [], outcome: "completed",
    tokens: 0, contextTokens: 0, costUsd: 0, verifierTokens: 0, verifierCostUsd: 0,
    notes: [], durationMs: 1, started: new Date().toISOString(),
  };
  writeTrace(w, trace);
}

test("PRODUCTION: gc archives superseded intermediates even though each version is pinned by its own trace", () => {
  const w = ws();
  // Iterative revision: doc@v1..v5, each produced by its own run whose trace.artifacts pins it.
  for (let i = 1; i <= 5; i++) {
    saveArtifact(w, { id: "doc", title: `Doc v${i}`, body: `${i}`, ...prov });
    writeProductionTrace(w, "researcher", i, [`doc@v${i}`]);
  }
  expect(artifactVersions(w, "doc")).toEqual([1, 2, 3, 4, 5]);
  // The BUG (folding trace.artifacts into `referenced`) protects all 5 → archives nothing. Running it
  // first is a safe no-op (it archives nothing, so it leaves the store untouched for the fix below).
  const buggy = listTraces(w).flatMap((t) => [...t.artifacts, ...t.inputArtifacts, ...t.outputArtifacts]);
  expect(gcArtifacts(w, { keepLatest: 3, referenced: buggy }).archived).toEqual([]);
  expect(artifactVersions(w, "doc")).toEqual([1, 2, 3, 4, 5]); // proven no-op: nothing archived

  // The FIX: gather from the consumption/hand-off graph only (what the /artifacts gc handler now does).
  const referenced = collectReferencedArtifacts({ traces: listTraces(w) });
  expect(referenced).toEqual([]);                             // no hand-off edges ⇒ nothing pinned by consumption
  const r = gcArtifacts(w, { keepLatest: 3, referenced });
  expect(r.archived.sort()).toEqual(["doc@v1", "doc@v2"]);    // superseded intermediates collected
  expect(artifactVersions(w, "doc")).toEqual([3, 4, 5]);      // live store shrank
  expect(readArtifact(w, "doc")!.version).toBe(5);            // latest untouched
});

test("PRODUCTION: a version handed off (inputArtifacts/outputArtifacts) survives gc, however old", () => {
  const w = ws();
  for (let i = 1; i <= 5; i++) {
    saveArtifact(w, { id: "doc", title: `Doc v${i}`, body: `${i}`, ...prov });
    writeProductionTrace(w, "researcher", i, [`doc@v${i}`]);
  }
  // A LATER run handed doc@v1 down to a child (inputArtifacts) and received doc@v2 up (outputArtifacts).
  writeProductionTrace(w, "planner", 1, [], { inputArtifacts: ["doc@v1"], outputArtifacts: ["doc@v2"] });
  const referenced = collectReferencedArtifacts({ traces: listTraces(w) }).sort();
  expect(referenced).toEqual(["doc@v1", "doc@v2"]);
  const r = gcArtifacts(w, { keepLatest: 3, referenced });
  expect(r.archived).toEqual([]);                            // v1 (hand-off down) + v2 (hand-off up) both protected
  expect(readArtifact(w, "doc@v1")!.title).toBe("Doc v1");
  expect(readArtifact(w, "doc@v2")!.title).toBe("Doc v2");
});

test("PRODUCTION: a version pinned by a task resultRef / annotation / parent-closure survives gc", () => {
  const w = ws();
  for (let i = 1; i <= 5; i++) {
    saveArtifact(w, { id: "doc", title: `Doc v${i}`, body: `${i}`, ...prov });
    writeProductionTrace(w, "researcher", i, [`doc@v${i}`]);
  }
  // doc@v1 kept by a task's resultRef; doc@v2 kept by an annotation; a derived artifact pins doc@v3 via lineage.
  annotateArtifact(w, { target: "doc@v2", author: "human", body: "approved baseline" });
  saveArtifact(w, { id: "derived", title: "Derived", body: "d", parents: ["doc@v3"], ...prov });
  const referenced = collectReferencedArtifacts({
    traces: listTraces(w),
    taskResultRefs: ["doc@v1", "researcher/2026-07-04-run5" /* run-id resultRef → harmlessly ignored */],
  });
  const r = gcArtifacts(w, { keepLatest: 1, referenced });   // keep-latest-1 ⇒ only doc@v5 kept by recency
  // v1 (task ref), v2 (annotation), v3 (parent of kept `derived`) all survive; only v4 is collectable.
  expect(r.archived).toEqual(["doc@v4"]);
  expect(readArtifact(w, "doc@v1")!.title).toBe("Doc v1");
  expect(readArtifact(w, "doc@v2")!.title).toBe("Doc v2");
  expect(readArtifact(w, "doc@v3")!.title).toBe("Doc v3");
  expect(readArtifact(w, "doc@v4")).toBeNull();              // superseded + unreferenced ⇒ archived
});

test("Plan 21: gcArtifacts dryRun computes the would-archive list without touching anything", async () => {
  const w = ws();
  // four versions of one id; keepLatest 1 and nothing referenced ⇒ v1..v3 are candidates
  for (let i = 0; i < 4; i++) saveArtifact(w, { id: "doc", title: "Doc", body: `v${i + 1}`, producer: "a", runId: "r/1" });
  const dry = gcArtifacts(w, { keepLatest: 1, dryRun: true });
  expect(dry.archived.sort()).toEqual(["doc@v1", "doc@v2", "doc@v3"]);
  // nothing moved: every version still readable, no _archive dir
  for (let v = 1; v <= 4; v++) expect(readArtifact(w, `doc@v${v}`)).not.toBeNull();
  expect(existsSync(join(w, "artifacts", "doc", "_archive"))).toBe(false);
  // the real run archives EXACTLY the previewed set — one code path, no disagreement possible
  const real = gcArtifacts(w, { keepLatest: 1 });
  expect(real.archived.sort()).toEqual(dry.archived.sort());
  expect(readArtifact(w, "doc@v1")).toBeNull();
});

test("Plan 21: artifactBodyPath recomputes from ws (relocatable) and is null for external", async () => {
  const w = ws();
  const a = saveArtifact(w, { id: "local-doc", title: "L", body: "bytes", producer: "a", runId: "r/1" });
  const p = artifactBodyPath(w, artifactHandle(a));
  expect(p).not.toBeNull();
  expect(p!.startsWith(join(w, "artifacts", "local-doc"))).toBe(true);   // ws-anchored, not the baked path
  expect(readFileSync(p!, "utf8")).toBe("bytes");
  const ext = saveArtifact(w, { id: "ext-doc", title: "E", external: "https://example.com/x", producer: "a", runId: "r/1" });
  expect(artifactBodyPath(w, artifactHandle(ext))).toBeNull();           // external ⇒ no local file
});

// ── Plan 21 Ph4: the /artifacts gc REPL tests, ported to the store seam the browser's `g` verb
// drives (collectReferencedArtifacts ∘ gcArtifacts). The protection semantics they encode:
// protect by what CONSUMES a version (hand-off graph + task refs), never by its own producing
// trace.artifacts — folding that in would pin every version ever produced and shadow keep-latest-N.
function gcTrace(over: Record<string, unknown>) {
  return {
    id: "root/r", agent: "root", task: "t", triggeredBy: "user",
    ledger: { retrieved: [], applied: [], skipped: [] }, toolCalls: [], artifacts: [],
    inputArtifacts: [], outputArtifacts: [], delegatedOut: [], verification: [],
    outcome: "completed", tokens: 0, contextTokens: 0, costUsd: 0, verifierTokens: 0, verifierCostUsd: 0,
    notes: [], durationMs: 0, started: new Date().toISOString(), ...over,
  } as unknown as RunTrace;
}

test("Plan 21 (ported): gc archives old unreferenced versions via the composed referenced set", () => {
  const w = ws();
  for (let i = 1; i <= 5; i++) saveArtifact(w, { id: "doc", title: `v${i}`, body: `${i}`, producer: "root", runId: "root/1" });
  const referenced = collectReferencedArtifacts({ traces: [], taskResultRefs: [] });
  const r = gcArtifacts(w, { referenced });
  expect(r.archived.sort()).toEqual(["doc@v1", "doc@v2"]);
  expect(readArtifact(w, "doc@v1")).toBeNull();
  expect(readArtifact(w, "doc")!.version).toBe(5);
});

// PRODUCTION CONDITION (PR #17 review): each version pinned by its OWN producing trace.artifacts —
// the real state after iterative revision. collectReferencedArtifacts must NOT fold t.artifacts in,
// or gc is a no-op forever.
test("Plan 21 (ported): superseded versions still archive when each is pinned by its producing trace", () => {
  const w = ws();
  const traces = [];
  for (let i = 1; i <= 5; i++) {
    saveArtifact(w, { id: "doc", title: `v${i}`, body: `${i}`, producer: "root", runId: `root/run${i}` });
    traces.push(gcTrace({ id: `root/run${i}`, artifacts: [`doc@v${i}`] }));
  }
  const referenced = collectReferencedArtifacts({ traces, taskResultRefs: [] });
  const r = gcArtifacts(w, { referenced });
  expect(r.archived.sort()).toEqual(["doc@v1", "doc@v2"]);   // producing-trace pins do NOT protect
  expect(readArtifact(w, "doc@v1")).toBeNull();
  expect(readArtifact(w, "doc")!.version).toBe(5);
});

// A version CONSUMED via the hand-off graph (inputArtifacts/outputArtifacts) must survive gc,
// however old — the safety invariant of the re-scoped protected set.
test("Plan 21 (ported): a version handed off across a delegation edge never archives", () => {
  const w = ws();
  const traces = [];
  for (let i = 1; i <= 5; i++) {
    saveArtifact(w, { id: "doc", title: `v${i}`, body: `${i}`, producer: "root", runId: `root/run${i}` });
    traces.push(gcTrace({ id: `root/run${i}`, artifacts: [`doc@v${i}`] }));
  }
  traces.push(gcTrace({ id: "root/run9", inputArtifacts: ["doc@v1"], outputArtifacts: ["doc@v2"] }));
  const referenced = collectReferencedArtifacts({ traces, taskResultRefs: [] });
  const r = gcArtifacts(w, { referenced });
  expect(r.archived).toEqual([]);                            // v1+v2 hand-off-pinned; v3-5 keep-latest-3
  expect(readArtifact(w, "doc@v1")!.title).toBe("v1");
  expect(readArtifact(w, "doc@v2")!.title).toBe("v2");
});
