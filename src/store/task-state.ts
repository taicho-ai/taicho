/** Task state separates "the model replied" from "the requested work is actually done". */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./files";
import type { RunTrace, VerificationVerdict } from "../schemas/trace";

export type TaskStepStatus = "not_started" | "running" | "completed" | "failed" | "blocked" | "interrupted" | "verified";
export type TaskStatus = "requested" | "running" | "completed" | "partial" | "failed" | "blocked" | "interrupted";

/** A criteria→verdict record surfaced from a delegation's independent check (Plan 06). Replaces the
 *  never-populated `verifiedClaims`: this field is populated from trace.verification (root + children). */
export interface TaskVerification {
  criteria: string;
  verdict: VerificationVerdict;
  runId: string;      // the checked child run
  retried: boolean;
}

export interface TaskState {
  taskId: string;
  title: string;
  status: TaskStatus;
  created: string;
  updated: string;
  rootRunId: string;
  userTurnId?: string;
  steps: { name: string; status: TaskStepStatus; runId?: string; details?: string }[];
  verifications: TaskVerification[];
}

function taskFile(ws: string, taskId: string): string {
  return join(paths.taskDir(ws), `${taskId}.json`);
}

export function taskIdForRun(runId: string): string {
  return `task_${runId.replace("/", "_")}`;
}

export function createTaskState(ws: string, input: { runId: string; title: string; userTurnId?: string }): TaskState {
  mkdirSync(paths.taskDir(ws), { recursive: true });
  const now = new Date().toISOString();
  const task: TaskState = {
    taskId: taskIdForRun(input.runId),
    title: input.title,
    status: "running",
    created: now,
    updated: now,
    rootRunId: input.runId,
    userTurnId: input.userTurnId,
    steps: [{ name: "root_run", status: "running", runId: input.runId }],
    verifications: [],
  };
  writeFileSync(taskFile(ws, task.taskId), JSON.stringify(task, null, 2));
  return task;
}

export function readTaskState(ws: string, taskId: string): TaskState | null {
  const f = taskFile(ws, taskId);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")) as TaskState;
}

export function updateTaskFromTrace(ws: string, taskId: string, trace: RunTrace, children: RunTrace[] = []): TaskState | null {
  const task = readTaskState(ws, taskId);
  if (!task) return null;
  const outcomeToStep = (outcome: RunTrace["outcome"]): TaskStepStatus => outcome === "completed" ? "completed" : outcome;
  task.updated = new Date().toISOString();
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
  writeFileSync(taskFile(ws, task.taskId), JSON.stringify(task, null, 2));
  return task;
}
