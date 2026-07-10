/** Orchestrates ONE agent run: assemble prompt -> build tools -> runLoop -> write trace.
 *  RunDeps are the seams (model, approval, child-run spawning); makeDeps wires the real ones. */
import type { Database } from "bun:sqlite";
import { generateText, type ModelMessage } from "ai";
import type { AgentDef } from "../schemas/agent";
import type { RunTrace, VerificationRecord, VerificationVerdict } from "../schemas/trace";
import { assemble, type RosterTeam } from "./prompt";
import { listTeams, loadTeam, membersOf } from "../store/teams";
import { routeToTeam } from "./team-routing";
import { effectiveTools } from "../schemas/team";
import { runLoop } from "./loop";
import { runChecker } from "./verification";
import { canDelegate, visibleToRows, acl } from "./registry";
import { rankAgents, type AgentHit } from "./discovery";
import { toolsForAgent } from "./tools";
import { readArtifact } from "../store/artifacts";
import { listAnnotations } from "../store/annotations";
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
import { compactionThreshold } from "./compaction";
import { recordUserTurn, recordTurnOutcome, recordTurnFailure } from "./turn-audit";
import { listPolicies } from "../store/policy";
import type { PolicyNote } from "../schemas/policy";
import type { McpManager } from "./mcp/manager";
import type { McpServerConfig } from "../store/config";
import { scopesFor, type SpendLedger } from "../store/spend-ledger";
import type { Verdict } from "./command-guard";
import { log, redact } from "./logger";
import { trace as otelTrace, context, SpanStatusCode, ioAttrs, type Span, type Telemetry } from "./otel";

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
  | { kind: "run_command"; command: string; cwd?: string; reason?: string };
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
  runSandboxed?: (command: string, cwd: string, writableRoot?: string) => { exitCode: number; stdout: string; stderr: string; enforced: boolean }; // test seam (Plan 08 sandbox); writableRoot anchors the confined write set to ctx.ws (NOT the model cwd)
  /** Plan 08 injection guard: flipped to `entered: true` (recording the source tool names) the moment
   *  read_url OR any granted MCP tool returns — attacker-influenceable content that has entered this
   *  run. Once set, run_command forces the captain's approval (a dcg `allow` no longer auto-runs it):
   *  ingest-untrusted-then-execute is the classic prompt-injection→execution chain. Set by the
   *  instrument() seam in tools.ts. */
  untrusted: { entered: boolean; sources: string[] };
  ingestSource?: string; // when set (a source-ingestion run), remember stamps this instead of agentId:runId
  artifacts: string[];
  inputArtifacts: string[];   // artifact handles this run handed DOWN to children (hand-off graph)
  outputArtifacts: string[];  // artifact handles this run received UP from children
  delegatedOut: string[];
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  createAgent: (draft: NewAgentDraft) => Promise<AgentDef>;
  canDelegate: (toId: string) => boolean;
  runChild: (brief: { to: string; goal: string; context?: string; criteria?: string; inputArtifacts?: string[]; callId?: string }) => Promise<RunResult>;
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
  /** Plan 19: `to` may name an agent or a team. Resolves the team to the agent that will actually run
   *  (its lead, or the best-ranked member), then applies the ACL / cycle / depth / run-count guards to
   *  THAT agent. `note` describes a team routing decision, so a bad keyword pick is never silent. */
  resolveDelegation: (
    to: string,
    goal: string,
  ) => { ok: true; agentId: string; team?: string; note?: string } | { ok: false; error: string };
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
  /** Plan 16: OpenTelemetry handle, so the tool `instrument()` wrapper can open a `<tool>` span per
   *  call (named + carrying args/result), under which a delegated child run nests. Undefined ⇒ off. */
  telemetry?: Telemetry;
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
  onRunStart?: (info: { runId: string; agent: string; triggeredBy: string; messages: ModelMessage[]; spawnCallId?: string }) => void;
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
  /** Plan 09: squad-wide spend ledger, shared by ALL runs in a session (including delegated children),
   *  enforced in the loop and persisted across sessions. Undefined ⇒ no squad ceilings configured. */
  spendLedger?: SpendLedger;
  /** Plan 16: OpenTelemetry handle, shared by ALL runs in a session. When set, executeRun opens a run
   *  span (making it active so the AI SDK's gen_ai spans + delegated child runs nest under it) and feeds
   *  run/model metrics. Undefined ⇒ telemetry disabled (no OTLP endpoint configured). */
  telemetry?: Telemetry;
}

/** Coarse provider label (gen_ai.system) for the model spans + metrics. taicho emits its own spans
 *  (not the AI SDK's), so this is the provider attribute source; a best-effort id-shape heuristic. */
function providerLabel(modelId: string | undefined, subscription: boolean): string {
  if (subscription) return "openai"; // ChatGPT subscription rides the Codex (OpenAI) backend
  if (!modelId) return "unknown";
  if (modelId.includes("/")) return "openrouter"; // namespaced vendor/model
  if (modelId.startsWith("claude")) return "anthropic";
  if (/^(gpt|o[13]|text-|chatgpt)/.test(modelId)) return "openai";
  return "unknown";
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
  spendLedger?: RunDeps["spendLedger"];
  telemetry?: RunDeps["telemetry"];
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
    spendLedger: opts.spendLedger,
    telemetry: opts.telemetry,
  };
}

export async function executeRun(
  deps: RunDeps,
  opts: { agent: AgentDef; messages: ModelMessage[]; brief?: { from: string; goal: string; context?: string; criteria?: string; fromRun: string }; inputArtifacts?: string[]; triggeredBy: string; depth?: number; ancestry?: string[]; ingestSource?: string; taintedContext?: boolean; spawnCallId?: string },
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
  deps.onRunStart?.({ runId, agent: opts.agent.id, triggeredBy: opts.triggeredBy, messages: opts.messages, spawnCallId: opts.spawnCallId });
  writeRunInput(deps.ws, runId, {
    runId,
    triggeredBy: opts.triggeredBy,
    agent: opts.agent.id,
    task: opts.brief?.goal ?? "(chat)",
    messagesPassedToModel: opts.messages,
    parentRunId: opts.brief?.fromRun,
  });

  // Plan 01 Ph5 — the turn-outcome audit is an ENGINE seam (was App-local; PR #17), so every caller
  // (REPL, headless, tests) gets identical ledger + task + replay audit. A user CONVERSATION turn is
  // triggeredBy the LITERAL "user" and NOT a `/kb sync` ingest (ingestSource): those get run evidence
  // but no ledger/task, exactly as before. Autonomous automation is likewise NOT a conversation turn —
  // a background dispatch cascade is triggeredBy a taskId, and a scheduler fire (cron/interval/watch,
  // `taicho schedule run`) is triggeredBy "schedule:<id>" — so both are excluded by the exact-"user"
  // check here, and never pollute the target agent's append-only ledger or its boot-replay cache. Open
  // the user turn + task record now, before any model call, so an interrupted/failed run still leaves
  // the turn audited. Closed at run end by recordTurnOutcome (or by recordTurnFailure on a pre-run throw).
  const isUserTurn = opts.triggeredBy === "user" && !opts.ingestSource;
  const userTurn = isUserTurn
    ? recordUserTurn(deps.ws, deps.db, { agent: opts.agent.id, runId, text: lastUserText(opts.messages) })
    : undefined;

  // Exception-safe seam: recordUserTurn just opened a `submitted` ledger turn + a `running` task. The
  // PRE-loop setup below (deps.resolveModel — the OpenRouter/explicit-model guard — plus prompt assembly
  // and tool build) can THROW before the loop ever runs. Guard it so such a throw settles the turn to a
  // terminal `failed` outcome instead of leaving a dangling `submitted` turn + a `running` task. Scope is
  // PRE-loop ONLY: `turnClosed` is set the instant runLoop returns a terminal result (below), so a throw
  // in POST-loop finalization PROPAGATES and never re-settles an ALREADY-COMPLETED run as a pre-run
  // failure. (runLoop itself does NOT throw for model errors — it returns result.error → outcome
  // "failed", which the normal close records via recordTurnOutcome, not the catch.)
  let turnClosed = false;

  // Plan 16: open THIS run's OpenTelemetry span BEFORE the try, so a pre-loop throw still closes it in
  // the catch. It parents to whatever span is active — for a delegated child that is the parent run's
  // `delegate_task` tool span (the AI SDK sets it active during execute), so a delegation is ONE
  // distributed trace. It is made active around runLoop (below) so the AI SDK's gen_ai spans and any
  // child runs nest under it. finishRunSpan is idempotent: called on the normal finalize AND in the
  // catch, so the span always closes and the active-run gauge always decrements exactly once.
  const tel = deps.telemetry;
  // The run's input = the delegated goal, else this turn's user text — so the run/sub-run node shows
  // WHAT it was asked (gated by captureContent, like the model-span prompt/completion).
  const runInput = opts.brief?.goal ?? lastUserText(opts.messages);
  // A meaningful, mockup-grade label: "root · user turn", "researcher · delegated".
  const runKind = opts.triggeredBy === "user" ? "user turn"
    : opts.ingestSource ? "ingest"
    : opts.triggeredBy.startsWith("schedule:") ? "scheduled"
    : opts.triggeredBy.startsWith("task_") ? "task"
    : "delegated";
  const runSpan: Span | undefined = tel?.tracerFor(opts.agent.id).startSpan(`${opts.agent.id} · ${runKind}`, {
    attributes: {
      "taicho.agent": opts.agent.id,
      "taicho.run.id": runId,
      "taicho.triggered_by": opts.triggeredBy,
      "taicho.depth": depth,
      ...(tel.captureContent && runInput ? ioAttrs("input", runInput) : {}),
    },
  });
  if (runSpan) tel!.runStarted(opts.agent.id);
  let runSpanDone = false;
  const finishRunSpan = (o: RunTrace["outcome"], attrs?: Record<string, string | number>, err?: string, output?: string) => {
    if (!tel || !runSpan || runSpanDone) return;
    runSpanDone = true;
    if (attrs) runSpan.setAttributes(attrs);
    if (tel.captureContent && output) runSpan.setAttributes(ioAttrs("output", output)); // WHAT it produced
    runSpan.setAttribute("taicho.run.outcome", o);
    if (err) runSpan.setStatus({ code: SpanStatusCode.ERROR, message: err });
    runSpan.end();
    tel.runFinished({ agent: opts.agent.id, outcome: o, durationMs: performance.now() - t0 });
  };

  try {
  // Resolve THIS agent's model up front (before tools are built) so the delegation checker can run
  // on the same model plumbing the loop uses — an independent call on the delegating agent's model.
  const picked = deps.resolveModel?.(opts.agent.id);
  const subscription = picked?.subscription === true;
  const model = picked?.model ?? deps.model;
  const priceUsd = picked ? pricerFor(picked.modelId) : deps.priceUsd;

  // Plan 16: the run span was opened before the try (so the catch can close it); now that the model is
  // resolved, stamp the model id and build the loop's telemetry (gen_ai spans + per-call metrics).
  if (runSpan && picked?.modelId) runSpan.setAttribute("gen_ai.request.model", picked.modelId);
  const loopTelemetry = tel && runSpan
    ? {
        tracer: tel.tracerFor(opts.agent.id),
        captureContent: tel.captureContent,
        model: picked?.modelId ?? "model",
        provider: providerLabel(picked?.modelId, subscription),
        agent: opts.agent.id,
        onModelCall: (m: { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }) =>
          tel.recordModelCall({
            provider: providerLabel(picked?.modelId, subscription),
            model: picked?.modelId ?? "unknown",
            inputTokens: m.inputTokens, outputTokens: m.outputTokens,
            costUsd: subscription ? null : m.costUsd, durationMs: m.durationMs,
          }),
      }
    : undefined;

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
    // Plan 08 injection guard — armed by ingestion tools (read_url / read_artifact / recall / read_source /
    // MCP + delegation results). Defense-in-depth: a child spawned by a TAINTED parent starts pre-armed
    // (`taintedContext`), because the parent's brief/context may itself carry injected instructions —
    // this closes the synchronous cross-run brief-laundering path (parent ingests → hides a command in
    // the child's brief → child auto-runs it). See the cross-run residual note for what remains.
    untrusted: { entered: opts.taintedContext === true, sources: opts.taintedContext ? ["parent-brief"] : [] },
    spanEvents, emitStep, telemetry: tel,
    requestApproval: wrappedRequestApproval,
    createAgent: (draft) => createAgent(deps.ws, deps.db, draft, opts.agent.id, deps.configDefaults),
    canDelegate: (toId) => canDelegate(opts.agent, loadIndex(deps.db).find((r) => r.id === toId) ?? { id: toId }),
    runChild: async ({ to, goal, context, criteria, inputArtifacts, callId }) => {
      const child = await loadAgent(deps.ws, to);
      return executeRun(deps, {
        agent: child,
        messages: [{ role: "user", content: context ? `${goal}\n\nContext: ${context}` : goal }],
        brief: { from: opts.agent.id, goal, context, criteria, fromRun: runId },
        inputArtifacts, // handed to the child by REFERENCE (handles + summaries in the prompt, not inlined bodies)
        triggeredBy: runId,
        depth: depth + 1,
        ancestry: [...ancestry, opts.agent.id],
        // Plan 02 Ph6: the spawning delegate_task callId, so the LIVE waterfall nests this child under
        // that EXACT tool span (deterministic even for concurrent delegations in one turn).
        spawnCallId: callId,
        // Plan 08 injection guard: if THIS run has ingested untrusted content by the time it delegates,
        // the brief it hands down is itself untrusted — pre-arm the child so its run_command is gated.
        taintedContext: ctx.untrusted.entered,
      });
    },
    verifications: [],
    checkCriteria: async (p) => {
      const run = () => runChecker({
        model, agent: opts.agent, subscription, priceUsd,
        captureProviderCost: picked?.captureCost, signal: deps.signal,
        // Plan 09: the checker runs on the same shared ledger the primary loop uses, so its tokens
        // (and USD, when priced) count against the ceilings and are bounded by them — not invisible.
        // Plan 19: it is spend the DELEGATING agent caused, so it meters against ITS team, not the child's.
        spendLedger: deps.spendLedger,
        spendScopes: scopesFor(opts.agent.team),
        goal: p.goal, criteria: p.criteria, output: p.output,
      });
      // Plan 16: the independent verification checker as its own "VERIFY" span — nests under the active
      // delegate_task tool span, named with the verdict once known ("checker · criteria pass/fail").
      const span = tel?.tracerFor(opts.agent.id).startSpan("checker", {
        attributes: { "taicho.kind": "verify", ...(tel.captureContent ? ioAttrs("input", p.criteria) : {}) },
      });
      if (!span) return run();
      try {
        const r = await context.with(otelTrace.setSpan(context.active(), span), run);
        span.updateName(`checker · criteria ${r.verdict.pass ? "pass" : "fail"}`);
        span.setAttribute("taicho.verify.pass", r.verdict.pass);
        if (tel!.captureContent) span.setAttributes(ioAttrs("output", r.verdict.reasons?.join("; ") || (r.verdict.pass ? "pass" : "fail")));
        return r;
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        span.end();
      }
    },
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
    // Discovery respects the caller's visibility ACL, consistent with the inline-roster path. `acl`
    // understands the Plan 19 `team:<id>` entry, so a member's find_agents is scoped to its own team.
    findAgents: (query, k) =>
      rankAgents(
        loadIndex(deps.db)
          .filter((r) => acl(opts.agent.canSee, r))
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
    // Plan 19: `to` may name an agent OR a team. Ids share one namespace (roster.createAgent and
    // teams.createTeam both enforce it), so a bare "news" is unambiguous; "team:news" is accepted too.
    // RESOLVE FIRST, then cycle-check the resolved AGENT — checking the team id would let
    // root → news → editor → news → editor loop forever, since the team id is never in `ancestry`.
    resolveDelegation: (to, goal) => {
      const explicitTeam = to.startsWith("team:");
      const bareId = explicitTeam ? to.slice(5) : to;
      // An agent id wins a bare lookup; the shared namespace means only one of the two can exist.
      const row = explicitTeam ? undefined : loadIndex(deps.db).find((r) => r.id === bareId);
      const team = row ? null : loadTeam(deps.ws, bareId);

      if (!team && !row) return { ok: false, error: `no agent or team "${to}"` };
      if (!canDelegate(opts.agent, team ? { id: team.id, isTeam: true } : row!))
        return { ok: false, error: `not permitted to delegate to "${to}"` };

      let target = row?.id ?? "";
      let note: string | undefined;
      if (team) {
        const route = routeToTeam(team, membersOf(deps.db, team.id), goal, [opts.agent.id, ...ancestry]);
        if (!route.ok) return { ok: false, error: route.error };
        target = route.agentId;
        note = `routed ${team.id} → ${target} (${route.why})`;
      }

      if (target === opts.agent.id || ancestry.includes(target))
        return { ok: false, error: `delegation cycle: "${target}" is already an ancestor` };
      // inclusive: root is depth 0, so this allows up to MAX_DELEGATION_DEPTH levels of descendants.
      // A led team consumes a level, which is why the message says so.
      if (depth + 1 > MAX_DELEGATION_DEPTH)
        return { ok: false, error: `max delegation depth (${MAX_DELEGATION_DEPTH}) reached (a team with a lead consumes one level)` };
      if (deps.runCounter!.n >= MAX_RUNS_PER_REQUEST) return { ok: false, error: `max runs per request (${MAX_RUNS_PER_REQUEST}) reached` };
      return { ok: true, agentId: target, team: team?.id, note };
    },
  };

  // Visibility from the registry index only — never load every agent's identity (unbounded roster).
  const visibleRows = visibleToRows(opts.agent, loadIndex(deps.db));

  // Plan 19: the roster shows TEAMS this agent may address, plus the agents no shown team accounts
  // for. Root therefore reads five team lines instead of sixty agent lines, and is pointed at the
  // address it should be using. A squad with no teams/ directory takes the `[]` path and renders
  // exactly as it did before this plan. The scan is a handful of files (teams are captain-owned).
  const rosterTeams: RosterTeam[] = listTeams(deps.ws)
    .filter((t) => canDelegate(opts.agent, { id: t.id, isTeam: true }))
    .map((t) => ({ id: t.id, charter: t.charter, lead: t.lead, memberCount: membersOf(deps.db, t.id).length }))
    .filter((t) => t.memberCount > 0); // an empty team is an address that goes nowhere — don't advertise it
  const shown = new Set(rosterTeams.map((t) => t.id));
  const visible = visibleRows.filter((r) => !r.team || !shown.has(r.team));

  // The agent's own team: its charter is a standing instruction, its tool policy layers over the
  // member's own grant (deny wins; the DEFAULT_WORKER_TOOLS floor is protected at team load).
  const ownTeam = opts.agent.team ? loadTeam(deps.ws, opts.agent.team) : null;
  const agentTools = effectiveTools(opts.agent.tools, ownTeam?.tools);

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

  // Auto-inject relevant squad knowledge for agents that use the KB (like coaching notes): keyword+
  // graph normally, semantic when an embedder is configured. Skipped for agents without `recall`.
  let knowledgeBlock: string | undefined;
  let knowledgeIds: string[] = [];
  // Plan 19: a team that grants `recall` gives every member the KB, auto-injection included.
  if (agentTools.includes("recall")) {
    const q = opts.brief?.goal ?? lastUserText(opts.messages);
    if (q.trim()) {
      try {
        const kb = await searchKnowledge({ db: deps.db, query: q, embed: deps.embed, k: 5, hops: 1 });
        if (kb.hits.length) {
          knowledgeIds = kb.hits.map((h) => h.id);
          knowledgeBlock = "## Relevant knowledge (shared squad memory — call recall for more)\n" +
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
  // Plan 01 Ph4: any OPEN annotation on the handed artifact rides along here — that is the annotation →
  // revision path. An input artifact carrying open feedback IS a revision brief: the child addresses the
  // points and saves a new version linked back. A verification verdict (Plan 06) surfaces identically.
  let inputArtifactsBlock: string | undefined;
  let sawOpenFeedback = false;
  if (opts.inputArtifacts?.length) {
    const lines = opts.inputArtifacts.map((h) => {
      const a = readArtifact(deps.ws, h);
      if (!a) return `- [${h}] (unavailable)`;
      const handle = artifactHandle(a);
      const open = listAnnotations(deps.ws, handle, { status: "open" });
      if (open.length) sawOpenFeedback = true;
      const feedback = open.map((an) =>
        `    ↳ ${an.kind === "verification" ? "verdict" : "feedback"} from ${an.author}: ${an.body}` +
        (an.verdict ? ` [${an.verdict.pass ? "PASS" : "FAIL: " + an.verdict.reasons.join("; ")}]` : ""));
      return [`- [${handle}] ${a.title} (${a.type})${a.summary ? " — " + a.summary : ""}`, ...feedback].join("\n");
    });
    inputArtifactsBlock = "## Input artifacts (handed to you by reference)\n" +
      "Read one with read_artifact(id) — do NOT expect its body inlined here." +
      (sawOpenFeedback
        ? " An artifact with open feedback below is a REVISION: address EVERY point (list_annotations for detail), " +
          "then save_artifact with the SAME id (a new version) and parents:[the handle].\n"
        : "\n") +
      lines.join("\n");
  }

  const { system } = assemble(opts.agent, {
    visibleAgents: visible,
    teams: rosterTeams,
    teamCharter: ownTeam?.charterBody || undefined,
    brief: opts.brief ? { to: opts.agent.id, ...opts.brief } : undefined,
    policies: applied,
    memoryBlock,
    knowledgeBlock,
    skillsBlock,
    inputArtifactsBlock,
  });
  const tools = toolsForAgent(opts.agent, ctx, deps.mcp, ownTeam?.tools);

  const runLoopCall = () => runLoop({
    model, agent: opts.agent, system, messages: opts.messages, tools,
    telemetry: loopTelemetry, // Plan 16: gen_ai spans + model metrics for this run's calls
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
    // Plan 05: config disposes the compaction threshold — per-model window table × defaults.compactAt
    // (default ~70%). The loop MEASURES context every iteration and FOLDS the oldest round-trips once
    // this estimate is crossed (system + original brief + recent N kept verbatim).
    compactThresholdTokens: compactionThreshold(picked?.modelId, deps.configDefaults?.compactAt),
    // Phase 5 recovery: flush each transcript event live + checkpoint the message array per iteration,
    // so a crash mid-run leaves legible evidence and a resume point instead of nothing.
    onEvent: (e) => appendRunTranscript(deps.ws, runId, e),
    checkpoint: (s) => writeRunCheckpoint(deps.ws, runId, s),
    // Plan 09: squad-wide ceilings are metered + enforced here, the same place per-run caps are. Shared
    // across every run (parent + delegated children) so the whole squad's spend counts against them.
    spendLedger: deps.spendLedger,
    // Plan 19: this run is ALSO metered against its own team's ceiling, so a team can be capped
    // independently. A delegated child is metered against ITS team, not its parent's — the spend is
    // the child's to answer for.
    spendScopes: scopesFor(opts.agent.team),
    // Plan 12 (reopened): per-request transport deadline for the model fetch. Also bounds consumeStream()
    // in case the underlying stream ignores the abort signal. Config-disposed via defaults.modelRequestTimeoutMs.
    modelRequestTimeoutMs: deps.configDefaults?.modelRequestTimeoutMs,
  });
  // Plan 16: run the loop with THIS run's span active, so the AI SDK's gen_ai spans and any delegated
  // child runs nest under it (context propagation via AsyncLocalStorage). No span ⇒ call it directly.
  const result = runSpan
    ? await context.with(otelTrace.setSpan(context.active(), runSpan), runLoopCall)
    : await runLoopCall();
  // The run has COMPLETED the moment runLoop returns a terminal result — mark the turn closed HERE,
  // BEFORE the post-loop finalization/close block. This scopes the catch's recordTurnFailure to genuine
  // PRE-loop throws only: a throw in finalization (writeTrace / recordTurnOutcome → rebuildReplayCache /
  // writeThread / …) must PROPAGATE, never re-settle a completed run as a pre-run failure (which would
  // duplicate the ledger turn, flip the user turn's context decision included→excluded, and mark the
  // task failed). Even a `result.error` outcome ("failed") is a run that RAN — recorded by the normal
  // close below, not by the catch.
  turnClosed = true;
  const outcome: RunTrace["outcome"] =
    result.aborted ? "interrupted" : result.exhausted ? "blocked" : result.error ? "failed" : "completed";
  if (result.error) log.error(`run ${runId} failed`, result.error);

  const trace: RunTrace = {
    id: runId, agent: opts.agent.id, task: opts.brief?.goal ?? "(chat)", triggeredBy: opts.triggeredBy,
    ledger: { retrieved: applied.map((n) => n.id), applied: applied.map((n) => n.id), skipped: [], knowledge: knowledgeIds, skills: skillIds },
    toolCalls: Object.entries(result.toolCalls).map(([tool, count]) => ({ tool, count })),
    artifacts: ctx.artifacts, inputArtifacts: ctx.inputArtifacts, outputArtifacts: ctx.outputArtifacts,
    delegatedOut: ctx.delegatedOut, verification: ctx.verifications, outcome,
    tokens: result.tokens, contextTokens: result.contextTokens, costUsd: subscription ? null : result.costUsd,
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
  const finalText = result.error ? `error: ${result.error}` : result.text;
  writeRunFinal(deps.ws, runId, finalText);
  writeRunFailure(deps.ws, runId, trace, finalText);
  writeTrace(deps.ws, trace);
  // Plan 01 Ph5 seam (close): record the assistant turn + context decision + task update, and rebuild
  // the derived boot-replay cache (Plan 05 Ph3 folds older turns into a rolling summary here). Guarded
  // to user conversation turns; children (triggeredBy = runId) and ingest runs are untouched.
  if (isUserTurn) {
    recordTurnOutcome(deps.ws, deps.db, {
      agent: opts.agent.id, runId, userTurn, trace, children: ctx.childTraces, text: finalText,
      keepRecentTurns: deps.configDefaults?.replayKeepTurns,
    });
  }
  // Plan 16: close the run span with the final rollups (tokens, cost, context) + outcome/status.
  finishRunSpan(outcome, {
    "taicho.tokens": result.tokens,
    "gen_ai.usage.input_tokens": result.inputTokens,
    "gen_ai.usage.output_tokens": result.outputTokens,
    "taicho.context.tokens": result.contextTokens,
    ...(subscription ? {} : { "taicho.cost.usd": result.costUsd }),
  }, result.error, finalText);
  deps.onRunEnd?.({ runId, agent: opts.agent.id, triggeredBy: opts.triggeredBy, outcome });
  return { runId, text: finalText, trace };
  } catch (err) {
    // Plan 16: a throw anywhere in the run must still close the span + decrement the active-run gauge
    // (idempotent — a no-op if finalize already closed it on the normal path).
    finishRunSpan("failed", undefined, err instanceof Error ? err.message : String(err));
    // A PRE-loop throw (resolveModel / prompt + tool build) between recordUserTurn and runLoop returning
    // would strand the open turn — settle it to a terminal `failed` outcome so the ledger + task never
    // dangle, then re-throw so the caller still sees the real error. `turnClosed` is already true once
    // runLoop has returned, so a POST-loop finalization throw skips this and simply propagates unchanged.
    if (isUserTurn && userTurn && !turnClosed) {
      try {
        recordTurnFailure(deps.ws, deps.db, {
          agent: opts.agent.id, runId, userTurn,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (closeErr) {
        log.error(`could not close dangling turn for ${opts.agent.id}/${runId}`, closeErr);
      }
    }
    throw err;
  }
}
