/** Plan 25: the structured, engine-executed team workflow.
 *
 *  Lives in the YAML frontmatter of teams/<id>/workflow.md — the slot Plan 23's parseWorkflow already
 *  reserves and strips. The prose `## seat` lanes below it are untouched (Plan 23). A file with no
 *  `steps:` block is a prose-only Plan 23 workflow and loadWorkflowDefText returns null for it.
 *
 *  A step is one of five KINDS, distinguished in YAML by which key it carries — a step with `run:` is an
 *  agent node, `check:` a check node, and so on. normalizeNode() detects the kind and rejects a step that
 *  carries more than one kind-key (or none), naming the id. The engine (core/workflow.ts) walks the steps;
 *  the model never routes. */
import { z } from "zod";
import { YAML } from "bun";

/** A step id — stable across versions, exactly like a Plan 18 PlanItem id. */
const StepId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "step id must be lowercase letters, digits, _ or -");

/** run one agent (or a team id, resolved by team-routing). */
const AgentNode = z.object({
  id: StepId,
  run: z.string(),
  brief: z.string().optional(),
  consumes: z.array(z.string()).default([]),
  produces: z.string().optional(),
  criteria: z.string().optional(),
});

/** an automatic gate — verify an artifact against criteria (Plan 06 runChecker). */
const CheckNode = z.object({
  id: StepId,
  check: z.string(),
  of: z.string().optional(),
  on_fail: StepId.optional(),
  max_attempts: z.number().int().positive().default(2),
});

/** a human gate — pause, present a packet, route on the chosen option. */
const HumanNode = z.object({
  id: StepId,
  human: z.string(),
  present: z.string().optional(),
  shows: z.array(z.string()).optional(),
  choices: z.array(z.string()).min(1).default(["approve", "reject"]),
  routes: z.record(z.string(), StepId).default({}),
});

/** fan-out then optional join. `over` maps each item of an artifact list; `branches` is explicit steps. */
const ParallelNode = z.object({
  id: StepId,
  over: z.string().optional(),
  branches: z.array(AgentNode).optional(),
  as: AgentNode.optional(),
  join: z.string().optional(),
  produces: z.string().optional(),
});

/** classify the input and jump to a labelled step. */
const BranchNode = z.object({
  id: StepId,
  branch: z.string(),
  of: z.string().optional(),
  routes: z.record(z.string(), StepId),
});

export type WorkflowNode =
  | ({ kind: "agent" } & z.infer<typeof AgentNode>)
  | ({ kind: "check" } & z.infer<typeof CheckNode>)
  | ({ kind: "human" } & z.infer<typeof HumanNode>)
  | ({ kind: "parallel" } & z.infer<typeof ParallelNode>)
  | ({ kind: "branch" } & z.infer<typeof BranchNode>);
export type NodeKind = WorkflowNode["kind"];

export interface WorkflowDef {
  id: string;
  team: string;
  version: number;
  brief?: string;
  steps: WorkflowNode[];
}

const WorkflowHead = z.object({
  id: z.string().min(1),
  team: z.string().min(1),
  version: z.number().int().positive(),
  brief: z.string().optional(),
});

/** Which kind-key(s) a raw step carries. `parallel` is signalled by `over` or `branches`. */
function discriminate(raw: Record<string, unknown>): NodeKind[] {
  const kinds: NodeKind[] = [];
  if ("run" in raw) kinds.push("agent");
  if ("check" in raw) kinds.push("check");
  if ("human" in raw) kinds.push("human");
  if ("branch" in raw) kinds.push("branch");
  if ("over" in raw || "branches" in raw) kinds.push("parallel");
  return kinds;
}

function normalizeNode(raw: Record<string, unknown>): WorkflowNode {
  const id = typeof raw.id === "string" ? raw.id : "?";
  const kinds = discriminate(raw);
  if (kinds.length === 0)
    throw new Error(`workflow step "${id}" has no kind — it needs one of run/check/human/parallel/branch`);
  if (kinds.length > 1)
    throw new Error(`workflow step "${id}" carries more than one kind (${kinds.join(", ")}) — a step is exactly one`);
  const kind = kinds[0]!;
  switch (kind) {
    case "agent": return { kind, ...AgentNode.parse(raw) };
    case "check": return { kind, ...CheckNode.parse(raw) };
    case "human": return { kind, ...HumanNode.parse(raw) };
    case "parallel": return { kind, ...ParallelNode.parse(raw) };
    case "branch": return { kind, ...BranchNode.parse(raw) };
  }
}

/** Validate + normalize a raw workflow object (head fields already mapped: id/team/version/brief/steps). */
export function parseWorkflowDef(raw: unknown): WorkflowDef {
  const r = (raw ?? {}) as Record<string, unknown>;
  const head = WorkflowHead.parse(r);
  const rawSteps = z.array(z.record(z.string(), z.unknown())).min(1, "a workflow needs at least one step").parse(r.steps);
  const steps = rawSteps.map(normalizeNode);
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) throw new Error(`workflow "${head.id}" has a duplicate step id "${s.id}"`);
    ids.add(s.id);
  }
  return { ...head, steps };
}

// ── run state ───────────────────────────────────────────────────────────────────────────────────
// A workflow RUN is an append-only event log; current state = fold(events). This mirrors Plan 18's plan
// event log, but SIMPLER: the ENGINE writes every event (a workflow step is never model-ticked), so there
// is no `by`/`rejected` split — no attempt can lie because no model attempt exists.

export const StepStatus = z.enum(["pending", "running", "done", "failed", "skipped", "interrupted"]);
export type StepStatus = z.infer<typeof StepStatus>;

/** Terminal for "is this step still open". */
export const TERMINAL_STEP_STATUS: ReadonlySet<StepStatus> = new Set<StepStatus>([
  "done", "failed", "skipped", "interrupted",
]);

export const WorkflowEvent = z.object({
  step: z.string(),
  status: StepStatus,
  runId: z.string(), // the executeRun (or "boot") that wrote this event
  produced: z.string().optional(), // artifact handle the step emitted (id@vN)
  choice: z.string().optional(), // human/branch: the path taken
  attempt: z.number().int().optional(),
  note: z.string().optional(),
  ts: z.string().datetime(),
});
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;

export interface FoldedStep {
  id: string;
  kind: NodeKind;
  status: StepStatus;
  produced?: string;
  choice?: string;
  note?: string;
  updated?: string;
}

export type WorkflowRunStatus = "running" | "done" | "failed" | "interrupted" | "parked";

export interface WorkflowRunState {
  wfId: string;
  runId: string;
  steps: FoldedStep[];
  status: WorkflowRunStatus;
  counts: { total: number; done: number; open: number; failed: number };
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Parse the structured workflow out of a workflow.md's text. `team` is injected from the file location
 *  (teams/<team>/workflow.md). Returns null for a Plan 23 prose-only file — one with no frontmatter, or
 *  frontmatter that carries no `steps:` block. The frontmatter key `workflow:` names the workflow (its id). */
export function loadWorkflowDefText(text: string, team: string): WorkflowDef | null {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  const fm = YAML.parse(m[1]!) as Record<string, unknown> | null;
  if (!fm || !("steps" in fm)) return null;
  return parseWorkflowDef({ id: fm.workflow, team, version: fm.version, brief: fm.brief, steps: fm.steps });
}
