/** Orchestrates ONE agent run: assemble prompt -> build tools -> runLoop -> write trace.
 *  RunDeps are the seams (model, approval, child-run spawning); makeDeps wires the real ones. */
import type { Database } from "bun:sqlite";
import { generateText, type ModelMessage } from "ai";
import type { AgentDef } from "../schemas/agent";
import type { RunTrace, VerificationRecord, VerificationVerdict } from "../schemas/trace";
import { assemble } from "./prompt";
import { runLoop } from "./loop";
import { runChecker } from "./verification";
import { canDelegate, visibleToRows } from "./registry";
import { rankAgents, type AgentHit } from "./discovery";
import { toolsForAgent } from "./tools";
import { readArtifact } from "../store/artifacts";
import { artifactHandle } from "../schemas/artifact";
import { searchKnowledge } from "../knowledge/retrieval";
import { getActiveSkills } from "../store/skills";
import { rankSkills } from "../skills/retrieval";
import { createAgent, loadAgent, loadIndex, type NewAgentDraft } from "../store/roster";
import { reserveRunId, writeTrace } from "../store/trace";
import { appendRunTranscript, writeChildRuns, writeRunCheckpoint, writeRunFailure, writeRunFinal, writeRunInput, type RunTranscriptEvent } from "../store/run-transcript";
import type { StepInfo, StepEvent } from "./step-events";
import type { ProposalDraft } from "../coaching/proposal";
import { pricerFor } from "./pricing";
import type { TaichoConfig } from "../store/config";
import { recentRunsDigest } from "./memory";
import { listPolicies } from "../store/policy";
import type { PolicyNote } from "../schemas/policy";
import type { McpManager } from "./mcp/manager";
import type { McpServerConfig } from "../store/config";
import type { DeckLedger } from "../store/deck-budget";
import type { Verdict } from "./command-guard";
import { log, redact } from "./logger";

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

/** A short label for an approval span (what the captain is being asked to decide). Free-form fields
 *  (esp. a `run_command` command) are value-scrubbed BEFORE the length cap — this label reaches the
 *  live status bar, the approval span, and the persisted transcript, so an embedded `Bearer …`/api
 *  key must never surface (redact runs pre-slice so truncation can't expose a partial secret). */
function approvalLabel(req: ApprovalRequest): string {
  switch (req.kind) {
    case "create_agent": return redact(`create_agent ${req.draft.id}`);
    case "run_command": return redact(`run_command ${req.command}`).slice(0, 60);
    case "add_mcp": return redact(`add_mcp ${req.name}`);
    case "propose_skill": return redact(`propose_skill ${req.draft.name}`);
    case "propose_coaching": return "propose_coaching";
    case "ask_human": return "ask_human";
  }
}

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
  inputArtifacts: string[];   // artifact handles this run handed DOWN to children (hand-off graph)
  outputArtifacts: string[];  // artifact handles this run received UP from children
  delegatedOut: string[];
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  createAgent: (draft: NewAgentDraft) => Promise<AgentDef>;
  canDelegate: (toId: string) => boolean;
  runChild: (brief: { to: string; goal: string; context?: string; criteria?: string; inputArtifacts?: string[] }) => Promise<RunResult>;
  findAgents: (query: string, k: number) => AgentHit[];
  agentExists: (id: string) => boolean;
  notes: string[];
  workItems: { n: number };
  childSpend: { tokens: number; costUsd: number };
  /** Spend from THIS run's own delegation-checker calls (Plan 06). Kept separate from childSpend
   *  (which is child RUNS) but folded into trace.aggregate the same way — the checker makes real,
   *  metered model calls this run caused, so the aggregate must include them to stay honest. costUsd
   *  is 0 for subscription runs (unpriced), and aggregate.costUsd is null there anyway. */
  verifierSpend: { tokens: number; costUsd: number };
  childTraces: RunTrace[];
  delegationGuard: (to: string) => { ok: true } | { ok: false; error: string };
  /** Criteria→verdict records for this run's delegations; written to trace.verification + transcript. */
  verifications: VerificationRecord[];
  /** The independent delegation checker: child output + criteria → verdict, via the delegating
   *  agent's own resolved model (same plumbing the loop uses). */
  checkCriteria: (p: { goal: string; criteria: string; output: string }) => Promise<{ verdict: VerificationVerdict; tokens: number; costUsd: number | null; costNote?: string }>;
  /** Surface a one-line breadcrumb to the captain (e.g. a failed verification), routed via onStep. */
  emit?: (info: { note: string }) => void;
  /** Plan 04: fire-and-forget a goal onto another agent in the BACKGROUND. Returns a taskId
   *  immediately (the cascade runs off-turn via the same executeRun). Present only when the host
   *  wired a scheduler (the REPL); undefined in headless/unit contexts. */
  dispatchTask?: (brief: { to: string; goal: string; context?: string; criteria?: string; inputArtifacts?: string[] }) => Promise<{ taskId: string } | { error: string }>;
  /** Plan 04: block until a background task settles (bounded by timeoutMs). Status + summary +
   *  resultRef only — hand-off stays BY REFERENCE, never the inlined payload. */
  awaitTask?: (taskId: string, timeoutMs?: number) => Promise<TaskAwaitResult>;
  /** The shared instrumentation seam (Plan 02 + Plan 10). tools.ts wraps every tool `execute()` and
   *  run.ts wraps `requestApproval` to (a) push tool/approval span events into `spanEvents` (flushed
   *  to transcript.jsonl for the waterfall) and (b) emit a live typed phase via `emitStep`. */
  spanEvents: RunTranscriptEvent[];
  emitStep?: (info: StepInfo) => void;
}

/** What check_task / await_task hand back: a reference, never the payload (Plan 01 discipline). */
export interface TaskAwaitResult { status: string; summary?: string; resultRef?: string; runId?: string; error?: string; }

export interface RunDeps {
  ws: string;
  db: Database;
  model: Model;
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  onStep?: (info: StepEvent) => void;
  pollSteer?: () => string | null;
  /** Plan 04 Phase 4: per-run steer routing. run.ts binds the loop's pollSteer to THIS run's id, so
   *  a steer routed to a specific runId reaches only that run (not a random descendant). Falls back
   *  to the flat pollSteer when absent (unit tests). */
  pollSteerFor?: (info: { runId: string; agentId: string; triggeredBy: string }) => string | null;
  signal?: AbortSignal;
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
  runCounter?: { n: number };
  resolveModel?: (agentId: string) => { model: Model; modelId: string; subscription?: boolean; captureCost?: boolean };
  configDefaults?: TaichoConfig["defaults"];
  globalPolicyCache?: { notes?: PolicyNote[] };
  mcp?: McpManager;
  embed?: (text: string) => Promise<Float32Array>; // semantic KB embedder; undefined ⇒ keyword+graph
  onRunStart?: (info: { runId: string; agent: string; triggeredBy: string; messages: ModelMessage[] }) => void;
  /** Plan 04 Phase 4: called when a run finishes (any outcome) so the host can drop it from its
   *  active-run map / steer routing table. */
  onRunEnd?: (info: { runId: string; agent: string; triggeredBy: string; outcome: RunTrace["outcome"] }) => void;
  /** Plan 04 Phase 2: start a detached BACKGROUND run for a dispatched task. The host (REPL) owns
   *  the scheduler + settle/notify; the engine just hands it a resolved child agent + brief.
   *  Returns the taskId immediately (fire-and-forget). Undefined ⇒ dispatch_task is unavailable. */
  dispatch?: (opts: { agent: AgentDef; goal: string; context?: string; criteria?: string; inputArtifacts?: string[]; parentRunId: string; parentAgentId: string; parentAncestry: string[] }) => { taskId: string } | { error: string };
  /** Plan 04 Phase 2: back await_task — block until a background task settles (host-owned). The
   *  optional awaiterAgentId (stamped by run.ts) lets the host fail fast on a same-agent self-block. */
  awaitTask?: (taskId: string, timeoutMs?: number, awaiterAgentId?: string) => Promise<TaskAwaitResult>;
  /** Plan 09: deck-wide spend ledger, shared by ALL runs in a session (including delegated children),
   *  enforced in the loop and persisted across sessions. Undefined ⇒ no deck ceilings configured. */
  deckLedger?: DeckLedger;
}

/** Build RunDeps with real wiring; tests override pieces (e.g. requestApproval). */
export function makeDeps(opts: {
  ws: string; db: Database; model: Model;
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  onStep?: RunDeps["onStep"];
  pollSteer?: () => string | null;
  pollSteerFor?: RunDeps["pollSteerFor"];
  signal?: AbortSignal;
  priceUsd?: RunDeps["priceUsd"];
  runCounter?: { n: number };
  resolveModel?: RunDeps["resolveModel"];
  configDefaults?: RunDeps["configDefaults"];
  globalPolicyCache?: { notes?: PolicyNote[] };
  mcp?: McpManager;
  embed?: (text: string) => Promise<Float32Array>;
  onRunStart?: RunDeps["onRunStart"];
  onRunEnd?: RunDeps["onRunEnd"];
  dispatch?: RunDeps["dispatch"];
  awaitTask?: RunDeps["awaitTask"];
  deckLedger?: RunDeps["deckLedger"];
}): RunDeps {
  return {
    ws: opts.ws, db: opts.db, model: opts.model,
    requestApproval: opts.requestApproval ?? (async () => ({ type: "reject" })),
    onStep: opts.onStep, pollSteer: opts.pollSteer, pollSteerFor: opts.pollSteerFor,
    signal: opts.signal, priceUsd: opts.priceUsd,
    runCounter: opts.runCounter ?? { n: 0 },
    resolveModel: opts.resolveModel, configDefaults: opts.configDefaults,
    globalPolicyCache: opts.globalPolicyCache ?? {},
    mcp: opts.mcp, embed: opts.embed,
    onRunStart: opts.onRunStart, onRunEnd: opts.onRunEnd,
    dispatch: opts.dispatch, awaitTask: opts.awaitTask,
    deckLedger: opts.deckLedger,
  };
}

export async function executeRun(
  deps: RunDeps,
  opts: { agent: AgentDef; messages: ModelMessage[]; brief?: { from: string; goal: string; context?: string; criteria?: string; fromRun: string }; inputArtifacts?: string[]; triggeredBy: string; depth?: number; ancestry?: string[]; ingestSource?: string },
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
  deps.onRunStart?.({ runId, agent: opts.agent.id, triggeredBy: opts.triggeredBy, messages: opts.messages });
  writeRunInput(deps.ws, runId, {
    runId,
    triggeredBy: opts.triggeredBy,
    agent: opts.agent.id,
    task: opts.brief?.goal ?? "(chat)",
    messagesPassedToModel: opts.messages,
    parentRunId: opts.brief?.fromRun,
  });

  // Resolve THIS agent's model up front (before tools are built) so the delegation checker can run
  // on the same model plumbing the loop uses — an independent call on the delegating agent's model.
  const picked = deps.resolveModel?.(opts.agent.id);
  const subscription = picked?.subscription === true;
  const model = picked?.model ?? deps.model;
  const priceUsd = picked ? pricerFor(picked.modelId) : deps.priceUsd;

  // The shared instrumentation seam (Plan 02 waterfall spans + Plan 10 live status). Tool spans are
  // pushed by the execute() wrapper in tools.ts; approval spans by the wrapped requestApproval below.
  // Both are merged (by ts) into transcript.jsonl at run end and streamed live via emitStep.
  const spanEvents: RunTranscriptEvent[] = [];
  const emitStep = deps.onStep
    ? (info: StepInfo) => deps.onStep!({ ...info, agent: opts.agent.id, runId })
    : undefined;
  // Time approval / ask_human waits as their own `approval` spans — core, not optional: in this
  // system the human wait frequently dominates wall-clock, and a waterfall that folds it into the
  // enclosing tool span would lie about where the time went.
  const wrappedRequestApproval = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    const label = approvalLabel(req);
    spanEvents.push({ ts: new Date().toISOString(), kind: "approval_start", data: { kind: req.kind, label } });
    emitStep?.({ phase: "approval_start", tool: label, argsPreview: label });
    try {
      return await deps.requestApproval(req);
    } finally {
      spanEvents.push({ ts: new Date().toISOString(), kind: "approval_end", data: { kind: req.kind, label } });
      emitStep?.({ phase: "approval_end", tool: label });
    }
  };

  const ctx: RunContext = {
    ws: deps.ws, db: deps.db, runId, agentId: opts.agent.id, embed: deps.embed,
    ingestSource: opts.ingestSource,
    artifacts: [], inputArtifacts: [], outputArtifacts: [], delegatedOut: [],
    spanEvents, emitStep,
    requestApproval: wrappedRequestApproval,
    createAgent: (draft) => createAgent(deps.ws, deps.db, draft, opts.agent.id, deps.configDefaults),
    canDelegate: (toId) => canDelegate(opts.agent, toId),
    runChild: async ({ to, goal, context, criteria, inputArtifacts }) => {
      const child = await loadAgent(deps.ws, to);
      return executeRun(deps, {
        agent: child,
        messages: [{ role: "user", content: context ? `${goal}\n\nContext: ${context}` : goal }],
        brief: { from: opts.agent.id, goal, context, criteria, fromRun: runId },
        inputArtifacts, // handed to the child by REFERENCE (handles + summaries in the prompt, not inlined bodies)
        triggeredBy: runId,
        depth: depth + 1,
        ancestry: [...ancestry, opts.agent.id],
      });
    },
    verifications: [],
    checkCriteria: (p) => runChecker({
      model, agent: opts.agent, subscription, priceUsd,
      captureProviderCost: picked?.captureCost, signal: deps.signal,
      // Plan 09: the checker runs on the same shared deck ledger the primary loop uses, so its tokens
      // (and USD, when priced) count against the deck ceiling and are bounded by it — not invisible.
      deckLedger: deps.deckLedger,
      goal: p.goal, criteria: p.criteria, output: p.output,
    }),
    emit: emitStep ? (info) => emitStep({ note: info.note }) : undefined,
    // Plan 04: dispatch resolves the child agent (like runChild) then hands it to the host scheduler,
    // which starts a detached run and returns the taskId immediately. Undefined when unwired.
    // parentAncestry threads the dispatching run's ancestry so the cross-agent cycle guard spans
    // dispatch hops — a detached A→B→A ping-pong is refused by delegationGuard, not just per-agent caps.
    dispatchTask: deps.dispatch
      ? async ({ to, goal, context, criteria, inputArtifacts }) => {
          const child = await loadAgent(deps.ws, to);
          return deps.dispatch!({ agent: child, goal, context, criteria, inputArtifacts, parentRunId: runId, parentAgentId: opts.agent.id, parentAncestry: ancestry });
        }
      : undefined,
    // awaiterAgentId lets the host fail fast on a self-block deadlock: awaiting a task queued behind
    // THIS agent's own concurrency slot (the awaiting run holds it) would park until timeout.
    awaitTask: deps.awaitTask
      ? (taskId, timeoutMs) => deps.awaitTask!(taskId, timeoutMs, opts.agent.id)
      : undefined,
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
    verifierSpend: { tokens: 0, costUsd: 0 },
    childTraces: [],
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
    log.error(`policy load failed for ${opts.agent.id}`, e);
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
      } catch (e) { log.error(`kb recall failed for ${opts.agent.id}`, e); }
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
  } catch (e) { log.error(`skill inject failed for ${opts.agent.id}`, e); }

  // Input artifacts handed in by a delegating parent: render HANDLES + summaries, never inline the
  // body — the child pulls what it needs with read_artifact (size-capped). This is hand-off by reference.
  let inputArtifactsBlock: string | undefined;
  if (opts.inputArtifacts?.length) {
    const lines = opts.inputArtifacts.map((h) => {
      const a = readArtifact(deps.ws, h);
      return a
        ? `- [${artifactHandle(a)}] ${a.title} (${a.type})${a.summary ? " — " + a.summary : ""}`
        : `- [${h}] (unavailable)`;
    });
    inputArtifactsBlock = "## Input artifacts (handed to you by reference)\n" +
      "Read one with read_artifact(id) — do NOT expect its body inlined here.\n" + lines.join("\n");
  }

  const { system } = assemble(opts.agent, {
    visibleAgents: visible,
    brief: opts.brief ? { to: opts.agent.id, ...opts.brief } : undefined,
    policies: applied,
    memoryBlock,
    knowledgeBlock,
    skillsBlock,
    inputArtifactsBlock,
  });
  const tools = toolsForAgent(opts.agent, ctx, deps.mcp);

  const result = await runLoop({
    model, agent: opts.agent, system, messages: opts.messages, tools,
    onStep: emitStep, // stamps agent + runId (Plan 02/10) then forwards to deps.onStep
    // Per-run steer routing (Phase 4): a steer aimed at THIS runId reaches only this run; fall back
    // to the flat queue for unit contexts that don't route.
    pollSteer: (deps.pollSteerFor || deps.pollSteer)
      ? () => deps.pollSteerFor?.({ runId, agentId: opts.agent.id, triggeredBy: opts.triggeredBy }) ?? deps.pollSteer?.() ?? null
      : undefined,
    signal: deps.signal,
    priceUsd,
    codexBackend: subscription, // subscription:true ⇒ Codex backend ⇒ system goes in `instructions`
    captureProviderCost: picked?.captureCost, // OpenRouter reports real cost in providerMetadata
    // Phase 5 recovery: flush each transcript event live + checkpoint the message array per iteration,
    // so a crash mid-run leaves legible evidence and a resume point instead of nothing.
    onEvent: (e) => appendRunTranscript(deps.ws, runId, e),
    checkpoint: (s) => writeRunCheckpoint(deps.ws, runId, s),
    // Plan 09: deck-wide ceilings are metered + enforced here, the same place per-run caps are. Shared
    // across every run (parent + delegated children) so the whole deck's spend counts against them.
    deckLedger: deps.deckLedger,
  });
  const outcome: RunTrace["outcome"] =
    result.aborted ? "interrupted" : result.exhausted ? "blocked" : result.error ? "failed" : "completed";
  if (result.error) log.error(`run ${runId} failed`, result.error);

  const trace: RunTrace = {
    id: runId, agent: opts.agent.id, task: opts.brief?.goal ?? "(chat)", triggeredBy: opts.triggeredBy,
    ledger: { retrieved: applied.map((n) => n.id), applied: applied.map((n) => n.id), skipped: [], knowledge: knowledgeIds, skills: skillIds },
    toolCalls: Object.entries(result.toolCalls).map(([tool, count]) => ({ tool, count })),
    artifacts: ctx.artifacts, inputArtifacts: ctx.inputArtifacts, outputArtifacts: ctx.outputArtifacts,
    delegatedOut: ctx.delegatedOut, verification: ctx.verifications, outcome,
    tokens: result.tokens, costUsd: subscription ? null : result.costUsd,
    costNote: subscription ? "subscription" : undefined,
    // This run's own delegation-checker spend (Plan 06), surfaced separately from the primary loop so
    // /costs can add it to this run's own-spend total (the checker creates no child trace, so it's
    // counted exactly once). USD stays 0 for subscription runs — honest, never a fabricated price.
    verifierTokens: ctx.verifierSpend.tokens,
    verifierCostUsd: subscription ? 0 : ctx.verifierSpend.costUsd,
    model: picked?.modelId, // the /costs "by provider/model" dimension; undefined in headless/unit contexts without a resolver
    // aggregate = this run's own loop + child RUNS + this run's delegation-checker calls. All three
    // are real model spend this run caused; verifier spend is 0 for subscription (costUsd stays null).
    aggregate: {
      tokens: result.tokens + ctx.childSpend.tokens + ctx.verifierSpend.tokens,
      costUsd: subscription ? null : result.costUsd + ctx.childSpend.costUsd + ctx.verifierSpend.costUsd,
    },
    notes: ctx.notes,
    durationMs: Math.round(performance.now() - t0), started,
  };
  // The loop's model events (model_request/response/tool_call) were flushed LIVE via onEvent
  // (incremental recovery, Plan 04 Phase 5). The tool/approval SPAN events (Plan 02/10) buffer in
  // ctx.spanEvents — flush them here. The waterfall reader pairs spans by callId/iteration and times
  // them by each event's `ts`, so append order is irrelevant. Do NOT re-write result.transcript:
  // onEvent already persisted it live, and doing both would double-write every loop event.
  for (const event of ctx.spanEvents) appendRunTranscript(deps.ws, runId, event);
  // Verdicts are part of the run's story ("why did it retry?") — record them in the transcript too.
  for (const v of ctx.verifications) appendRunTranscript(deps.ws, runId, { ts: new Date().toISOString(), kind: "verification", data: v });
  writeChildRuns(deps.ws, runId, ctx.childTraces);
  writeRunFinal(deps.ws, runId, result.error ? `error: ${result.error}` : result.text);
  writeRunFailure(deps.ws, runId, trace, result.error ? `error: ${result.error}` : result.text);
  writeTrace(deps.ws, trace);
  deps.onRunEnd?.({ runId, agent: opts.agent.id, triggeredBy: opts.triggeredBy, outcome });
  return { runId, text: result.error ? `error: ${result.error}` : result.text, trace };
}
