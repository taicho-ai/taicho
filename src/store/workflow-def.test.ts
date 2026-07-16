import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./files";
import { loadWorkflowDef } from "./workflows";

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
