import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./files";
import { parseWorkflow, loadWorkflow, laneFor, orchestrationSlice, hasWorkflow, writeWorkflow, scaffoldWorkflow, seatsOf } from "./workflows";

const DOC = `# news workflow

## orchestration
Run in order: reporter -> fact-check -> editor.
Loop fact-check <-> reporter until clean.

## reporter
Draft 400 words from the brief. Cite every source inline.

## fact-check
Verify every claim against a primary source.

## editor
Tighten to 250 words. Approve only after fact-check passes.
`;

test("parseWorkflow splits member-keyed sections and the orchestration slice", () => {
  const wf = parseWorkflow(DOC);
  expect(orchestrationSlice(wf)).toContain("Run in order: reporter -> fact-check -> editor");
  expect(laneFor(wf, "reporter")).toBe("Draft 400 words from the brief. Cite every source inline.");
  expect(laneFor(wf, "editor")).toContain("Tighten to 250 words");
  // a member with no section gets no lane (→ agentic fallback)
  expect(laneFor(wf, "photographer")).toBeUndefined();
  // a level-1 `# Title` is a document title, NOT a seat — ignored
  expect(wf.sections.has("news workflow")).toBe(false);
});

test("laneFor is case-insensitive on the heading and agent ids are lowercase anyway", () => {
  const wf = parseWorkflow("## Editor\nTighten it.");
  expect(laneFor(wf, "editor")).toBe("Tighten it.");
});

test("YAML frontmatter is stripped (forward-compat with a future structured form)", () => {
  const wf = parseWorkflow("---\nsteps: []\n---\n## reporter\nDraft.");
  expect(laneFor(wf, "reporter")).toBe("Draft.");
});

test("loadWorkflow / hasWorkflow read from disk, and absent is null/false", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-wf-"));
  expect(loadWorkflow(ws, "news")).toBeNull();
  expect(hasWorkflow(ws, "news")).toBe(false);
  mkdirSync(paths.teamDir(ws, "news"), { recursive: true });
  writeFileSync(paths.teamWorkflowFile(ws, "news"), DOC);
  expect(hasWorkflow(ws, "news")).toBe(true);
  expect(laneFor(loadWorkflow(ws, "news")!, "fact-check")).toContain("primary source");
});

test("writeWorkflow persists text (with a trailing newline) and reads back", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-wf-"));
  writeWorkflow(ws, "news", "## editor\ntighten it.");
  expect(readFileSync(paths.teamWorkflowFile(ws, "news"), "utf8").endsWith("\n")).toBe(true);
  expect(laneFor(loadWorkflow(ws, "news")!, "editor")).toBe("tighten it.");
});

test("scaffoldWorkflow templates a starter from the members and refuses to clobber", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-wf-"));
  const text = scaffoldWorkflow(ws, "news", ["reporter", "editor"]);
  expect(text).toContain("## orchestration");
  expect(text).toContain("## reporter");
  expect(text).toContain("## editor");
  const wf = loadWorkflow(ws, "news")!;
  expect(seatsOf(wf)).toEqual(["orchestration", "reporter", "editor"]); // the `# title` is not a seat
  expect(orchestrationSlice(wf)).toContain("who hands to whom");
  // a second scaffold on the same team is refused (don't overwrite an authored file)
  expect(() => scaffoldWorkflow(ws, "news", ["reporter"])).toThrow("already has a workflow");
});
