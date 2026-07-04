import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskState, taskIdForRun, updateTaskFromTrace } from "./task-state";
import { RunTrace } from "../schemas/trace";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-task-"));

function trace(id: string, outcome: "completed" | "failed" = "completed") {
  return RunTrace.parse({
    id,
    agent: id.split("/")[0],
    task: "x",
    triggeredBy: "user",
    ledger: { retrieved: [], applied: [], skipped: [] },
    toolCalls: [],
    artifacts: [],
    delegatedOut: [],
    outcome,
    tokens: 1,
    durationMs: 1,
    started: "2026-07-02T00:00:00.000Z",
  });
}

test("task state marks child failure as failed even when root completed", () => {
  const w = ws();
  createTaskState(w, { runId: "root/2026-07-02-run1", title: "make script" });
  const task = updateTaskFromTrace(
    w,
    taskIdForRun("root/2026-07-02-run1"),
    trace("root/2026-07-02-run1", "completed"),
    [trace("researcher/2026-07-02-run1", "failed")],
  );
  expect(task?.status).toBe("failed");
  expect(task?.steps.some((s) => s.runId === "researcher/2026-07-02-run1" && s.status === "failed")).toBe(true);
});
