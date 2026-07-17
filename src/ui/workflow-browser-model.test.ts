import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../store/files";
import { writeWorkflowSteps } from "../store/workflows";
import { reserveWorkflowRun, appendWorkflowEvent } from "../store/workflow-runs";
import { parseWorkflowDef } from "../schemas/workflow";
import { listWorkflowRows, workflowRunRows } from "./workflow-browser-model";

const mkws = () => mkdtempSync(join(tmpdir(), "taicho-wbm-"));
function mkteam(ws: string, id: string) {
  mkdirSync(paths.teamDir(ws, id), { recursive: true });
  writeFileSync(paths.teamFile(ws, id), `---\nid: ${id}\ncharter: the ${id} team\ncreated: 2026-07-17T00:00:00.000Z\n---\nbody\n`);
}

test("listWorkflowRows classifies each team's workflow (structured / prose / none), excluding default", () => {
  const ws = mkws();
  mkteam(ws, "default");
  mkteam(ws, "news");
  writeWorkflowSteps(ws, "news", {
    name: "daily-brief",
    steps: [
      { id: "research", run: "@r", produces: "sources" },
      { id: "signoff", human: "sign-off", choices: ["approve"] },
      { id: "publish", run: "@e" },
    ],
  });
  mkteam(ws, "blog");
  writeFileSync(paths.teamWorkflowFile(ws, "blog"), "# blog\n\n## writer\nWrite.\n\n## editor\nEdit.\n");
  mkteam(ws, "solo");

  const rows = listWorkflowRows(ws);
  expect(rows.some((r) => r.team === "default")).toBe(false); // default excluded
  expect(rows.find((r) => r.team === "news")).toMatchObject({ kind: "structured", name: "daily-brief", steps: 3, gates: 1 });
  expect(rows.find((r) => r.team === "blog")).toMatchObject({ kind: "prose" });
  expect(rows.find((r) => r.team === "solo")).toMatchObject({ kind: "none", steps: 0 });
});

test("workflowRunRows lists a workflow's past runs newest-first with status and counts", () => {
  const ws = mkws();
  const def = parseWorkflowDef({ id: "wf", team: "t", version: 1, steps: [{ id: "a", run: "@x" }, { id: "b", run: "@y" }] });
  reserveWorkflowRun(ws, "wf"); // wr_wf_1
  appendWorkflowEvent(ws, "wf", "wr_wf_1", { step: "a", status: "done", runId: "r" });
  appendWorkflowEvent(ws, "wf", "wr_wf_1", { step: "b", status: "done", runId: "r" });
  reserveWorkflowRun(ws, "wf"); // wr_wf_2
  appendWorkflowEvent(ws, "wf", "wr_wf_2", { step: "a", status: "failed", runId: "r" });

  const rows = workflowRunRows(ws, def);
  expect(rows.map((r) => r.runId)).toEqual(["wr_wf_2", "wr_wf_1"]); // newest first
  expect(rows[0]).toMatchObject({ status: "failed", done: 0, total: 2 });
  expect(rows[1]).toMatchObject({ status: "done", done: 2, total: 2 });
});

test("listWorkflowRows surfaces the run count and last status for a structured workflow", () => {
  const ws = mkws();
  mkteam(ws, "news");
  writeWorkflowSteps(ws, "news", { name: "wf", steps: [{ id: "a", run: "@x" }] });
  reserveWorkflowRun(ws, "wf");
  appendWorkflowEvent(ws, "wf", "wr_wf_1", { step: "a", status: "done", runId: "r" });
  const news = listWorkflowRows(ws).find((r) => r.team === "news")!;
  expect(news.runs).toBe(1);
  expect(news.lastStatus).toBe("done");
});
