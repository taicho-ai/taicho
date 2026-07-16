/** Plan 25: workflow RUN state — the append-only event log, one directory per run.
 *
 *    workflows/<wfId>/runs/<runId>/events.jsonl   append-only step transitions, engine-written
 *
 *  Current state = fold(events): the last event per step wins; a step with no event is pending. This is
 *  the Plan 18 plan discipline, minus the model-attempt/`rejected` split — the engine writes every event,
 *  so there is nothing to lie. reconcileWorkflowRuns is the boot half: a step left `running` means the
 *  process died in flight, so append `interrupted` (never rewrite history) and report it. */
import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./files";
import { log } from "../core/logger";
import {
  WorkflowEvent, TERMINAL_STEP_STATUS,
  type WorkflowDef, type FoldedStep, type WorkflowRunState, type WorkflowRunStatus, type StepStatus,
} from "../schemas/workflow";

const eventsFile = (ws: string, wfId: string, runId: string) =>
  join(paths.workflowRunDir(ws, wfId, runId), "events.jsonl");

/** Mint a unique run id and create its directory. Exclusive-create the dir, retrying on collision — the
 *  same race-free idiom as writePlan/saveArtifact, so two concurrent runs can't claim one id. */
export function reserveWorkflowRun(ws: string, wfId: string): string {
  const runsDir = paths.workflowRunsDir(ws, wfId);
  mkdirSync(runsDir, { recursive: true });
  for (let n = 1; n < 100_000; n++) {
    const runId = `wr_${wfId}_${n}`;
    try {
      mkdirSync(join(runsDir, runId)); // no recursive: fails with EEXIST if taken
      return runId;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`could not reserve a workflow run id for "${wfId}" (100000 collisions)`);
}

/** Append one step transition. Stamps `ts` if absent. */
export function appendWorkflowEvent(
  ws: string,
  wfId: string,
  runId: string,
  event: Omit<WorkflowEvent, "ts"> & { ts?: string },
): WorkflowEvent {
  const e = WorkflowEvent.parse({ ...event, ts: event.ts ?? new Date().toISOString() });
  mkdirSync(paths.workflowRunDir(ws, wfId, runId), { recursive: true });
  appendFileSync(eventsFile(ws, wfId, runId), JSON.stringify(e) + "\n");
  return e;
}

export function readWorkflowEvents(ws: string, wfId: string, runId: string): WorkflowEvent[] {
  const f = eventsFile(ws, wfId, runId);
  if (!existsSync(f)) return [];
  const out: WorkflowEvent[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(WorkflowEvent.parse(JSON.parse(line))); }
    catch (e) { log.warn(`skipping malformed workflow event in ${wfId}/${runId}`, e); }
  }
  return out;
}

/** Last event per step wins. */
function foldEvents(events: WorkflowEvent[]): Map<string, WorkflowEvent> {
  const byStep = new Map<string, WorkflowEvent>();
  for (const e of events) byStep.set(e.step, e);
  return byStep;
}

function overallStatus(steps: FoldedStep[]): WorkflowRunStatus {
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "interrupted")) return "interrupted";
  if (steps.some((s) => s.status === "running" || s.status === "pending")) return "running";
  return "done";
}

/** Current state = fold(events) over the definition's steps. */
export function foldWorkflowRun(ws: string, def: WorkflowDef, runId: string): WorkflowRunState {
  const latest = foldEvents(readWorkflowEvents(ws, def.id, runId));
  const steps: FoldedStep[] = def.steps.map((s) => {
    const e = latest.get(s.id);
    return e
      ? { id: s.id, kind: s.kind, status: e.status, produced: e.produced, choice: e.choice, note: e.note, updated: e.ts }
      : { id: s.id, kind: s.kind, status: "pending" as StepStatus };
  });
  const done = steps.filter((s) => s.status === "done").length;
  const failed = steps.filter((s) => s.status === "failed" || s.status === "interrupted").length;
  const open = steps.filter((s) => !TERMINAL_STEP_STATUS.has(s.status)).length;
  return { wfId: def.id, runId, steps, status: overallStatus(steps), counts: { total: steps.length, done, open, failed } };
}

const subdirs = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];

export function listWorkflowRunIds(ws: string, wfId: string): string[] {
  return subdirs(paths.workflowRunsDir(ws, wfId));
}

/** Boot reconcile: a step left `running` means the process died in flight. Append `interrupted` and report
 *  it, without touching the definition — the step is still what the workflow meant to do. */
export function reconcileWorkflowRuns(ws: string): { wfId: string; runId: string; step: string }[] {
  const interrupted: { wfId: string; runId: string; step: string }[] = [];
  for (const wfId of subdirs(paths.workflowsDir(ws))) {
    for (const runId of listWorkflowRunIds(ws, wfId)) {
      const latest = foldEvents(readWorkflowEvents(ws, wfId, runId));
      for (const [step, e] of latest) {
        if (e.status !== "running") continue;
        appendWorkflowEvent(ws, wfId, runId, {
          step, status: "interrupted", runId: "boot",
          note: "the process exited while this step was in flight",
        });
        interrupted.push({ wfId, runId, step });
      }
    }
  }
  return interrupted;
}
