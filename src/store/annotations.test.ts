import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveArtifact } from "./artifacts";
import { annotateArtifact, listAnnotations, readAnnotation, resolveAnnotation } from "./annotations";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-ann-"));
const prov = { producer: "researcher", runId: "researcher/2026-07-04-run1" };

test("annotate pins a bare id to its LATEST version and defaults to an open feedback note", () => {
  const w = ws();
  saveArtifact(w, { id: "doc", title: "Doc", body: "v1", ...prov });
  saveArtifact(w, { id: "doc", title: "Doc v2", body: "v2", parents: ["doc@v1"], ...prov });
  const a = annotateArtifact(w, { target: "doc", author: "human", body: "tighten the intro" });
  expect(a.target).toBe("doc@v2");          // bare id ⇒ latest version
  expect(a.author).toBe("human");
  expect(a.kind).toBe("feedback");
  expect(a.status).toBe("open");
  expect(a.id).toMatch(/^ann_/);
});

test("a verdict-bearing annotation is a `verification` (Plan 06 hook — same shape, same store)", () => {
  const w = ws();
  saveArtifact(w, { id: "dossier", title: "Dossier", body: "x", ...prov });
  const a = annotateArtifact(w, {
    target: "dossier@v1", author: "checker", body: "missing dates on 2 sources",
    verdict: { pass: false, reasons: ["source 3 undated", "source 5 undated"] },
  });
  expect(a.kind).toBe("verification");      // inferred from the verdict when no explicit kind
  expect(a.verdict?.pass).toBe(false);
  expect(a.verdict?.reasons).toEqual(["source 3 undated", "source 5 undated"]);
  // it lists like any other annotation — machine + human feedback converge on ONE mechanism
  expect(listAnnotations(w, "dossier", { status: "open" }).map((x) => x.kind)).toEqual(["verification"]);
});

test("annotations pin to a version: an id@vN handle lists only that version's feedback", () => {
  const w = ws();
  saveArtifact(w, { id: "doc", title: "Doc", body: "v1", ...prov });
  annotateArtifact(w, { target: "doc@v1", author: "human", body: "fix v1" });
  saveArtifact(w, { id: "doc", title: "Doc v2", body: "v2", parents: ["doc@v1"], ...prov });
  annotateArtifact(w, { target: "doc@v2", author: "human", body: "fix v2" });
  expect(listAnnotations(w, "doc@v1").map((a) => a.body)).toEqual(["fix v1"]);
  expect(listAnnotations(w, "doc@v2").map((a) => a.body)).toEqual(["fix v2"]);
  // a bare id sees every version's annotations (newest first)
  expect(listAnnotations(w, "doc").map((a) => a.body)).toEqual(["fix v2", "fix v1"]);
});

test("annotating a nonexistent artifact throws (never a dangling feedback ref)", () => {
  const w = ws();
  expect(() => annotateArtifact(w, { target: "ghost", author: "human", body: "?" })).toThrow(/no artifact/);
});

test("resolveAnnotation marks addressed by a revision and the log preserves history (append-only)", () => {
  const w = ws();
  saveArtifact(w, { id: "doc", title: "Doc", body: "v1", ...prov });
  const open = annotateArtifact(w, { target: "doc@v1", author: "human", body: "add a summary" });
  expect(listAnnotations(w, "doc", { status: "open" }).length).toBe(1);
  // the reviser saves v2 and resolves the feedback against it
  saveArtifact(w, { id: "doc", title: "Doc v2", body: "v2", parents: ["doc@v1"], ...prov });
  const resolved = resolveAnnotation(w, "doc", open.id, { resolvedBy: "doc@v2" });
  expect(resolved?.status).toBe("addressed");
  expect(resolved?.resolvedBy).toBe("doc@v2");
  // reads fold latest-per-id: the annotation is now addressed, not open
  expect(listAnnotations(w, "doc", { status: "open" }).length).toBe(0);
  expect(readAnnotation(w, "doc", open.id)?.status).toBe("addressed");
  expect(listAnnotations(w, "doc", { status: "addressed" }).map((a) => a.id)).toEqual([open.id]);
});

test("resolveAnnotation returns null for an unknown annotation id", () => {
  const w = ws();
  saveArtifact(w, { id: "doc", title: "Doc", body: "v1", ...prov });
  expect(resolveAnnotation(w, "doc", "ann_nope")).toBeNull();
  expect(readAnnotation(w, "doc", "ann_nope")).toBeNull();
});

test("dismiss is a terminal, non-open status (feedback the captain waved off)", () => {
  const w = ws();
  saveArtifact(w, { id: "doc", title: "Doc", body: "v1", ...prov });
  const a = annotateArtifact(w, { target: "doc@v1", author: "worker", body: "nit" });
  resolveAnnotation(w, "doc", a.id, { status: "dismissed" });
  expect(listAnnotations(w, "doc", { status: "open" }).length).toBe(0);
  expect(listAnnotations(w, "doc", { status: "dismissed" }).map((x) => x.id)).toEqual([a.id]);
});
