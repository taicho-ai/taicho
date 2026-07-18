/** Plan 25: workflow RUN state — the append-only event log, one directory per run.
 *
 *    workflows/<wfId>/runs/<runId>/events.jsonl   append-only step transitions, engine-written
 *
 *  Current state = fold(events): the last event per step wins; a step with no event is pending. This is
 *  the Plan 18 plan discipline, minus the model-attempt/`rejected` split — the engine writes every event,
 *  so there is nothing to lie. reconcileWorkflowRuns is the boot half: a step left `running` means the
 *  process died in flight, so append `interrupted` (never rewrite history) and report it. */
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  WorkflowEvent, TERMINAL_STEP_STATUS,
  type WorkflowDef, type FoldedStep, type WorkflowRunState, type WorkflowRunStatus, type StepStatus,
} from "./schema";

const workflowPaths = {
  workflowsDir: (ws: string) => join(ws, "workflows"),
  workflowRunsDir: (ws: string, id: string) => join(ws, "workflows", id, "runs"),
  workflowRunDir: (ws: string, id: string, runId: string) => join(ws, "workflows", id, "runs", runId),
};

const eventsFile = (ws: string, wfId: string, runId: string) =>
  join(workflowPaths.workflowRunDir(ws, wfId, runId), "events.jsonl");

/** Mint a unique run id and create its directory. Exclusive-create the dir, retrying on collision — the
 *  same race-free idiom as writePlan/saveArtifact, so two concurrent runs can't claim one id. */
export function reserveWorkflowRun(ws: string, wfId: string): string {
  const runsDir = workflowPaths.workflowRunsDir(ws, wfId);
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
  mkdirSync(workflowPaths.workflowRunDir(ws, wfId, runId), { recursive: true });
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
    catch { /* tolerate a partial final JSONL line after process interruption */ }
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

/** Current state = fold(events) over the definition's steps. A run with a parked human gate reads as
 *  `parked` (not `running`) so the boot reconcile + the /workflows UI can distinguish "waiting on you"
 *  from "executing". */
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
  let status = overallStatus(steps);
  if (status === "running" && readParkedGate(ws, def.id, runId)) status = "parked";
  return { wfId: def.id, runId, steps, status, counts: { total: steps.length, done, open, failed } };
}

// ── durable gate suspension (Plan 25 Ph6) ─────────────────────────────────────────────────────────
// A workflow that reaches a human gate in an UNATTENDED run can't block on an in-memory Promise (the
// process may exit). Instead it PARKS: this marker persists next to the run's events, the run stops, and
// resumeWorkflow (core/workflow.ts) rebuilds the edge state from the events and continues once answered.

export interface ParkedGate {
  step: string;
  title: string;
  choices: string[];
  note?: string;
  at: string;
}

const parkedFile = (ws: string, wfId: string, runId: string) => join(workflowPaths.workflowRunDir(ws, wfId, runId), "parked.json");

export function parkGate(ws: string, wfId: string, runId: string, gate: Omit<ParkedGate, "at">): ParkedGate {
  const g: ParkedGate = { ...gate, at: new Date().toISOString() };
  mkdirSync(workflowPaths.workflowRunDir(ws, wfId, runId), { recursive: true });
  writeFileSync(parkedFile(ws, wfId, runId), JSON.stringify(g, null, 2));
  return g;
}

export function readParkedGate(ws: string, wfId: string, runId: string): ParkedGate | null {
  const f = parkedFile(ws, wfId, runId);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")) as ParkedGate; }
  catch { return null; }
}

export function clearParkedGate(ws: string, wfId: string, runId: string): void {
  const f = parkedFile(ws, wfId, runId);
  if (existsSync(f)) rmSync(f);
}

/** Every workflow run currently parked at a human gate — for the boot notice + the /workflows UI. */
export function listParkedGates(ws: string): { wfId: string; runId: string; gate: ParkedGate }[] {
  const out: { wfId: string; runId: string; gate: ParkedGate }[] = [];
  for (const wfId of subdirs(workflowPaths.workflowsDir(ws))) {
    for (const runId of listWorkflowRunIds(ws, wfId)) {
      const gate = readParkedGate(ws, wfId, runId);
      if (gate) out.push({ wfId, runId, gate });
    }
  }
  return out;
}

const subdirs = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];

export function listWorkflowRunIds(ws: string, wfId: string): string[] {
  return subdirs(workflowPaths.workflowRunsDir(ws, wfId));
}

/** Boot reconcile: a step left `running` means the process died in flight. Append `interrupted` and report
 *  it, without touching the definition — the step is still what the workflow meant to do. */
export function reconcileWorkflowRuns(ws: string): { wfId: string; runId: string; step: string }[] {
  const interrupted: { wfId: string; runId: string; step: string }[] = [];
  for (const wfId of subdirs(workflowPaths.workflowsDir(ws))) {
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
