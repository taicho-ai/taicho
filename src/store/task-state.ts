/** Task state separates "the model replied" from "the requested work is actually done".
 *
 *  Plan 04 promotes this from a write-only per-turn audit record into a persistent TASK QUEUE:
 *  a task can outlive the turn that created it (a background `dispatch_task`), survives a restart
 *  (files under tasks/ are canon; a rebuildable SQLite `tasks` table is the query index), and is
 *  listable/cancellable via `/tasks`. A synchronous chat turn is just a task the captain watches. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { paths } from "./files";
import type { RunTrace, VerificationVerdict } from "../schemas/trace";

export type TaskStepStatus = "not_started" | "running" | "completed" | "failed" | "blocked" | "interrupted" | "verified";
/** Task lifecycle. `queued` (dispatched, awaiting a concurrency slot) and `cancelled` are Plan 04
 *  additions for background tasks; the rest are shared with the watched-turn (chat) path. */
export type TaskStatus =
  | "requested" | "queued" | "running" | "completed" | "partial"
  | "failed" | "blocked" | "interrupted" | "cancelled";

/** A criteria→verdict record surfaced from a delegation's independent check (Plan 06). Replaces the
 *  never-populated `verifiedClaims`: this field is populated from trace.verification (root + children). */
export interface TaskVerification {
  criteria: string;
  verdict: VerificationVerdict;
  runId: string;      // the checked child run
  retried: boolean;
}

export type TaskKind = "chat" | "background";

export interface TaskState {
  taskId: string;
  title: string;
  status: TaskStatus;
  created: string;
  updated: string;
  rootRunId: string;
  userTurnId?: string;
  kind?: TaskKind;         // "chat" (a turn the captain watches) | "background" (dispatch_task); default chat
  agent?: string;          // the agent this task runs on (target of a dispatch)
  goal?: string;           // the dispatched goal (background tasks); chat tasks use `title`
  resultRef?: string;      // hand-off BY REFERENCE: an artifact handle (id@vN) or the root run id
  summary?: string;        // short settle summary (truncated); check_task returns this, never a payload
  steps: { name: string; status: TaskStepStatus; runId?: string; details?: string }[];
  verifications: TaskVerification[];
}

const SUMMARY_CAP = 500;

function taskFile(ws: string, taskId: string): string {
  return join(paths.taskDir(ws), `${taskId}.json`);
}

export function taskIdForRun(runId: string): string {
  return `task_${runId.replace("/", "_")}`;
}

/** A fresh id for a background task — created before its run reserves a runId (dispatch returns the
 *  taskId immediately), so it can't derive from the runId the way a watched-turn task does. */
export function mkTaskId(): string {
  return `task_bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function writeTask(ws: string, task: TaskState, db?: Database): void {
  mkdirSync(paths.taskDir(ws), { recursive: true });
  writeFileSync(taskFile(ws, task.taskId), JSON.stringify(task, null, 2));
  if (db) indexTask(db, task);
}

// ── SQLite index (rebuildable from files; the query surface for /tasks) ──────────────────────────

export function indexTask(db: Database, task: TaskState): void {
  db.query(
    `INSERT INTO tasks (id, agent, goal, status, kind, root_run_id, result_ref, summary, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       agent=excluded.agent, goal=excluded.goal, status=excluded.status, kind=excluded.kind,
       root_run_id=excluded.root_run_id, result_ref=excluded.result_ref, summary=excluded.summary,
       updated=excluded.updated`,
  ).run(
    task.taskId, task.agent ?? null, task.goal ?? task.title, task.status, task.kind ?? "chat",
    task.rootRunId || null, task.resultRef ?? null, task.summary ?? null, task.created, task.updated,
  );
}

export interface TaskIndexRow {
  id: string; agent: string | null; goal: string | null; status: TaskStatus;
  kind: TaskKind; root_run_id: string | null; result_ref: string | null;
  summary: string | null; created: string | null; updated: string | null;
}

/** List indexed tasks, newest-updated first. `activeOrBackground` (the `/tasks` default view) hides
 *  the noise of completed watched turns: only background tasks + any non-terminal task show. */
export function listTaskIndex(db: Database, opts: { activeOrBackground?: boolean } = {}): TaskIndexRow[] {
  const rows = opts.activeOrBackground
    ? db.query<TaskIndexRow, []>(
        `SELECT * FROM tasks WHERE kind = 'background' OR status IN ('queued','running','interrupted','requested')
         ORDER BY updated DESC`,
      ).all()
    : db.query<TaskIndexRow, []>(`SELECT * FROM tasks ORDER BY updated DESC`).all();
  return rows;
}

/** Rebuild the tasks index from the canonical tasks/*.json files (files are truth; DB is a cache). */
export function reindexTasks(ws: string, db: Database): number {
  db.query("DELETE FROM tasks").run();
  const dir = paths.taskDir(ws);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const task = JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskState;
      indexTask(db, task);
      n++;
    } catch { /* skip an unparseable/partial task file */ }
  }
  return n;
}

// ── lifecycle ────────────────────────────────────────────────────────────────────────────────────

export function createTaskState(ws: string, input: { runId: string; title: string; userTurnId?: string }, db?: Database): TaskState {
  const now = new Date().toISOString();
  const task: TaskState = {
    taskId: taskIdForRun(input.runId),
    title: input.title,
    status: "running",
    created: now,
    updated: now,
    rootRunId: input.runId,
    userTurnId: input.userTurnId,
    kind: "chat",
    agent: input.runId.split("/")[0],
    goal: input.title,
    steps: [{ name: "root_run", status: "running", runId: input.runId }],
    verifications: [],
  };
  writeTask(ws, task, db);
  return task;
}

/** Create a persistent BACKGROUND task record (Plan 04) in status `queued`. rootRunId is unknown
 *  until the detached run reserves it — patched in later via setTaskFields. */
export function createBackgroundTask(ws: string, db: Database, input: { taskId: string; agent: string; goal: string }): TaskState {
  const now = new Date().toISOString();
  const task: TaskState = {
    taskId: input.taskId,
    title: input.goal,
    status: "queued",
    created: now,
    updated: now,
    rootRunId: "",
    kind: "background",
    agent: input.agent,
    goal: input.goal,
    steps: [{ name: "root_run", status: "not_started" }],
    verifications: [],
  };
  writeTask(ws, task, db);
  return task;
}

export function readTaskState(ws: string, taskId: string): TaskState | null {
  const f = taskFile(ws, taskId);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")) as TaskState;
}

/** Patch a task's mutable fields (status/rootRunId/result/summary) on the file AND the index. */
export function setTaskFields(
  ws: string,
  db: Database,
  taskId: string,
  patch: Partial<Pick<TaskState, "status" | "rootRunId" | "resultRef" | "summary">> & { stepStatus?: TaskStepStatus },
): TaskState | null {
  const task = readTaskState(ws, taskId);
  if (!task) return null;
  if (patch.status) task.status = patch.status;
  if (patch.rootRunId !== undefined) {
    task.rootRunId = patch.rootRunId;
    if (task.steps[0]) task.steps[0].runId = patch.rootRunId;
  }
  if (patch.resultRef !== undefined) task.resultRef = patch.resultRef;
  if (patch.summary !== undefined) task.summary = patch.summary.slice(0, SUMMARY_CAP);
  if (patch.stepStatus && task.steps[0]) task.steps[0].status = patch.stepStatus;
  task.updated = new Date().toISOString();
  writeTask(ws, task, db);
  return task;
}

/** Mark a task cancelled (the caller aborts the live run separately). No-op if already terminal. */
export function cancelTaskState(ws: string, db: Database, taskId: string): TaskState | null {
  const task = readTaskState(ws, taskId);
  if (!task) return null;
  if (["completed", "failed", "cancelled"].includes(task.status)) return task;
  task.status = "cancelled";
  task.updated = new Date().toISOString();
  writeTask(ws, task, db);
  return task;
}

/** Boot reconciliation (Plan 04 Phase 5): a task left `running`/`queued` means the process died
 *  mid-flight — mark it `interrupted`. Returns the reconciled tasks so the captain can be told
 *  (report-and-ask; auto-resume is deferred per the closed Phase 0 decision). */
export function reconcileTasks(ws: string, db: Database): TaskState[] {
  const dir = paths.taskDir(ws);
  if (!existsSync(dir)) return [];
  const reconciled: TaskState[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let task: TaskState;
    try { task = JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskState; }
    catch { continue; }
    if (task.status === "running" || task.status === "queued") {
      task.status = "interrupted";
      if (task.steps[0] && task.steps[0].status === "running") task.steps[0].status = "interrupted";
      task.updated = new Date().toISOString();
      writeTask(ws, task, db);
      reconciled.push(task);
    } else {
      indexTask(db, task); // keep the index consistent with every file, reconciled or not
    }
  }
  return reconciled;
}

export function updateTaskFromTrace(ws: string, taskId: string, trace: RunTrace, children: RunTrace[] = [], db?: Database): TaskState | null {
  const task = readTaskState(ws, taskId);
  if (!task) return null;
  const outcomeToStep = (outcome: RunTrace["outcome"]): TaskStepStatus => outcome === "completed" ? "completed" : outcome;
  task.updated = new Date().toISOString();
  task.rootRunId = task.rootRunId || trace.id;
  task.steps = task.steps.filter((s) => s.name === "root_run");
  task.steps[0] = { name: "root_run", status: outcomeToStep(trace.outcome), runId: trace.id };
  for (const child of children) {
    task.steps.push({ name: `child:${child.agent}`, status: outcomeToStep(child.outcome), runId: child.id, details: child.task });
  }
  // Populate the verification record from the checks this run (and its children) actually ran.
  task.verifications = [trace, ...children].flatMap((t) =>
    (t.verification ?? []).map((v) => ({ criteria: v.criteria, verdict: v.verdict, runId: v.runId, retried: v.retried })),
  );
  if (trace.outcome === "completed" && children.every((c) => c.outcome === "completed")) task.status = "completed";
  else if (trace.outcome === "blocked" || children.some((c) => c.outcome === "blocked")) task.status = "blocked";
  else if (trace.outcome === "interrupted" || children.some((c) => c.outcome === "interrupted")) task.status = "interrupted";
  else if (trace.outcome === "failed" || children.some((c) => c.outcome === "failed")) task.status = "failed";
  else task.status = "partial";
  writeTask(ws, task, db);
  return task;
}
