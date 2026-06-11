/** Orchestrates ONE agent run: assemble prompt -> build tools -> runLoop -> write trace.
 *  RunDeps are the seams (model, approval, child-run spawning); makeDeps wires the real ones. */
import type { Database } from "bun:sqlite";
import { generateText, type ModelMessage } from "ai";
import type { AgentDef } from "../schemas/agent";
import type { RunTrace } from "../schemas/trace";
import { assemble } from "./prompt";
import { runLoop } from "./loop";
import { canDelegate, visibleToRows } from "./registry";
import { rankAgents, type AgentHit } from "./discovery";
import { toolsForAgent } from "./tools";
import { createAgent, loadAgent, loadIndex, type NewAgentDraft } from "../store/roster";
import { reserveRunId, writeTrace } from "../store/trace";
import { pricerFor } from "./pricing";
import type { TaichoConfig } from "../store/config";

export type Model = Parameters<typeof generateText>[0]["model"];

const MAX_DELEGATION_DEPTH = 5;
const MAX_RUNS_PER_REQUEST = 50;

export interface ApprovalRequest { kind: "create_agent"; draft: NewAgentDraft; }
export type ApprovalDecision =
  | { type: "approve" }
  | { type: "reject" }
  | { type: "edit"; draft: Record<string, string> };
export interface RunResult { runId: string; text: string; trace: RunTrace; }

/** Mutable per-run context handed to tools' execute fns. */
export interface RunContext {
  ws: string;
  db: Database;
  runId: string;
  agentId: string;
  artifacts: string[];
  delegatedOut: string[];
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  createAgent: (draft: NewAgentDraft) => Promise<AgentDef>;
  canDelegate: (toId: string) => boolean;
  runChild: (brief: { to: string; goal: string; context?: string }) => Promise<RunResult>;
  findAgents: (query: string, k: number) => AgentHit[];
  agentExists: (id: string) => boolean;
  notes: string[];
  workItems: { n: number };
  childSpend: { tokens: number; costUsd: number };
  delegationGuard: (to: string) => { ok: true } | { ok: false; error: string };
}

export interface RunDeps {
  ws: string;
  db: Database;
  model: Model;
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  onStep?: (info: { text?: string; tool?: string; agent: string }) => void;
  pollSteer?: () => string | null;
  signal?: AbortSignal;
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
  runCounter?: { n: number };
  resolveModel?: (agentId: string) => { model: Model; modelId: string; subscription?: boolean };
  configDefaults?: TaichoConfig["defaults"];
}

/** Build RunDeps with real wiring; tests override pieces (e.g. requestApproval). */
export function makeDeps(opts: {
  ws: string; db: Database; model: Model;
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  onStep?: RunDeps["onStep"];
  pollSteer?: () => string | null;
  signal?: AbortSignal;
  priceUsd?: RunDeps["priceUsd"];
  runCounter?: { n: number };
  resolveModel?: RunDeps["resolveModel"];
  configDefaults?: RunDeps["configDefaults"];
}): RunDeps {
  return {
    ws: opts.ws, db: opts.db, model: opts.model,
    requestApproval: opts.requestApproval ?? (async () => ({ type: "reject" })),
    onStep: opts.onStep, pollSteer: opts.pollSteer,
    signal: opts.signal, priceUsd: opts.priceUsd,
    runCounter: opts.runCounter ?? { n: 0 },
    resolveModel: opts.resolveModel, configDefaults: opts.configDefaults,
  };
}

export async function executeRun(
  deps: RunDeps,
  opts: { agent: AgentDef; messages: ModelMessage[]; brief?: { from: string; goal: string; context?: string; fromRun: string }; triggeredBy: string; depth?: number; ancestry?: string[] },
): Promise<RunResult> {
  const depth = opts.depth ?? 0;
  const ancestry = opts.ancestry ?? [];
  deps.runCounter!.n += 1;

  // reserveRunId atomically claims a unique id (exclusive-create placeholder), so concurrent
  // same-target delegations in one model turn can't collide; writeTrace overwrites it at the end.
  const runId = reserveRunId(deps.ws, opts.agent.id);
  const started = new Date().toISOString();
  const t0 = performance.now();

  const ctx: RunContext = {
    ws: deps.ws, db: deps.db, runId, agentId: opts.agent.id,
    artifacts: [], delegatedOut: [],
    requestApproval: deps.requestApproval,
    createAgent: (draft) => createAgent(deps.ws, deps.db, draft, opts.agent.id, deps.configDefaults),
    canDelegate: (toId) => canDelegate(opts.agent, toId),
    runChild: async ({ to, goal, context }) => {
      const child = await loadAgent(deps.ws, to);
      return executeRun(deps, {
        agent: child,
        messages: [{ role: "user", content: context ? `${goal}\n\nContext: ${context}` : goal }],
        brief: { from: opts.agent.id, goal, context, fromRun: runId },
        triggeredBy: runId,
        depth: depth + 1,
        ancestry: [...ancestry, opts.agent.id],
      });
    },
    // Discovery respects the caller's visibility ACL, consistent with the inline-roster path.
    findAgents: (query, k) =>
      rankAgents(
        loadIndex(deps.db)
          .filter((r) => opts.agent.canSee.includes("*") || opts.agent.canSee.includes(r.id))
          .filter((r) => r.id !== opts.agent.id),
        query,
        k,
      ),
    agentExists: (id) => loadIndex(deps.db).some((r) => r.id === id),
    notes: [],
    workItems: { n: 0 },
    childSpend: { tokens: 0, costUsd: 0 },
    delegationGuard: (to) => {
      if (!canDelegate(opts.agent, to)) return { ok: false, error: `not permitted to delegate to "${to}"` };
      if (!loadIndex(deps.db).some((r) => r.id === to)) return { ok: false, error: `no agent "${to}"` };
      if (to === opts.agent.id || ancestry.includes(to)) return { ok: false, error: `delegation cycle: "${to}" is already an ancestor` };
      // inclusive: root is depth 0, so this allows up to MAX_DELEGATION_DEPTH levels of descendants
      if (depth + 1 > MAX_DELEGATION_DEPTH) return { ok: false, error: `max delegation depth (${MAX_DELEGATION_DEPTH}) reached` };
      if (deps.runCounter!.n >= MAX_RUNS_PER_REQUEST) return { ok: false, error: `max runs per request (${MAX_RUNS_PER_REQUEST}) reached` };
      return { ok: true };
    },
  };

  // Visibility from the registry index only — never load every agent's identity (unbounded roster).
  const visible = visibleToRows(opts.agent, loadIndex(deps.db));
  const { system } = assemble(opts.agent, {
    visibleAgents: visible,
    brief: opts.brief ? { to: opts.agent.id, ...opts.brief } : undefined,
    policies: [],
  });
  const tools = toolsForAgent(opts.agent, ctx);

  const picked = deps.resolveModel?.(opts.agent.id);
  const subscription = picked?.subscription === true;
  const model = picked?.model ?? deps.model;
  const priceUsd = picked ? pricerFor(picked.modelId) : deps.priceUsd;

  const result = await runLoop({
    model, agent: opts.agent, system, messages: opts.messages, tools,
    onStep: deps.onStep ? (i) => deps.onStep!({ ...i, agent: opts.agent.id }) : undefined,
    pollSteer: deps.pollSteer,
    signal: deps.signal,
    priceUsd,
  });
  const outcome: RunTrace["outcome"] =
    result.aborted ? "interrupted" : result.exhausted ? "blocked" : result.error ? "failed" : "completed";
  if (result.error) console.error(`run ${runId} failed:`, result.error);

  const trace: RunTrace = {
    id: runId, agent: opts.agent.id, task: opts.brief?.goal ?? "(chat)", triggeredBy: opts.triggeredBy,
    ledger: { retrieved: [], applied: [], skipped: [] },
    toolCalls: Object.entries(result.toolCalls).map(([tool, count]) => ({ tool, count })),
    artifacts: ctx.artifacts, delegatedOut: ctx.delegatedOut, outcome,
    tokens: result.tokens, costUsd: subscription ? null : result.costUsd,
    costNote: subscription ? "subscription" : undefined,
    aggregate: { tokens: result.tokens + ctx.childSpend.tokens, costUsd: subscription ? null : result.costUsd + ctx.childSpend.costUsd },
    notes: ctx.notes,
    durationMs: Math.round(performance.now() - t0), started,
  };
  writeTrace(deps.ws, trace);
  return { runId, text: result.error ? `error: ${result.error}` : result.text, trace };
}
