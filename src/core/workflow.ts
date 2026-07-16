/** Plan 25: the workflow DRIVER — a sixth caller above executeRun.
 *
 *  It holds the edge state (an artifact-name → handle map), walks a cursor over the steps, and dispatches
 *  per node kind. The engine owns step status: no node writes its own `done` — the driver writes it from
 *  the step-runner's real outcome. State flows step→step by artifact REFERENCE (a step's `produces` becomes
 *  the next step's `consumes` input), exactly as delegation hands work down today.
 *
 *  The step-runner is INJECTED (`WorkflowExecDeps.runAgent`) so the orchestration is unit-testable without a
 *  live model; run.ts wires it to executeRun. Phase 1 implements the `agent` kind (a linear pipeline);
 *  check/human/parallel/branch land in later phases. */
import { reserveWorkflowRun, appendWorkflowEvent, foldWorkflowRun } from "../store/workflow-runs";
import type { WorkflowDef, WorkflowNode, WorkflowRunState, StepStatus } from "../schemas/workflow";

export type RunOutcome = "completed" | "blocked" | "failed" | "interrupted";
export interface AgentStepRun {
  childRunId: string;
  outcome: RunOutcome;
  produced?: string;
}
type AgentNode = Extract<WorkflowNode, { kind: "agent" }>;

export interface WorkflowExecDeps {
  ws: string;
  /** Run one agent step to completion. run.ts wires this to executeRun; tests inject a recorder. */
  runAgent: (a: {
    step: AgentNode;
    brief: string;
    inputs: string[];
    runId: string;
    triggeredBy: string;
  }) => Promise<AgentStepRun>;
  signal?: AbortSignal;
}

export interface WorkflowInput {
  artifacts?: { name: string; handle: string }[];
}

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

  const indexById = new Map(def.steps.map((s, i) => [s.id, i] as const));
  let cursor: string | null = def.steps[0]?.id ?? null;

  while (cursor) {
    const idx = indexById.get(cursor);
    if (idx === undefined) throw new Error(`workflow "${def.id}" routes to unknown step "${cursor}"`);
    const node = def.steps[idx]!;

    if (deps.signal?.aborted) {
      emit({ step: node.id, status: "interrupted", runId });
      break;
    }
    emit({ step: node.id, status: "running", runId });

    if (node.kind === "agent") {
      const inputs = node.consumes.map((n) => edge.get(n)).filter((h): h is string => !!h);
      const res = await deps.runAgent({
        step: node,
        brief: composeBrief(def, node),
        inputs,
        runId,
        triggeredBy: `workflow:${def.id}:${node.id}`,
      });
      if (node.produces && res.produced) edge.set(node.produces, res.produced);
      const status = statusFor(res.outcome);
      emit({
        step: node.id,
        runId: res.childRunId,
        produced: res.produced,
        status,
        note: res.outcome === "completed" ? undefined : `agent run ${res.outcome}`,
      });
      if (status !== "done") { cursor = null; break; }
      cursor = def.steps[idx + 1]?.id ?? null;
      continue;
    }

    // check | human | parallel | branch — Phase 2/3
    throw new Error(`workflow step kind "${node.kind}" is not yet implemented (step "${node.id}")`);
  }

  return foldWorkflowRun(ws, def, runId);
}
