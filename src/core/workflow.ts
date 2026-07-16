/** Plan 25: the workflow DRIVER — a sixth caller above executeRun.
 *
 *  It holds the edge state (an artifact-name → handle map), walks a cursor over the steps, and dispatches
 *  per node kind. The engine owns step status: no node writes its own `done` — the driver writes it from
 *  the step-runner's real outcome, the checker verdict, or the human's choice. State flows step→step by
 *  artifact REFERENCE (a step's `produces` becomes the next step's `consumes` input), exactly as delegation
 *  hands work down today.
 *
 *  The step-runner, checker, gate, and classifier are INJECTED so the orchestration is unit-testable without
 *  a live model; run.ts wires them to executeRun / runChecker / requestApproval. */
import { reserveWorkflowRun, appendWorkflowEvent, foldWorkflowRun } from "../store/workflow-runs";
import type { WorkflowDef, WorkflowNode, WorkflowRunState, StepStatus } from "../schemas/workflow";

export type RunOutcome = "completed" | "blocked" | "failed" | "interrupted";
export interface AgentStepRun {
  childRunId: string;
  outcome: RunOutcome;
  produced?: string;
}
type AgentNode = Extract<WorkflowNode, { kind: "agent" }>;
/** The agent-step SHAPE runAgent receives — a top-level agent node, a parallel branch (no `kind`), or a
 *  synthetic join. Untagged, so all three are assignable without normalizing branches. */
export type AgentStepInput = { id: string; run: string; brief?: string; consumes: string[]; produces?: string; criteria?: string };
type CheckNode = Extract<WorkflowNode, { kind: "check" }>;
type HumanNode = Extract<WorkflowNode, { kind: "human" }>;
type BranchNode = Extract<WorkflowNode, { kind: "branch" }>;

export interface ReviewPacketItem { name: string; handle: string; }
/** What a human gate lays in front of the captain — handles + names, never bodies. */
export interface ReviewPacket { primary?: string; items: ReviewPacketItem[]; }
export interface GateDecision { choice: string; note?: string; }

export interface WorkflowExecDeps {
  ws: string;
  /** Run one agent step to completion. run.ts wires this to executeRun; tests inject a recorder. */
  runAgent: (a: { step: AgentStepInput; brief: string; inputs: string[]; runId: string; triggeredBy: string }) => Promise<AgentStepRun>;
  /** Verify an artifact against criteria (run.ts wires to runChecker). Required if the def has a check. */
  runCheck?: (a: { node: CheckNode; target?: string; attempt: number }) => Promise<{ pass: boolean; reasons: string[] }>;
  /** Ask the captain (run.ts wires to requestApproval). Returns null when cancelled. Required for human gates. */
  requestGate?: (a: { node: HumanNode; packet: ReviewPacket; runId: string }) => Promise<GateDecision | null>;
  /** Classify the input into one of a branch's route labels. Required if the def has a branch. */
  classify?: (a: { node: BranchNode; target?: string }) => Promise<string>;
  signal?: AbortSignal;
}

export interface WorkflowInput {
  artifacts?: { name: string; handle: string }[];
}

const present = (h: string | undefined): h is string => !!h;

/** The layered brief a step's agent sees: the workflow-wide brief, then this step's own brief. */
function composeBrief(def: WorkflowDef, node: { brief?: string }): string {
  return [def.brief, node.brief].filter((s): s is string => !!s && s.trim().length > 0).join("\n\n");
}

/** The engine's own status from the child run's outcome — never the model's claim. */
function statusFor(outcome: RunOutcome): StepStatus {
  switch (outcome) {
    case "completed": return "done";
    case "interrupted": return "interrupted";
    default: return "failed"; // blocked | failed
  }
}

/** Assemble the packet a gate presents: the named `shows` artifacts (default: everything produced so far). */
function buildPacket(node: HumanNode, edge: Map<string, string>, lastProduced?: string): ReviewPacket {
  const names = node.shows ?? [...edge.keys()];
  const items = names.filter((n) => edge.has(n)).map((n) => ({ name: n, handle: edge.get(n)! }));
  return { primary: lastProduced ?? items[items.length - 1]?.handle, items };
}

export async function executeWorkflow(
  deps: WorkflowExecDeps,
  def: WorkflowDef,
  input?: WorkflowInput,
): Promise<WorkflowRunState> {
  const { ws } = deps;
  const runId = reserveWorkflowRun(ws, def.id);
  const edge = new Map<string, string>(); // artifact NAME → handle
  for (const a of input?.artifacts ?? []) edge.set(a.name, a.handle);
  const emit = (e: Parameters<typeof appendWorkflowEvent>[3]) => appendWorkflowEvent(ws, def.id, runId, e);
  const inputsFor = (names: string[]) => names.map((n) => edge.get(n)).filter(present);

  const indexById = new Map(def.steps.map((s, i) => [s.id, i] as const));
  const successor = (idx: number): string | null => def.steps[idx + 1]?.id ?? null;
  const attempts = new Map<string, number>();
  let lastProduced: string | undefined;
  let ended: "completed" | "failed" | "interrupted" = "completed";
  let cursor: string | null = def.steps[0]?.id ?? null;

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
      if (v.pass) {
        emit({ step: node.id, status: "done", runId, attempt });
        cursor = successor(idx);
      } else if (node.on_fail && attempt < node.max_attempts) {
        emit({ step: node.id, status: "failed", runId, attempt, note: v.reasons.join("; ") || "check failed" });
        cursor = node.on_fail; // loop back
      } else {
        emit({ step: node.id, status: "failed", runId, attempt, note: v.reasons.join("; ") || "check failed, no attempts left" });
        ended = "failed"; cursor = null;
      }
      continue;
    }

    if (node.kind === "human") {
      if (!deps.requestGate) throw new Error(`workflow "${def.id}" has a human step "${node.id}" but no gate is wired`);
      const d = await deps.requestGate({ node, packet: buildPacket(node, edge, lastProduced), runId });
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
      if (node.over) throw new Error(`workflow "${def.id}": parallel 'over' (map) is not yet supported (step "${node.id}")`);
      const branches = node.branches ?? [];
      const results = await Promise.all(branches.map((b) =>
        deps.runAgent({ step: b, brief: composeBrief(def, b), inputs: inputsFor(b.consumes), runId, triggeredBy: `workflow:${def.id}:${node.id}:${b.id}` })));
      branches.forEach((b, i) => { const r = results[i]; if (b.produces && r?.produced) { edge.set(b.produces, r.produced); lastProduced = r.produced; } });
      if (results.some((r) => r.outcome !== "completed")) {
        emit({ step: node.id, status: "failed", runId, note: "a parallel branch failed" });
        ended = "failed"; cursor = null; continue;
      }
      if (node.join) {
        const joinStep: AgentNode = {
          kind: "agent", id: `${node.id}__join`, run: node.join,
          consumes: branches.map((b) => b.produces).filter(present), produces: node.produces,
        };
        const jr = await deps.runAgent({ step: joinStep, brief: composeBrief(def, {}), inputs: inputsFor(joinStep.consumes), runId, triggeredBy: `workflow:${def.id}:${node.id}:join` });
        if (node.produces && jr.produced) { edge.set(node.produces, jr.produced); lastProduced = jr.produced; }
        if (jr.outcome !== "completed") {
          emit({ step: node.id, status: "failed", runId, note: "the parallel join failed" });
          ended = "failed"; cursor = null; continue;
        }
      }
      emit({ step: node.id, status: "done", runId, produced: node.produces ? edge.get(node.produces) : undefined });
      cursor = successor(idx);
      continue;
    }

    throw new Error(`workflow "${def.id}" reached an unhandled step kind`);
  }

  // A clean end (ran off the last step, or a branch/route/human sent the cursor to null) leaves any
  // untaken steps `pending` — mark them `skipped` so the fold reads `done`, not stuck `running`.
  if (ended === "completed") {
    for (const s of foldWorkflowRun(ws, def, runId).steps) {
      if (s.status === "pending") emit({ step: s.id, status: "skipped", runId });
    }
  }
  return foldWorkflowRun(ws, def, runId);
}
