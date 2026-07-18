import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { paths } from "./files";
import { loadWorkflowDef, writeWorkflowSteps } from "./workflows";

const mkws = () => mkdtempSync(join(tmpdir(), "taicho-wfd-"));

const STRUCTURED = `---
workflow: daily-brief
version: 2
brief: "morning brief"
steps:
  - id: research
    run: "@researcher"
    produces: sources
  - id: signoff
    human: "editor sign-off"
    choices: [approve, revise]
    routes: { revise: research }
---

## researcher
do the research
`;

const PROSE_ONLY = `# news workflow

## orchestration
Run reporter -> editor.

## reporter
Draft it.
`;

test("loadWorkflowDef reads the structured steps from a team's workflow.md, injecting the team id", () => {
  const ws = mkws();
  mkdirSync(paths.teamDir(ws, "news"), { recursive: true });
  writeFileSync(paths.teamWorkflowFile(ws, "news"), STRUCTURED);
  const def = loadWorkflowDef(ws, "news");
  expect(def).not.toBeNull();
  expect(def).toMatchObject({ id: "daily-brief", team: "news", version: 2, brief: "morning brief" });
  expect(def!.steps.map((s) => s.kind)).toEqual(["agent", "human"]);
});

test("loadWorkflowDef returns null for a Plan 23 prose-only workflow.md", () => {
  const ws = mkws();
  mkdirSync(paths.teamDir(ws, "news"), { recursive: true });
  writeFileSync(paths.teamWorkflowFile(ws, "news"), PROSE_ONLY);
  expect(loadWorkflowDef(ws, "news")).toBeNull();
});

test("loadWorkflowDef returns null when the team has no workflow.md", () => {
  expect(loadWorkflowDef(mkws(), "ghost")).toBeNull();
});

test("writeWorkflowSteps writes the steps: frontmatter and PRESERVES existing prose lanes", () => {
  const ws = mkws();
  mkdirSync(paths.teamDir(ws, "news"), { recursive: true });
  writeFileSync(paths.teamWorkflowFile(ws, "news"), "# news workflow\n\n## writer\nLede first. Cite by handle.\n");
  writeWorkflowSteps(ws, "news", {
    name: "daily-brief",
    brief: "the morning brief",
    steps: [
      { id: "research", run: "@researcher", produces: "sources" },
      { id: "draft", run: "@writer", consumes: ["sources"], produces: "draft" },
    ],
  });
  const def = loadWorkflowDef(ws, "news");
  expect(def).toMatchObject({ id: "daily-brief", team: "news", brief: "the morning brief" });
  expect(def!.steps.map((s) => s.kind)).toEqual(["agent", "agent"]);
  const raw = readFileSync(paths.teamWorkflowFile(ws, "news"), "utf8");
  expect(raw).toContain("## writer"); // the Plan 23 prose lane survived
  expect(raw).toContain("Lede first. Cite by handle.");
});

test("writeWorkflowSteps creates a new workflow.md (version 1) when the team has none", () => {
  const ws = mkws();
  mkdirSync(paths.teamDir(ws, "news"), { recursive: true });
  writeWorkflowSteps(ws, "news", { name: "wf", steps: [{ id: "a", run: "@x" }] });
  const def = loadWorkflowDef(ws, "news");
  expect(def).not.toBeNull();
  expect(def).toMatchObject({ id: "wf", version: 1 });
});

test("writeWorkflowSteps validates before writing — invalid steps throw and write nothing", () => {
  const ws = mkws();
  mkdirSync(paths.teamDir(ws, "news"), { recursive: true });
  expect(() => writeWorkflowSteps(ws, "news", { name: "wf", steps: [{ id: "bad" }] })).toThrow();
  expect(loadWorkflowDef(ws, "news")).toBeNull();
});
