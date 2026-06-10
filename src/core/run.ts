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
import { nextRunId, writeTrace } from "../store/trace";

export type Model = Parameters<typeof generateText>[0]["model"];

export interface ApprovalRequest { kind: "create_agent"; draft: NewAgentDraft; }
export interface ApprovalDecision { type: "approve" | "reject" | "edit"; }
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
}

export interface RunDeps {
  ws: string;
  db: Database;
  model: Model;
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  onStep?: (info: { text?: string; tool?: string; agent: string }) => void;
  pollSteer?: () => string | null;
}

/** Build RunDeps with real wiring; tests override pieces (e.g. requestApproval). */
export function makeDeps(opts: {
  ws: string; db: Database; model: Model;
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  onStep?: RunDeps["onStep"];
  pollSteer?: () => string | null;
}): RunDeps {
  return {
    ws: opts.ws, db: opts.db, model: opts.model,
    requestApproval: opts.requestApproval ?? (async () => ({ type: "reject" })),
    onStep: opts.onStep, pollSteer: opts.pollSteer,
  };
}

export async function executeRun(
  deps: RunDeps,
  opts: { agent: AgentDef; messages: ModelMessage[]; brief?: { from: string; goal: string; context?: string; fromRun: string }; triggeredBy: string },
): Promise<RunResult> {
  const runId = nextRunId(deps.ws, opts.agent.id);
  const started = new Date().toISOString();
  const t0 = performance.now();

  const ctx: RunContext = {
    ws: deps.ws, db: deps.db, runId, agentId: opts.agent.id,
    artifacts: [], delegatedOut: [],
    requestApproval: deps.requestApproval,
    createAgent: (draft) => createAgent(deps.ws, deps.db, draft, opts.agent.id),
    canDelegate: (toId) => canDelegate(opts.agent, toId),
    // TODO(depth-guard): delegate_task -> runChild -> executeRun recursion has no depth/cycle
    // bound yet; a pathological agent could delegate indefinitely. Tracked for a follow-up slice.
    runChild: async ({ to, goal, context }) => {
      const child = await loadAgent(deps.ws, to);
      return executeRun(deps, {
        agent: child,
        messages: [{ role: "user", content: context ? `${goal}\n\nContext: ${context}` : goal }],
        brief: { from: opts.agent.id, goal, context, fromRun: runId },
        triggeredBy: runId,
      });
    },
    // Discovery respects the caller's visibility ACL, consistent with the inline-roster path.
    findAgents: (query, k) =>
      rankAgents(
        loadIndex(deps.db).filter((r) => opts.agent.canSee.includes("*") || opts.agent.canSee.includes(r.id)),
        query,
        k,
      ),
  };

  // Visibility from the registry index only — never load every agent's identity (unbounded roster).
  const visible = visibleToRows(opts.agent, loadIndex(deps.db));
  const { system } = assemble(opts.agent, {
    visibleAgents: visible,
    brief: opts.brief ? { to: opts.agent.id, ...opts.brief } : undefined,
    policies: [],
  });
  const tools = toolsForAgent(opts.agent, ctx);

  let result: Awaited<ReturnType<typeof runLoop>>;
  let outcome: RunTrace["outcome"] = "completed";
  try {
    result = await runLoop({
      model: deps.model, agent: opts.agent, system, messages: opts.messages, tools,
      onStep: deps.onStep ? (i) => deps.onStep!({ ...i, agent: opts.agent.id }) : undefined,
      pollSteer: deps.pollSteer,
    });
    if (result.text === "[budget exhausted]") outcome = "blocked";
  } catch (e) {
    outcome = "failed";
    console.error(`run ${runId} failed:`, e);
    result = { text: `error: ${e instanceof Error ? e.message : String(e)}`, toolCalls: {}, tokens: 0, iterations: 0 };
  }

  const trace: RunTrace = {
    id: runId, agent: opts.agent.id, task: opts.brief?.goal ?? "(chat)", triggeredBy: opts.triggeredBy,
    ledger: { retrieved: [], applied: [], skipped: [] },
    toolCalls: Object.entries(result.toolCalls).map(([tool, count]) => ({ tool, count })),
    artifacts: ctx.artifacts, delegatedOut: ctx.delegatedOut, outcome,
    tokens: result.tokens, durationMs: Math.round(performance.now() - t0), started,
  };
  writeTrace(deps.ws, trace);
  return { runId, text: result.text, trace };
}
