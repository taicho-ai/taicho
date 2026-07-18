import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTaskState, taskIdForRun, updateTaskFromTrace, mkTaskId,
  createBackgroundTask, setTaskFields, cancelTaskState, listTaskIndex, reconcileTasks, reindexTasks, readTaskState,
} from "./task-state";
import { openDb } from "./db";
import { RunTrace } from "@taicho/contracts/trace";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-task-"));
function boot() {
  const w = ws();
  const db = openDb(w);
  return { w, db };
}

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

// ── Plan 04: persistent background task queue ─────────────────────────────────────────────────────

test("createBackgroundTask persists a queued task file AND indexes it in the DB", () => {
  const { w, db } = boot();
  const taskId = mkTaskId();
  createBackgroundTask(w, db, { taskId, agent: "researcher", goal: "research fusion" });
  const rec = readTaskState(w, taskId);
  expect(rec?.status).toBe("queued");
  expect(rec?.kind).toBe("background");
  expect(rec?.agent).toBe("researcher");
  const rows = listTaskIndex(db, { activeOrBackground: true });
  expect(rows.map((r) => r.id)).toContain(taskId);
  expect(rows.find((r) => r.id === taskId)?.status).toBe("queued");
});

test("setTaskFields moves a task through its lifecycle on both the file and the index", () => {
  const { w, db } = boot();
  const taskId = mkTaskId();
  createBackgroundTask(w, db, { taskId, agent: "w", goal: "g" });
  setTaskFields(w, db, taskId, { status: "running", stepStatus: "running", rootRunId: "w/2026-07-04-run1" });
  expect(readTaskState(w, taskId)?.status).toBe("running");
  setTaskFields(w, db, taskId, { status: "completed", resultRef: "dossier@v1", summary: "done, see dossier" });
  const rec = readTaskState(w, taskId);
  expect(rec?.status).toBe("completed");
  expect(rec?.resultRef).toBe("dossier@v1");
  expect(rec?.rootRunId).toBe("w/2026-07-04-run1");
  expect(listTaskIndex(db)[0]?.status).toBe("completed"); // index reflects the terminal state
});

test("summary is capped so check_task never returns a giant payload", () => {
  const { w, db } = boot();
  const taskId = mkTaskId();
  createBackgroundTask(w, db, { taskId, agent: "w", goal: "g" });
  setTaskFields(w, db, taskId, { summary: "x".repeat(5000) });
  expect(readTaskState(w, taskId)!.summary!.length).toBe(500);
});

test("cancelTaskState marks a task cancelled but never clobbers an already-terminal one", () => {
  const { w, db } = boot();
  const live = mkTaskId(), doneId = mkTaskId();
  createBackgroundTask(w, db, { taskId: live, agent: "w", goal: "g" });
  createBackgroundTask(w, db, { taskId: doneId, agent: "w", goal: "g" });
  setTaskFields(w, db, doneId, { status: "completed" });
  expect(cancelTaskState(w, db, live)?.status).toBe("cancelled");
  expect(cancelTaskState(w, db, doneId)?.status).toBe("completed"); // terminal wins
});

test("cancelTaskState leaves EVERY terminal outcome intact (guard aligned with TERMINAL_TASK_STATUS)", () => {
  // Regression: the cancel guard used to be narrower than the await guard ({completed,failed,cancelled}),
  // so /tasks cancel on an already-blocked/interrupted/partial task overwrote its recorded outcome.
  const { w, db } = boot();
  for (const status of ["blocked", "interrupted", "partial", "failed"] as const) {
    const id = mkTaskId();
    createBackgroundTask(w, db, { taskId: id, agent: "w", goal: "g" });
    setTaskFields(w, db, id, { status });
    expect(cancelTaskState(w, db, id)?.status).toBe(status); // outcome preserved, not clobbered to "cancelled"
  }
});

test("reconcileTasks marks running/queued as interrupted on boot and returns them (report-and-ask)", () => {
  const { w, db } = boot();
  const running = mkTaskId(), queued = mkTaskId(), done = mkTaskId();
  createBackgroundTask(w, db, { taskId: running, agent: "w", goal: "r" });
  setTaskFields(w, db, running, { status: "running", stepStatus: "running" });
  createBackgroundTask(w, db, { taskId: queued, agent: "w", goal: "q" }); // stays queued
  createBackgroundTask(w, db, { taskId: done, agent: "w", goal: "d" });
  setTaskFields(w, db, done, { status: "completed" });

  // Simulate a fresh boot on the same workspace: a new DB (index gone), then reconcile.
  const db2 = openDb(w);
  reindexTasks(w, db2);
  const interrupted = reconcileTasks(w, db2);
  const ids = interrupted.map((t) => t.taskId).sort();
  expect(ids).toEqual([running, queued].sort());
  expect(readTaskState(w, running)?.status).toBe("interrupted");
  expect(readTaskState(w, queued)?.status).toBe("interrupted");
  expect(readTaskState(w, done)?.status).toBe("completed"); // untouched
});

test("reindexTasks rebuilds the index from the canonical task files (files are truth)", () => {
  const { w, db } = boot();
  const t1 = mkTaskId(), t2 = mkTaskId();
  createBackgroundTask(w, db, { taskId: t1, agent: "a", goal: "g1" });
  createBackgroundTask(w, db, { taskId: t2, agent: "b", goal: "g2" });
  // Wipe the index; a rebuild from files must restore it.
  db.query("DELETE FROM tasks").run();
  expect(listTaskIndex(db).length).toBe(0);
  const n = reindexTasks(w, db);
  expect(n).toBe(2);
  expect(listTaskIndex(db).map((r) => r.id).sort()).toEqual([t1, t2].sort());
});

test("the /tasks default view hides completed chat turns but shows background + in-flight tasks", () => {
  const { w, db } = boot();
  // a completed watched-turn (chat) task — should be hidden from the active view
  createTaskState(w, { runId: "root/2026-07-04-run9", title: "hi" }, db);
  updateTaskFromTrace(w, taskIdForRun("root/2026-07-04-run9"), trace("root/2026-07-04-run9", "completed"), [], db);
  // a background task — always shown
  const bg = mkTaskId();
  createBackgroundTask(w, db, { taskId: bg, agent: "w", goal: "g" });
  const active = listTaskIndex(db, { activeOrBackground: true }).map((r) => r.id);
  expect(active).toContain(bg);
  expect(active).not.toContain(taskIdForRun("root/2026-07-04-run9"));
  // the unfiltered view still has both
  expect(listTaskIndex(db).length).toBe(2);
});

test("Plan 20: writeTask is atomic — temp+rename, no .tmp residue, record round-trips", () => {
  const { w, db } = boot();
  createBackgroundTask(w, db, { taskId: "task_bg_atomic", agent: "a", goal: "g" });
  const dir = join(w, "tasks");
  const files = require("node:fs").readdirSync(dir) as string[];
  expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);       // no temp residue after a write
  expect(files).toContain("task_bg_atomic.json");
  expect(readTaskState(w, "task_bg_atomic")!.goal).toBe("g");        // the renamed file round-trips
});
