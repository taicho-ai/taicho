/** Plan 25: the workflow DRIVER — a sixth caller above executeRun.
 *
 *  It holds the edge state (an artifact-name → handle map), walks a cursor over the steps, and dispatches
 *  per node kind. The engine owns step status: no node writes its own `done` — the driver writes it from
 *  the step-runner's real outcome, the checker verdict, or the human's choice. State flows step→step by
 *  artifact REFERENCE (a step's `produces` becomes the next step's `consumes` input), exactly as delegation
 *  hands work down today.
 *
 *  The step-runner, checker, gate, and classifier are INJECTED so the orchestration is unit-testable without
 *  a live model; run.ts wires them to executeRun / runChecker / requestApproval.
 *
 *  DURABLE SUSPENSION (Ph6): in `parkGates` mode a human gate PARKS instead of blocking — a marker persists,
 *  the run stops with status "parked", and `resumeWorkflow` later rebuilds the edge state FROM THE EVENTS
 *  (each done step's produced handle) and drives the rest. That is what lets an unattended/scheduled workflow
 *  wait for the captain across a restart. */
import {
  reserveWorkflowRun, appendWorkflowEvent, foldWorkflowRun,
  parkGate, readParkedGate, clearParkedGate,
} from "../store/workflow-runs";
import type { WorkflowDef, WorkflowNode, WorkflowRunState, StepStatus } from "../schemas/workflow";

export type RunOutcome = "completed" | "blocked" | "failed" | "interrupted";
export interface AgentStepRun {
  childRunId: string;
  outcome: RunOutcome;
  produced?: string;
}
type AgentNode = Extract<WorkflowNode, { kind: "agent" }>;
type CheckNode = Extract<WorkflowNode, { kind: "check" }>;
type HumanNode = Extract<WorkflowNode, { kind: "human" }>;
type BranchNode = Extract<WorkflowNode, { kind: "branch" }>;

export interface ReviewPacketItem { name: string; handle: string; }
/** What a human gate lays in front of the captain — handles + names, never bodies. */
export interface ReviewPacket { primary?: string; items: ReviewPacketItem[]; }
export interface GateDecision { choice: string; note?: string; }

/** The agent-step SHAPE runAgent receives — a top-level agent node, a parallel branch (no `kind`), or a
 *  synthetic join. Untagged, so all three are assignable without normalizing branches. */
export type AgentStepInput = { id: string; run: string; brief?: string; consumes: string[]; produces?: string; criteria?: string };

export interface WorkflowExecDeps {
  ws: string;
  /** Run one agent step to completion. run.ts wires this to executeRun; tests inject a recorder. */
  runAgent: (a: { step: AgentStepInput; brief: string; inputs: string[]; runId: string; triggeredBy: string }) => Promise<AgentStepRun>;
  /** Verify an artifact against criteria (run.ts wires to runChecker). Required if the def has a check. */
  runCheck?: (a: { node: CheckNode; target?: string; attempt: number }) => Promise<{ pass: boolean; reasons: string[] }>;
  /** Ask the captain (run.ts wires to requestApproval). Returns null when cancelled. Required for ATTENDED human gates. */
  requestGate?: (a: { node: HumanNode; packet: ReviewPacket; runId: string }) => Promise<GateDecision | null>;
  /** Classify the input into one of a branch's route labels. Required if the def has a branch. */
  classify?: (a: { node: BranchNode; target?: string }) => Promise<string>;
  /** Read a list artifact into its items — required for a `parallel over:` (map) step. */
  listItems?: (handle: string) => Promise<string[]>;
  /** Ph6: park a human gate (persist + stop) instead of blocking — for UNATTENDED (scheduled/headless) runs. */
  parkGates?: boolean;
  signal?: AbortSignal;
}

export interface WorkflowInput {
  artifacts?: { name: string; handle: string }[];
}

const present = (h: string | undefined): h is string => !!h;

function composeBrief(def: WorkflowDef, node: { brief?: string }): string {
  return [def.brief, node.brief].filter((s): s is string => !!s && s.trim().length > 0).join("\n\n");
}

function statusFor(outcome: RunOutcome): StepStatus {
  switch (outcome) {
    case "completed": return "done";
    case "interrupted": return "interrupted";
    default: return "failed"; // blocked | failed
  }
}

function buildPacket(node: HumanNode, edge: Map<string, string>, lastProduced?: string): ReviewPacket {
  const names = node.shows ?? [...edge.keys()];
  const items = names.filter((n) => edge.has(n)).map((n) => ({ name: n, handle: edge.get(n)! }));
  return { primary: lastProduced ?? items[items.length - 1]?.handle, items };
}

/** Rebuild the edge state (artifact NAME → handle) from a run's PERSISTED events — the key to resuming a
 *  parked run in a fresh process: each done agent/parallel step's produced handle re-maps to its name. */
function rebuildEdge(ws: string, def: WorkflowDef, runId: string): Map<string, string> {
  const edge = new Map<string, string>();
  for (const s of foldWorkflowRun(ws, def, runId).steps) {
    if (!s.produced) continue;
    const node = def.steps.find((n) => n.id === s.id);
    const name = node && (node.kind === "agent" || node.kind === "parallel") ? node.produces : undefined;
    if (name) edge.set(name, s.produced);
  }
  return edge;
}

interface DriveState {
  runId: string;
  edge: Map<string, string>;
  cursor: string | null;
  attempts: Map<string, number>;
  lastProduced?: string;
}

/** The shared loop. Both a fresh run (executeWorkflow) and a resumed one (resumeWorkflow) call this. */
async function drive(deps: WorkflowExecDeps, def: WorkflowDef, state: DriveState): Promise<WorkflowRunState> {
  const { ws } = deps;
  const { runId, edge, attempts } = state;
  const emit = (e: Parameters<typeof appendWorkflowEvent>[3]) => appendWorkflowEvent(ws, def.id, runId, e);
  const inputsFor = (names: string[]) => names.map((n) => edge.get(n)).filter(present);
  const indexById = new Map(def.steps.map((s, i) => [s.id, i] as const));
  const successor = (idx: number): string | null => def.steps[idx + 1]?.id ?? null;

  let cursor = state.cursor;
  let lastProduced = state.lastProduced;
  let ended: "completed" | "failed" | "interrupted" | "parked" = "completed";

  while (cursor) {
    const idx = indexById.get(cursor);
    if (idx === undefined) throw new Error(`workflow "${def.id}" routes to unknown step "${cursor}"`);
    const node = def.steps[idx]!;

    if (deps.signal?.aborted) { emit({ step: node.id, status: "interrupted", runId }); ended = "interrupted"; break; }
    emit({ step: node.id, status: "running", runId });

    if (node.kind === "agent") {
      const res = await deps.runAgent({
        step: node, brief: composeBrief(def, node), inputs: inputsFor(node.consumes),
        runId, triggeredBy: `workflow:${def.id}:${node.id}`,
      });
      if (node.produces && res.produced) { edge.set(node.produces, res.produced); lastProduced = res.produced; }
      const status = statusFor(res.outcome);
      emit({ step: node.id, runId: res.childRunId, produced: res.produced, status, note: res.outcome === "completed" ? undefined : `agent run ${res.outcome}` });
      if (status !== "done") { ended = status === "interrupted" ? "interrupted" : "failed"; cursor = null; break; }
      cursor = successor(idx);
      continue;
    }

    if (node.kind === "check") {
      if (!deps.runCheck) throw new Error(`workflow "${def.id}" has a check step "${node.id}" but no checker is wired`);
      const attempt = (attempts.get(node.id) ?? 0) + 1;
      attempts.set(node.id, attempt);
      const target = node.of ? edge.get(node.of) : lastProduced;
      const v = await deps.runCheck({ node, target, attempt });
      if (v.pass) { emit({ step: node.id, status: "done", runId, attempt }); cursor = successor(idx); }
      else if (node.on_fail && attempt < node.max_attempts) { emit({ step: node.id, status: "failed", runId, attempt, note: v.reasons.join("; ") || "check failed" }); cursor = node.on_fail; }
      else { emit({ step: node.id, status: "failed", runId, attempt, note: v.reasons.join("; ") || "check failed, no attempts left" }); ended = "failed"; cursor = null; }
      continue;
    }

    if (node.kind === "human") {
      const packet = buildPacket(node, edge, lastProduced);
      if (deps.parkGates) { // UNATTENDED — persist + stop; resumeWorkflow continues later.
        parkGate(ws, def.id, runId, { step: node.id, title: node.human, choices: node.choices });
        ended = "parked"; cursor = null; break;
      }
      if (!deps.requestGate) throw new Error(`workflow "${def.id}" has a human step "${node.id}" but no gate is wired`);
      const d = await deps.requestGate({ node, packet, runId });
      if (!d) { emit({ step: node.id, status: "interrupted", runId }); ended = "interrupted"; cursor = null; break; }
      emit({ step: node.id, status: "done", runId, choice: d.choice, note: d.note });
      cursor = node.routes[d.choice] ?? successor(idx);
      continue;
    }

    if (node.kind === "branch") {
      if (!deps.classify) throw new Error(`workflow "${def.id}" has a branch step "${node.id}" but no classifier is wired`);
      const label = await deps.classify({ node, target: node.of ? edge.get(node.of) : lastProduced });
      const next = node.routes[label];
      emit({ step: node.id, status: "done", runId, choice: label, note: next ? undefined : `no route for "${label}", falling through` });
      cursor = next ?? successor(idx);
      continue;
    }

    if (node.kind === "parallel") {
      // Build the fan-out: explicit `branches`, OR `over` a list artifact mapped through the `as` step.
      let fan: { step: AgentStepInput; brief: string; inputs: string[]; tag: string }[];
      if (node.over) {
        if (!deps.listItems) throw new Error(`workflow "${def.id}": parallel 'over' needs a list reader (step "${node.id}")`);
        if (!node.as) throw new Error(`workflow "${def.id}": parallel 'over' needs an 'as' step (step "${node.id}")`);
        const src = edge.get(node.over);
        const items = src ? await deps.listItems(src) : [];
        const asStep = node.as;
        fan = items.map((item, i) => ({
          step: { ...asStep, id: `${node.id}_${i}` },
          brief: `${composeBrief(def, asStep)}\n\nITEM ${i + 1}/${items.length}: ${item}`,
          inputs: inputsFor(asStep.consumes),
          tag: String(i),
        }));
      } else {
        fan = (node.branches ?? []).map((b) => ({ step: b, brief: composeBrief(def, b), inputs: inputsFor(b.consumes), tag: b.id }));
      }
      const results = await Promise.all(fan.map((f) =>
        deps.runAgent({ step: f.step, brief: f.brief, inputs: f.inputs, runId, triggeredBy: `workflow:${def.id}:${node.id}:${f.tag}` })));
      const producedHandles: string[] = [];
      fan.forEach((f, i) => {
        const r = results[i]!;
        if (r.produced) {
          producedHandles.push(r.produced);
          lastProduced = r.produced;
          if (!node.over && f.step.produces) edge.set(f.step.produces, r.produced);
        }
      });
      if (results.some((r) => r.outcome !== "completed")) { emit({ step: node.id, status: "failed", runId, note: "a parallel run failed" }); ended = "failed"; cursor = null; continue; }
      if (node.join) {
        const joinInputs = node.over ? producedHandles : (node.branches ?? []).map((b) => b.produces).filter(present).map((n) => edge.get(n)).filter(present);
        const joinStep: AgentNode = { kind: "agent", id: `${node.id}__join`, run: node.join, consumes: [], produces: node.produces };
        const jr = await deps.runAgent({ step: joinStep, brief: composeBrief(def, {}), inputs: joinInputs, runId, triggeredBy: `workflow:${def.id}:${node.id}:join` });
        if (node.produces && jr.produced) { edge.set(node.produces, jr.produced); lastProduced = jr.produced; }
        if (jr.outcome !== "completed") { emit({ step: node.id, status: "failed", runId, note: "the parallel join failed" }); ended = "failed"; cursor = null; continue; }
      }
      emit({ step: node.id, status: "done", runId, produced: node.produces ? edge.get(node.produces) : undefined });
      cursor = successor(idx);
      continue;
    }

    throw new Error(`workflow "${def.id}" reached an unhandled step kind`);
  }

  // A clean end (ran off the last step, or a branch/route/human sent the cursor to null) leaves any
  // untaken steps `pending` — mark them `skipped` so the fold reads `done`, not stuck `running`. A parked/
  // failed/interrupted run leaves them as-is.
  if (ended === "completed") {
    for (const s of foldWorkflowRun(ws, def, runId).steps) {
      if (s.status === "pending") emit({ step: s.id, status: "skipped", runId });
    }
  }
  return foldWorkflowRun(ws, def, runId);
}

export async function executeWorkflow(deps: WorkflowExecDeps, def: WorkflowDef, input?: WorkflowInput): Promise<WorkflowRunState> {
  const runId = reserveWorkflowRun(deps.ws, def.id);
  const edge = new Map<string, string>();
  for (const a of input?.artifacts ?? []) edge.set(a.name, a.handle);
  return drive(deps, def, { runId, edge, cursor: def.steps[0]?.id ?? null, attempts: new Map() });
}

/** Ph6: answer a parked human gate and drive the rest. Rebuilds the edge state from the persisted events
 *  (so it works in a fresh process after a restart), settles the gate with the choice, and continues. */
export async function resumeWorkflow(
  deps: WorkflowExecDeps,
  def: WorkflowDef,
  runId: string,
  choice: string,
  note?: string,
): Promise<WorkflowRunState> {
  const parked = readParkedGate(deps.ws, def.id, runId);
  if (!parked) throw new Error(`workflow run "${runId}" is not parked`);
  const idx = def.steps.findIndex((n) => n.id === parked.step);
  const node = def.steps[idx];
  if (!node || node.kind !== "human") throw new Error(`parked step "${parked.step}" is not a human gate`);
  clearParkedGate(deps.ws, def.id, runId);
  appendWorkflowEvent(deps.ws, def.id, runId, { step: node.id, status: "done", runId, choice, note });
  const edge = rebuildEdge(deps.ws, def, runId);
  const cursor = node.routes[choice] ?? (def.steps[idx + 1]?.id ?? null);
  return drive(deps, def, { runId, edge, cursor, attempts: new Map() });
}
