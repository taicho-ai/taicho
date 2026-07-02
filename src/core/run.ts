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
import { searchKnowledge } from "../knowledge/retrieval";
import { getActiveSkills } from "../store/skills";
import { rankSkills } from "../skills/retrieval";
import { createAgent, loadAgent, loadIndex, type NewAgentDraft } from "../store/roster";
import { reserveRunId, writeTrace } from "../store/trace";
import type { ProposalDraft } from "../coaching/proposal";
import { pricerFor } from "./pricing";
import type { TaichoConfig } from "../store/config";
import { recentRunsDigest } from "./memory";
import { listPolicies } from "../store/policy";
import type { PolicyNote } from "../schemas/policy";
import type { McpManager } from "./mcp/manager";
import type { McpServerConfig } from "../store/config";
import type { Verdict } from "./command-guard";

export type Model = Parameters<typeof generateText>[0]["model"];

/** Best-effort task query for KB auto-recall: the delegated goal, else the last user turn's text. */
function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join(" ");
  }
  return "";
}

const MAX_DELEGATION_DEPTH = 5;
const MAX_RUNS_PER_REQUEST = 50;

export type ApprovalRequest =
  | { kind: "create_agent"; draft: NewAgentDraft }
  | { kind: "propose_coaching"; draft: ProposalDraft }
  | { kind: "ask_human"; question: string; options: string[] }
  | { kind: "add_mcp"; name: string; spec: McpServerConfig }
  | { kind: "propose_skill"; draft: { name: string; description: string; body: string; tags: string[] } }
  | { kind: "run_command"; command: string; reason?: string };
export type ApprovalDecision =
  | { type: "approve" }
  | { type: "reject" }
  | { type: "edit"; draft: Record<string, string> }
  | { type: "answered"; answer: string };
export interface RunResult { runId: string; text: string; trace: RunTrace; }

/** Mutable per-run context handed to tools' execute fns. */
export interface RunContext {
  ws: string;
  db: Database;
  runId: string;
  agentId: string;
  embed?: (text: string) => Promise<Float32Array>; // present only when an embedder is configured (semantic KB)
  classifyCommand?: (command: string) => Verdict;                                             // test seam
  runShell?: (command: string, cwd: string) => { exitCode: number; stdout: string; stderr: string }; // test seam
  ingestSource?: string; // when set (a source-ingestion run), remember stamps this instead of agentId:runId
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
  onStep?: (info: { text?: string; tool?: string; delta?: string; agent: string }) => void;
  pollSteer?: () => string | null;
  signal?: AbortSignal;
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
  runCounter?: { n: number };
  resolveModel?: (agentId: string) => { model: Model; modelId: string; subscription?: boolean; captureCost?: boolean };
  configDefaults?: TaichoConfig["defaults"];
  globalPolicyCache?: { notes?: PolicyNote[] };
  mcp?: McpManager;
  embed?: (text: string) => Promise<Float32Array>; // semantic KB embedder; undefined ⇒ keyword+graph
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
  globalPolicyCache?: { notes?: PolicyNote[] };
  mcp?: McpManager;
  embed?: (text: string) => Promise<Float32Array>;
}): RunDeps {
  return {
    ws: opts.ws, db: opts.db, model: opts.model,
    requestApproval: opts.requestApproval ?? (async () => ({ type: "reject" })),
    onStep: opts.onStep, pollSteer: opts.pollSteer,
    signal: opts.signal, priceUsd: opts.priceUsd,
    runCounter: opts.runCounter ?? { n: 0 },
    resolveModel: opts.resolveModel, configDefaults: opts.configDefaults,
    globalPolicyCache: opts.globalPolicyCache ?? {},
    mcp: opts.mcp, embed: opts.embed,
  };
}

export async function executeRun(
  deps: RunDeps,
  opts: { agent: AgentDef; messages: ModelMessage[]; brief?: { from: string; goal: string; context?: string; fromRun: string }; triggeredBy: string; depth?: number; ancestry?: string[]; ingestSource?: string },
): Promise<RunResult> {
  const depth = opts.depth ?? 0;
  const ancestry = opts.ancestry ?? [];
  deps.runCounter!.n += 1;

  const memoryBlock = recentRunsDigest(deps.ws, opts.agent.id);

  // reserveRunId atomically claims a unique id (exclusive-create placeholder), so concurrent
  // same-target delegations in one model turn can't collide; writeTrace overwrites it at the end.
  const runId = reserveRunId(deps.ws, opts.agent.id);
  const started = new Date().toISOString();
  const t0 = performance.now();

  const ctx: RunContext = {
    ws: deps.ws, db: deps.db, runId, agentId: opts.agent.id, embed: deps.embed,
    ingestSource: opts.ingestSource,
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

  let applied: PolicyNote[] = [];
  try {
    const own = listPolicies(deps.ws, opts.agent.id).filter((n) => n.status === "approved");
    const cache = deps.globalPolicyCache!;
    if (!cache.notes) {
      cache.notes = loadIndex(deps.db)
        .flatMap((r) => listPolicies(deps.ws, r.id))
        .filter((n) => n.status === "approved" && n.scope === "global");
    }
    const globals = cache.notes.filter((n) => n.agent !== opts.agent.id);
    applied = [...own, ...globals];
  } catch (e) {
    console.error(`policy load failed for ${opts.agent.id}:`, e);
  }

  // Auto-inject relevant deck knowledge for agents that use the KB (like coaching notes): keyword+
  // graph normally, semantic when an embedder is configured. Skipped for agents without `recall`.
  let knowledgeBlock: string | undefined;
  let knowledgeIds: string[] = [];
  if (opts.agent.tools.includes("recall")) {
    const q = opts.brief?.goal ?? lastUserText(opts.messages);
    if (q.trim()) {
      try {
        const kb = await searchKnowledge({ db: deps.db, query: q, embed: deps.embed, k: 5, hops: 1 });
        if (kb.hits.length) {
          knowledgeIds = kb.hits.map((h) => h.id);
          knowledgeBlock = "## Relevant knowledge (shared deck memory — call recall for more)\n" +
            kb.hits.map((h) => `- [${h.id}] ${h.title}${h.summary ? " — " + h.summary : ""}`).join("\n");
        }
      } catch (e) { console.error(`kb recall failed for ${opts.agent.id}:`, e); }
    }
  }

  // Inject the agent's FULL skill toolkit (name + when-to-use) for EVERY agent, so it always knows
  // what it has — and can answer "how many skills do I have" — the way the "Your team" roster block
  // lists all agents. Only fall back to keyword-ranked top-K when the library is large. The full
  // procedure loads via use_skill on demand. (Keyword-only injection hid skills for meta questions.)
  let skillsBlock: string | undefined;
  let skillIds: string[] = [];
  try {
    const all = getActiveSkills(deps.db);
    if (all.length) {
      const CAP = 40;
      let shown: { id: string; name: string; description: string }[];
      let header: string;
      if (all.length <= CAP) {
        shown = all.map((s) => ({ id: s.id, name: s.name, description: s.description }));
        header = `## Your skills (${all.length}) — call use_skill(name) to load a procedure before you act`;
      } else {
        shown = rankSkills(all, opts.brief?.goal ?? lastUserText(opts.messages), CAP);
        header = `## Your skills (${all.length}, showing the ${CAP} most relevant — call find_skills to search the rest)`;
      }
      skillIds = shown.map((s) => s.id);
      skillsBlock = header + "\n" + shown.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    }
  } catch (e) { console.error(`skill inject failed for ${opts.agent.id}:`, e); }

  const { system } = assemble(opts.agent, {
    visibleAgents: visible,
    brief: opts.brief ? { to: opts.agent.id, ...opts.brief } : undefined,
    policies: applied,
    memoryBlock,
    knowledgeBlock,
    skillsBlock,
  });
  const tools = toolsForAgent(opts.agent, ctx, deps.mcp);

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
    codexBackend: subscription, // subscription:true ⇒ Codex backend ⇒ system goes in `instructions`
    captureProviderCost: picked?.captureCost, // OpenRouter reports real cost in providerMetadata
  });
  const outcome: RunTrace["outcome"] =
    result.aborted ? "interrupted" : result.exhausted ? "blocked" : result.error ? "failed" : "completed";
  if (result.error) console.error(`run ${runId} failed:`, result.error);

  const trace: RunTrace = {
    id: runId, agent: opts.agent.id, task: opts.brief?.goal ?? "(chat)", triggeredBy: opts.triggeredBy,
    ledger: { retrieved: applied.map((n) => n.id), applied: applied.map((n) => n.id), skipped: [], knowledge: knowledgeIds, skills: skillIds },
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
