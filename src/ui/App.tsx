import { useState, useRef, useEffect, useCallback } from "react";
import { Box, Text, useInput, useApp, useStdout, type Key } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import type { Database } from "bun:sqlite";
import { ProposalCard, type CardField, type CardKeyHandler } from "./ProposalCard";
import { QuestionCard } from "./QuestionCard";
import { parseInput } from "./input";
import { BANNER } from "./banner";
import { makeDeps, executeRun, type Model, type ApprovalRequest, type ApprovalDecision } from "../core/run";
import { loadAgent, loadIndex, LIBRARIAN_ID, type RegistryRow } from "../store/roster";
import { listTraces, readTrace } from "../store/trace";
import { listPolicies, deletePolicy } from "../store/policy";
import { appendTurn, shouldPersistTurn } from "../store/thread";
import { appendLedgerTurn, newTurnId, recordContextDecision, statusFromOutcome } from "../store/conversation";
import { createTaskState, taskIdForRun, updateTaskFromTrace, createBackgroundTask, setTaskFields, cancelTaskState, listTaskIndex, readTaskState, mkTaskId } from "../store/task-state";
import { TaskScheduler } from "../core/tasks";
import type { RunResult, TaskAwaitResult, RunDeps } from "../core/run";
import type { ModelMessage } from "ai";
import type { AuthSource, TaichoConfig } from "../store/config";
import { isStdioServer } from "../store/config";
import { formatAuthStatus, noCredentialLines, authExpiredMessage } from "../core/auth/status";
import { runSlash as runSlashPure, type Line, type SlashCommand, suggestCommands, cycleIndex } from "./slash";
import { renderMarkdown } from "./markdown";
import { splitCompletedBlocks } from "./markdown-stream";
import { draftPolicy, persistApprovedPolicy } from "../coaching/teach";
import { mergeDraft } from "../core/draft";
import type { McpManager } from "../core/mcp/manager";
import { addMcpServer, removeMcpServer } from "../store/mcp-store";
import { parseMcpCommand, formatMcpStatus, parseKbCommand, parseSkillCommand } from "./slash";
import { syncKnowledgeSources } from "../knowledge/sync";
import { listNodeRows, forgetNodes, reindexKnowledge, reembedAll } from "../store/knowledge";
import { listSkills, readSkill, deleteSkill, reindexSkills } from "../store/skills";

type Pending = { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void } | null;

type ResolveModelFn = (agentId: string) => { model: Model; modelId: string; subscription?: boolean; captureCost?: boolean };
type PriceFn = (u: { inputTokens: number; outputTokens: number }) => number;
interface BuiltAuth { model: Model | null; resolveModel?: ResolveModelFn; priceUsd?: PriceFn }

/** Animated run indicator: @inkjs/ui Spinner (owns its own glyph animation) + the live activity
 *  (which agent is doing what) + elapsed seconds + the controls hint. A light ticker re-renders only
 *  to advance the elapsed-seconds readout. */
function RunStatus({ activity }: { activity: string }) {
  const [, setTick] = useState(0);
  const started = useRef(Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 200);
    return () => clearInterval(t);
  }, []);
  const secs = ((Date.now() - started.current) / 1000).toFixed(1);
  return (
    <Box>
      <Spinner label={activity} />
      <Text color="gray">{`  ${secs}s  `}</Text>
      <Text dimColor>esc to cancel · type to steer</Text>
    </Box>
  );
}

/** Title + fields for the non-question approval cards. */
function proposalView(req: Exclude<ApprovalRequest, { kind: "ask_human" }>): { title: string; fields: CardField[] } {
  if (req.kind === "propose_coaching")
    return { title: "New coaching note — approve?", fields: [
      { label: "when", value: req.draft.when }, { label: "do", value: req.draft.do }, { label: "scope", value: req.draft.scope },
    ] };
  if (req.kind === "add_mcp") {
    const transport = isStdioServer(req.spec) ? `${req.spec.command} ${(req.spec.args ?? []).join(" ")}`.trim() : req.spec.url;
    const env = isStdioServer(req.spec) ? Object.keys(req.spec.env ?? {}).join(", ") : (req.spec.auth ?? Object.keys(req.spec.headers ?? {}).join(", "));
    return { title: "Add MCP server — approve?", fields: [
      { label: "name", value: req.name }, { label: "transport", value: transport }, { label: "env", value: env || "—" },
    ] };
  }
  if (req.kind === "propose_skill")
    return { title: "New skill — approve?", fields: [
      { label: "name", value: req.draft.name },
      { label: "when", value: req.draft.description },
      { label: "procedure", value: req.draft.body },
    ] };
  if (req.kind === "run_command")
    return { title: "Run command — approve?", fields: [
      { label: "command", value: req.command },
      { label: "flagged", value: req.reason ?? "the guard flagged this command" },
    ] };
  return { title: "New agent — approve?", fields: [
    { label: "id", value: req.draft.id }, { label: "role", value: req.draft.role }, { label: "identity", value: req.draft.identity },
  ] };
}

export function App(props: {
  ws: string; db: Database; model: Model | null; roster: RegistryRow[];
  cfg: { provider: string; model: string } | null;
  priceUsd?: PriceFn;
  resolveModel?: ResolveModelFn;
  configDefaults?: TaichoConfig["defaults"];
  authSource: AuthSource;
  buildFromAuth: (s: AuthSource) => BuiltAuth;
  onLogin: () => Promise<AuthSource>;
  onLogout: () => boolean;
  rootThread?: ModelMessage[];
  mcp?: McpManager;
  mcpYamlServers?: string[];
  embed?: (text: string) => Promise<Float32Array>;
  startupNotice?: string;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const mdWidth = (stdout?.columns ?? 80) - 2; // small margin so wrapping never hugs the edge
  const [lines, setLines] = useState<Line[]>(() => initialLines(props));
  const [input, setInput] = useState("");
  // @inkjs/ui TextInput is uncontrolled (defaultValue only, no `value`). To set its text
  // programmatically — clear after submit, seed "/cmd " on suggestion-accept — we remount it via a
  // bumped `key` with a fresh seed. onChange keeps `input` in sync for live suggestion matching, so
  // routine typing never remounts (only the deliberate programmatic sets below do).
  const [inputKey, setInputKey] = useState(0);
  const [inputSeed, setInputSeed] = useState("");
  const setInputValue = (v: string) => { setInput(v); setInputSeed(v); setInputKey((k) => k + 1); };
  // MUST be a stable reference: @inkjs/ui TextInput fires onChange from an effect whose deps include
  // `onChange` itself, and its `previousValue` lags one keystroke — so a fresh inline handler re-fires
  // onChange on every App re-render, which would reset `selected` and freeze the suggester highlight.
  const onInputChange = useCallback((v: string) => { setInput(v); setSelected(0); }, []);
  const [selected, setSelected] = useState(0);
  const [activity, setActivity] = useState("working…"); // live status shown by the run spinner
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [roster, setRoster] = useState(props.roster);
  // Live auth: model/resolver/pricer are STATE (seeded from props) so /login can re-arm the REPL
  // without a restart. deps() reads these, so the next submit picks up the new credentials.
  const [authSource, setAuthSource] = useState<AuthSource>(props.authSource);
  const [model, setModel] = useState<Model | null>(props.model);
  const [resolveModel, setResolveModel] = useState<ResolveModelFn | undefined>(() => props.resolveModel);
  const [priceUsd, setPriceUsd] = useState<PriceFn | undefined>(() => props.priceUsd);
  // Plan 04 Phase 4: per-run steer routing replaces the single global queue. steerRoutes maps a
  // runId → its pending steers; activeRuns tracks which agent each live run belongs to (for @agent
  // routing); foregroundRootRef is the current watched turn's root run (plain steer target).
  const steerRoutes = useRef<Map<string, string[]>>(new Map());
  const activeRuns = useRef<Map<string, { agent: string; triggeredBy: string }>>(new Map());
  const foregroundRootRef = useRef<string | null>(null);
  // Plan 04 Phase 2/3: the background task scheduler (persistent queue + per-agent concurrency cap).
  const schedulerRef = useRef<TaskScheduler | null>(null);
  if (!schedulerRef.current) schedulerRef.current = new TaskScheduler();
  const scheduler = schedulerRef.current;
  const thread = useRef<ModelMessage[]>(props.rootThread ?? []);
  const aborter = useRef<AbortController | null>(null);
  // The active approval/question card publishes its key handler here (during its render). App's one
  // boot-registered useInput forwards to it while a card is up — see the useInput below.
  const cardKeyRef = useRef<CardKeyHandler | null>(null);
  // Live streaming: text deltas accumulate in streamRef (authoritative, dodges stale closures). As
  // whole markdown blocks close they commit as rendered (white) lines; the still-growing tail is
  // held back — never shown raw — until it closes into a block (or the run ends and flushStream
  // renders it). The spinner (RunStatus) is the "working" signal while a block is mid-stream.
  // streamedRef records whether ANY delta arrived this run, so we only fall back to res.text for
  // non-streaming (env-key) providers.
  const streamRef = useRef("");
  const streamFromRef = useRef("");
  const streamedRef = useRef(false);
  const streamBlocksRef = useRef(0); // how many completed streamed blocks we've committed this run
  const pendingAuditRef = useRef<{ agent: string; text: string; userTurnId?: string; runId?: string; taskId?: string } | null>(null);

  // The live suggester: which commands match what's being typed (empty once past the command name).
  const sugg = suggestCommands(input);

  useInput((input, key) => {
    // While a card is up, this boot-registered useInput is the only listener guaranteed to be wired
    // when the captain's first keystroke arrives, so we forward it to the active card. (A card-owned
    // useInput registers a beat after its render commits and would drop that first key — the hang
    // we're fixing.) The card publishes its handler to cardKeyRef during render.
    if (pending) { cardKeyRef.current?.(input, key); return; }
    if (key.escape) { if (busy) { aborter.current?.abort(); say({ kind: "system", text: "  ⊗ cancelling…" }); } else { void (async () => { await props.mcp?.closeAll(); exit(); })(); } return; }
    if (sugg.length > 0) {
      if (key.upArrow)   { setSelected((s) => cycleIndex(s, sugg.length, -1)); return; }
      if (key.downArrow) { setSelected((s) => cycleIndex(s, sugg.length, +1)); return; }
      if (key.tab)       { acceptSuggestion(sugg); return; }
    }
  }, { isActive: true });

  const say = (l: Line) => setLines((prev) => [...prev, l]);

  useEffect(() => {
    if (props.startupNotice) say({ kind: "system", text: `  ${props.startupNotice}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Commit the in-progress streamed text (if any) as a finalized agent line — called when a tool
  // interrupts the stream and at run end. No-op when nothing has streamed.
  const flushStream = () => {
    if (streamRef.current) {
      const { blocks, tail } = splitCompletedBlocks(streamRef.current);
      if (blocks.length > streamBlocksRef.current) for (const b of blocks.slice(streamBlocksRef.current)) say({ kind: "agent", from: streamFromRef.current, text: b, rendered: true });
      if (tail.trim()) say({ kind: "agent", from: streamFromRef.current, text: tail, rendered: true });
    }
    streamRef.current = ""; streamBlocksRef.current = 0;
  };

  // Run the highlighted command now (no arg) or fill `/<cmd> ` so the captain can type its argument.
  const acceptSuggestion = (list: SlashCommand[]) => {
    const cmd = list[Math.min(selected, list.length - 1)];
    if (!cmd) return;
    setSelected(0);
    if (cmd.requiresArg) { setInputValue(`/${cmd.name} `); return; }
    setInputValue("");
    say({ kind: "user", text: `/${cmd.name}` });
    void runSlash(cmd.name, "");
  };
  // Best-effort: a failed run whose surfaced text reflects an AuthExpiredError ("session expired")
  // gets an explicit nudge to re-run /login openai (the run already returned a failed outcome).
  const maybeSayAuthExpired = (text: string) => {
    if (/session expired/i.test(text)) say({ kind: "system", text: `  ${authExpiredMessage()}` });
  };

  const requestApproval = (req: ApprovalRequest) =>
    new Promise<ApprovalDecision>((resolve) => setPending({ req, resolve }));

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const TERMINAL_TASK = new Set(["completed", "failed", "interrupted", "cancelled", "partial", "blocked"]);
  const taskSummary = (id: string): TaskAwaitResult => {
    const t = readTaskState(props.ws, id);
    if (!t) return { status: "unknown", error: `no task "${id}"` };
    return { status: t.status, summary: t.summary, resultRef: t.resultRef, runId: t.rootRunId || undefined };
  };

  // A background task settled — record its outcome + a reference (NOT the payload) and notify the
  // captain. A cancelled task keeps its cancelled status (the interrupted outcome doesn't override it).
  const settleTask = (taskId: string, agentId: string, res: RunResult) => {
    const wasCancelled = readTaskState(props.ws, taskId)?.status === "cancelled";
    const children = res.trace.delegatedOut.map((id) => readTrace(props.ws, id));
    updateTaskFromTrace(props.ws, taskId, res.trace, children, props.db);
    const resultRef = res.trace.artifacts[0] ?? res.runId; // hand-off BY REFERENCE (handle or run id)
    setTaskFields(props.ws, props.db, taskId, { resultRef, summary: res.text, rootRunId: res.runId, ...(wasCancelled ? { status: "cancelled" } : {}) });
    const status = readTaskState(props.ws, taskId)?.status ?? "completed";
    const icon = status === "completed" ? "✓" : status === "cancelled" ? "⊗" : "⚠";
    say({ kind: "system", text: `  ${icon} background task ${taskId} (${agentId}) ${status} — /tasks or check_task` });
  };
  const failTask = (taskId: string, agentId: string, e: unknown) => {
    setTaskFields(props.ws, props.db, taskId, { status: "failed", stepStatus: "failed", summary: e instanceof Error ? e.message : String(e) });
    say({ kind: "system", text: `  ⚠ background task ${taskId} (${agentId}) failed — /tasks` });
  };

  // Fire-and-forget a goal onto another agent (dispatch_task). Returns the taskId immediately; the
  // scheduler starts it when the agent is under its maxConcurrentRuns cap (else it stays queued).
  const dispatch: NonNullable<RunDeps["dispatch"]> = (o) => {
    const activeModel = model;
    if (!activeModel) return { error: "no model configured" };
    const taskId = mkTaskId();
    createBackgroundTask(props.ws, props.db, { taskId, agent: o.agent.id, goal: o.goal });
    say({ kind: "system", text: `  ⇢ dispatched ${taskId} → ${o.agent.id} (background)` });
    const start = () => {
      const controller = new AbortController();
      setTaskFields(props.ws, props.db, taskId, { status: "running", stepStatus: "running" });
      const childDeps = deps(activeModel, { signal: controller.signal });
      const messages: ModelMessage[] = [{ role: "user", content: o.context ? `${o.goal}\n\nContext: ${o.context}` : o.goal }];
      const brief = { from: o.parentAgentId, goal: o.goal, context: o.context, criteria: o.criteria, fromRun: o.parentRunId };
      const promise = executeRun(childDeps, { agent: o.agent, messages, brief, inputArtifacts: o.inputArtifacts, triggeredBy: taskId })
        .then((res) => { settleTask(taskId, o.agent.id, res); return res; }, (e) => { failTask(taskId, o.agent.id, e); });
      return { controller, promise };
    };
    scheduler.submit({ taskId, agentId: o.agent.id, cap: o.agent.budgets.maxConcurrentRuns, start });
    return { taskId };
  };

  // Block until a background task settles (bounded). Awaits the scheduler promise when it's running,
  // else polls the persisted record (covers already-settled and still-queued tasks).
  const awaitTask = async (taskId: string, timeoutMs = 120_000): Promise<TaskAwaitResult> => {
    const existing = readTaskState(props.ws, taskId);
    if (!existing) return { status: "unknown", error: `no task "${taskId}"` };
    if (TERMINAL_TASK.has(existing.status)) return taskSummary(taskId);
    const running = scheduler.awaitRunning(taskId);
    if (running) await Promise.race([running, sleep(timeoutMs)]);
    else {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const t = readTaskState(props.ws, taskId);
        if (t && TERMINAL_TASK.has(t.status)) break;
        await sleep(50);
      }
    }
    return taskSummary(taskId);
  };

  const deps = (model: Model, over?: { signal?: AbortSignal }) => makeDeps({
    ws: props.ws, db: props.db, model,
    requestApproval,
    onStep: ({ tool, agent, delta, note }) => {
      if (delta) {
        streamedRef.current = true; streamFromRef.current = agent; streamRef.current += delta;
        const { blocks } = splitCompletedBlocks(streamRef.current);
        if (blocks.length > streamBlocksRef.current) {
          for (const b of blocks.slice(streamBlocksRef.current)) say({ kind: "agent", from: agent, text: b, rendered: true });
          streamBlocksRef.current = blocks.length;
        }
        return;
      }
      // A run-level breadcrumb (e.g. a delegation verification verdict) — surface it to the captain.
      if (note) { flushStream(); say({ kind: "system", text: `  ${note}` }); return; }
      if (tool) { flushStream(); setActivity(`${agent} → ${tool}()`); say({ kind: "system", text: `  ↳ ${agent} → ${tool}()` }); }
    },
    // Per-run steer routing (Phase 4): a run polls only ITS own queued steers.
    pollSteerFor: ({ runId }) => steerRoutes.current.get(runId)?.shift() ?? null,
    signal: over?.signal ?? aborter.current?.signal,
    priceUsd,
    resolveModel,
    configDefaults: props.configDefaults,
    mcp: props.mcp,
    embed: props.embed,
    dispatch,
    awaitTask,
    onRunStart: ({ runId, agent, triggeredBy }) => {
      activeRuns.current.set(runId, { agent, triggeredBy });
      if (triggeredBy === "user" && !foregroundRootRef.current) foregroundRootRef.current = runId;
      const pendingAudit = pendingAuditRef.current;
      if (!pendingAudit || triggeredBy !== "user" || agent !== pendingAudit.agent) return;
      const userTurnId = newTurnId(agent, runId, "user");
      pendingAudit.userTurnId = userTurnId;
      pendingAudit.runId = runId;
      pendingAudit.taskId = taskIdForRun(runId);
      appendLedgerTurn(props.ws, agent, {
        turnId: userTurnId,
        runId,
        timestamp: new Date().toISOString(),
        agent,
        role: "user",
        content: pendingAudit.text,
        status: "submitted",
      });
      createTaskState(props.ws, { runId, title: pendingAudit.text, userTurnId }, props.db);
    },
    onRunEnd: ({ runId }) => {
      activeRuns.current.delete(runId);
      steerRoutes.current.delete(runId);
      if (foregroundRootRef.current === runId) foregroundRootRef.current = null;
    },
  });

  // Route a steer while a run is in flight: `@agent …` → that agent's active run; plain text → the
  // watched (foreground) root run, falling back to any single active run.
  const routeSteer = (value: string) => {
    const push = (runId: string, text: string) => {
      const q = steerRoutes.current.get(runId) ?? [];
      q.push(text);
      steerRoutes.current.set(runId, q);
    };
    const parsed = parseInput(value);
    if (parsed.kind === "address") {
      const hit = [...activeRuns.current.entries()].find(([, v]) => v.agent === parsed.to);
      if (!hit) { say({ kind: "system", text: `  no active run for @${parsed.to} to steer` }); return; }
      push(hit[0], parsed.text);
      say({ kind: "user", text: `(steer @${parsed.to}) ${parsed.text}` });
      return;
    }
    const target = foregroundRootRef.current ?? [...activeRuns.current.keys()][0];
    if (!target) { say({ kind: "system", text: "  nothing running to steer" }); return; }
    push(target, parsed.kind === "chat" ? parsed.text : value);
    say({ kind: "user", text: `(steer) ${value}` });
  };

  const submit = async (value: string) => {
    if (!value.trim()) return;

    if (busy) { setInputValue(""); routeSteer(value); return; }

    const matches = suggestCommands(value);
    if (matches.length > 0) { acceptSuggestion(matches); return; } // Enter selects the highlighted command
    setInputValue("");

    const parsed = parseInput(value);
    say({ kind: "user", text: value });

    // Slash commands work even without a model (e.g. /login to acquire one).
    if (parsed.kind === "slash") return runSlash(parsed.cmd, parsed.arg);

    if (!model) { say({ kind: "system", text: "No credentials — set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY and relaunch, or run /login openai. I won't burn tokens until then." }); return; }
    const activeModel = model;

    setBusy(true);
    setActivity(parsed.kind === "address" ? `${parsed.to} · thinking…` : "root · thinking…");
    foregroundRootRef.current = null; // the next user-triggered onRunStart claims this turn's root
    aborter.current = new AbortController();
    streamRef.current = ""; streamFromRef.current = ""; streamedRef.current = false; streamBlocksRef.current = 0;
    try {
      if (parsed.kind === "chat") {
        pendingAuditRef.current = { agent: "root", text: parsed.text };
        thread.current.push({ role: "user", content: parsed.text });
        const root = await loadAgent(props.ws, "root");
        const res = await executeRun(deps(activeModel), { agent: root, messages: [...thread.current], triggeredBy: "user" });
        flushStream(); // commit the final streamed turn; only fall back to res.text if nothing streamed
        if (!streamedRef.current) say({ kind: "agent", from: "root", text: res.text, rendered: true });
        const audit = pendingAuditRef.current;
        const assistantTurnId = newTurnId("root", res.runId, "assistant");
        appendLedgerTurn(props.ws, "root", {
          turnId: assistantTurnId,
          runId: res.runId,
          timestamp: new Date().toISOString(),
          agent: "root",
          role: "assistant",
          content: res.text,
          status: statusFromOutcome(res.trace.outcome),
        });
        if (audit?.userTurnId) {
          const include = res.trace.outcome === "completed";
          recordContextDecision(props.ws, "root", {
            include,
            turnId: audit.userTurnId,
            runId: res.runId,
            reason: include ? "completed_turn" : `${res.trace.outcome}_run_not_safe_as_context`,
          });
          recordContextDecision(props.ws, "root", {
            include,
            turnId: assistantTurnId,
            runId: res.runId,
            reason: include ? "completed_turn" : `${res.trace.outcome}_run_not_safe_as_context`,
          });
          updateTaskFromTrace(props.ws, audit.taskId ?? taskIdForRun(res.runId), res.trace, res.trace.delegatedOut.map((id) => readTrace(props.ws, id)), props.db);
        }
        if (res.trace.outcome === "completed") {
          thread.current.push({ role: "assistant", content: res.text });
          if (shouldPersistTurn(res.trace.outcome)) {
            appendTurn(props.ws, "root", { role: "user", content: parsed.text });
            appendTurn(props.ws, "root", { role: "assistant", content: res.text });
          }
        } else {
          thread.current.pop(); // drop the user turn so failures don't accumulate as context
          maybeSayAuthExpired(res.text);
          say({ kind: "system", text: `  trace: ${res.runId} (${res.trace.outcome}, ${res.trace.tokens} tok, ${res.trace.costUsd == null ? "subscription" : "$" + res.trace.costUsd.toFixed(4)})` });
        }
        setRoster(loadIndex(props.db)); // create_agent may have grown the squad
      } else {
        pendingAuditRef.current = { agent: parsed.to, text: parsed.text };
        const target = await loadAgent(props.ws, parsed.to).catch(() => null);
        if (!target) { say({ kind: "system", text: `No agent "${parsed.to}". Try /agents, or describe one to root.` }); return; }
        const res = await executeRun(deps(activeModel), { agent: target, messages: [{ role: "user", content: parsed.text }], triggeredBy: "user" });
        flushStream();
        if (!streamedRef.current) say({ kind: "agent", from: target.id, text: res.text, rendered: true });
        const audit = pendingAuditRef.current;
        const assistantTurnId = newTurnId(target.id, res.runId, "assistant");
        appendLedgerTurn(props.ws, target.id, {
          turnId: assistantTurnId,
          runId: res.runId,
          timestamp: new Date().toISOString(),
          agent: target.id,
          role: "assistant",
          content: res.text,
          status: statusFromOutcome(res.trace.outcome),
        });
        if (audit?.userTurnId) {
          const include = res.trace.outcome === "completed";
          recordContextDecision(props.ws, target.id, {
            include,
            turnId: audit.userTurnId,
            runId: res.runId,
            reason: include ? "completed_turn" : `${res.trace.outcome}_run_not_safe_as_context`,
          });
          recordContextDecision(props.ws, target.id, {
            include,
            turnId: assistantTurnId,
            runId: res.runId,
            reason: include ? "completed_turn" : `${res.trace.outcome}_run_not_safe_as_context`,
          });
          updateTaskFromTrace(props.ws, audit.taskId ?? taskIdForRun(res.runId), res.trace, res.trace.delegatedOut.map((id) => readTrace(props.ws, id)), props.db);
        }
        if (res.trace.outcome === "failed") maybeSayAuthExpired(res.text);
        say({ kind: "system", text: `  trace: ${res.runId} (${res.trace.outcome}, ${res.trace.tokens} tok, ${res.trace.costUsd == null ? "subscription" : "$" + res.trace.costUsd.toFixed(4)}, ${res.trace.artifacts.length} artifact(s))` });
      }
    } catch (e) {
      // A pre-run failure that throws rather than returning a failed RunResult — e.g. resolveModel's
      // explicit-model guard for a misconfigured OpenRouter agent. Surface it instead of crashing Ink.
      say({ kind: "system", text: `  ${e instanceof Error ? e.message : String(e)}` });
    } finally { pendingAuditRef.current = null; setBusy(false); }
  };

  const runSlash = async (cmd: string, arg: string) => {
    if (cmd === "status") { say({ kind: "system", text: `  ${formatAuthStatus(authSource)}` }); return; }
    if (cmd === "login") {
      if (arg && arg !== "openai") { say({ kind: "system", text: `  unknown login target: ${arg} (try /login openai)` }); return; }
      setBusy(true);
      setActivity("signing in…");
      say({ kind: "system", text: "  opening browser…" });
      try {
        const src = await props.onLogin();
        const built = props.buildFromAuth(src);
        // Re-arm the live model/resolver/pricer state, then flip authSource. The NEXT submit reads
        // these via deps(), so the REPL is usable without restart.
        setModel(built.model);
        setResolveModel(() => built.resolveModel);
        setPriceUsd(() => built.priceUsd);
        setAuthSource(src);
        say({ kind: "system", text: "  signed in with ChatGPT — ready." });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        say({ kind: "system", text: `  login failed: ${msg}` });
      } finally { setBusy(false); }
      return;
    }
    if (cmd === "logout") {
      if (arg && arg !== "openai") { say({ kind: "system", text: `  unknown logout target: ${arg} (try /logout openai)` }); return; }
      props.onLogout();
      setModel(null);
      setResolveModel(() => undefined);
      setPriceUsd(() => undefined);
      setAuthSource({ kind: "none" });
      say({ kind: "system", text: "  logged out of openai." });
      return;
    }
    if (cmd === "mcp") {
      if (!props.mcp) { say({ kind: "system", text: "  MCP is disabled (set mcp.enabled in taicho.yaml or add a server)." }); return; }
      const mcp = props.mcp;
      const parsed = parseMcpCommand(arg);
      if (parsed.kind === "error") { say({ kind: "system", text: `  ${parsed.message}` }); return; }
      if (parsed.kind === "list") { formatMcpStatus(mcp.list()).forEach((t) => say({ kind: "system", text: t })); return; }
      const inYaml = (props.mcpYamlServers ?? []).includes(parsed.name);
      if (parsed.kind === "remove") {
        const inStore = removeMcpServer(props.ws, parsed.name);
        const live = await mcp.removeServer(parsed.name);
        if (inYaml) say({ kind: "system", text: `  "${parsed.name}" is defined in taicho.yaml — dropped for this session; edit the file to remove it permanently.` });
        else say({ kind: "system", text: inStore || live ? `  removed "${parsed.name}".` : `  no such MCP server "${parsed.name}".` });
        return;
      }
      if (parsed.kind === "add" && inYaml) { say({ kind: "system", text: `  "${parsed.name}" is already defined in taicho.yaml — edit the file, or add it under a different name.` }); return; }
      // add | login | reconnect — all may connect (and open a browser for OAuth).
      setBusy(true);
      const verb = parsed.kind === "add" ? "connecting" : parsed.kind === "login" ? "signing in to" : "reconnecting";
      setActivity(`${verb} ${parsed.name}…`);
      say({ kind: "system", text: `  ${verb} "${parsed.name}"…` });
      try {
        let st;
        if (parsed.kind === "add") { addMcpServer(props.ws, parsed.name, parsed.spec); st = await mcp.addServer(parsed.name, parsed.spec); }
        else if (parsed.kind === "login") st = await mcp.login(parsed.name);
        else st = await mcp.reconnect(parsed.name);
        formatMcpStatus([st]).forEach((t) => say({ kind: "system", text: t }));
        if (st.status === "connected" && parsed.kind === "add") say({ kind: "system", text: `  add "mcp:${parsed.name}" to an agent's tools to let it use these.` });
      } catch (e) {
        say({ kind: "system", text: `  ${parsed.kind} failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally { setBusy(false); }
      return;
    }
    if (cmd === "teach") {
      const spaceIdx = arg.indexOf(" ");
      const agentId = spaceIdx === -1 ? arg : arg.slice(0, spaceIdx);
      const correction = spaceIdx === -1 ? "" : arg.slice(spaceIdx + 1).trim();
      if (!agentId || !correction) { say({ kind: "system", text: "  usage: /teach <agentId> <correction>" }); return; }
      if (!roster.some((r) => r.id === agentId)) { say({ kind: "system", text: `No agent "${agentId}". Try /agents.` }); return; }
      if (!model) { say({ kind: "system", text: "  no model — set credentials first" }); return; }
      const activeModel = model;
      setBusy(true);
      setActivity(`teaching ${agentId}…`);
      try {
        const draft = await draftPolicy(activeModel, agentId, correction);
        const decision = await requestApproval({ kind: "propose_coaching", draft });
        if (decision.type === "reject") { say({ kind: "system", text: "  discarded" }); }
        else {
          const finalDraft = decision.type === "edit" ? mergeDraft(draft, decision.draft) : draft;
          persistApprovedPolicy(props.ws, finalDraft, agentId);
          say({ kind: "system", text: `  taught ${agentId}: ${finalDraft.do}` });
        }
      } catch (e) {
        say({ kind: "system", text: `  teach error: ${e instanceof Error ? e.message : String(e)}` });
      } finally { setBusy(false); }
      return;
    }
    if (cmd === "kb") {
      const parsed = parseKbCommand(arg);
      if (parsed.kind === "error") { say({ kind: "system", text: `  ${parsed.message}` }); return; }
      if (parsed.kind === "list") {
        const rows = listNodeRows(props.db, parsed.filter);
        if (!rows.length) { say({ kind: "system", text: "  (no matching nodes)" }); return; }
        rows.forEach((r) => say({ kind: "system", text: `  [${r.id}] (${r.kind}) ${r.title} · ${r.source ?? "—"}` }));
        return;
      }
      if (parsed.kind === "forget") {
        const r = forgetNodes(props.ws, props.db, parsed.filter);
        say({ kind: "system", text: `  forgot ${r.removedNodes} node(s), ${r.removedEdges} edge(s)` });
        return;
      }
      if (parsed.kind === "reindex") {
        reindexKnowledge(props.ws, props.db);
        const embedded = props.embed ? await reembedAll(props.db, props.embed) : 0;
        say({ kind: "system", text: `  reindexed from files; re-embedded ${embedded} node(s)` });
        return;
      }
      // sync — drives the librarian per changed doc through the run pipeline
      if (!model) { say({ kind: "system", text: "  /kb sync needs a model — set a key or /login openai." }); return; }
      const activeModel = model;
      setBusy(true);
      setActivity("librarian · syncing…");
      try {
        const ingest = async (path: string, hash: string) => {
          const librarian = await loadAgent(props.ws, LIBRARIAN_ID);
          await executeRun(deps(activeModel), {
            agent: librarian,
            messages: [{ role: "user", content: `Ingest the source document "${path}". Read it with read_source, extract the entities and relationships it asserts, and remember each with typed edges.` }],
            triggeredBy: "user",
            ingestSource: `${path}@${hash}`,
          });
        };
        const s = await syncKnowledgeSources({ ws: props.ws, db: props.db, ingest });
        say({ kind: "system", text: `  sync: ${s.changedDocs} doc(s) ingested, ${s.deletedDocs} removed, ${s.removedNodes} old node(s) cleared` });
      } catch (e) {
        say({ kind: "system", text: `  sync failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally { setBusy(false); }
      return;
    }
    if (cmd === "skills") {
      const parsed = parseSkillCommand(arg);
      if (parsed.kind === "error") { say({ kind: "system", text: `  ${parsed.message}` }); return; }
      if (parsed.kind === "list") {
        const skills = listSkills(props.ws);
        if (!skills.length) { say({ kind: "system", text: "  (no skills)" }); return; }
        skills.forEach((s) => say({ kind: "system", text: `  [${s.id}] ${s.name} (${s.status}) — ${s.description}` }));
        return;
      }
      if (parsed.kind === "show") {
        const all = listSkills(props.ws);
        const s = all.find((x) => x.name === parsed.arg) ?? readSkill(props.ws, parsed.arg);
        if (!s) { say({ kind: "system", text: `  no skill "${parsed.arg}"` }); return; }
        say({ kind: "system", text: `  [${s.id}] ${s.name} (${s.status}) — ${s.description}` });
        s.body.split("\n").forEach((ln) => say({ kind: "system", text: `  ${ln}` }));
        return;
      }
      if (parsed.kind === "remove") {
        say({ kind: "system", text: deleteSkill(props.ws, props.db, parsed.id) ? `  removed ${parsed.id}` : `  no skill "${parsed.id}"` });
        return;
      }
      // reindex
      reindexSkills(props.ws, props.db);
      say({ kind: "system", text: `  reindexed ${listSkills(props.ws).length} skill(s) from files` });
      return;
    }
    if (cmd === "tasks") {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "cancel") {
        const id = parts[1];
        if (!id) { say({ kind: "system", text: "  usage: /tasks cancel <taskId>" }); return; }
        const rec = cancelTaskState(props.ws, props.db, id);
        if (!rec) { say({ kind: "system", text: `  no task "${id}"` }); return; }
        const wasLive = scheduler.cancel(id); // abort if running / drop if queued
        say({ kind: "system", text: `  ⊗ cancelled ${id}${wasLive ? "" : " (was not running)"}` });
        return;
      }
      const rows = listTaskIndex(props.db, { activeOrBackground: true });
      if (!rows.length) { say({ kind: "system", text: "  (no background tasks)" }); return; }
      rows.forEach((r) => say({ kind: "system", text: `  [${r.id}] ${r.status} · ${r.agent ?? "?"} · ${r.goal ?? ""}${r.result_ref ? ` → ${r.result_ref}` : ""}` }));
      return;
    }
    runSlashPure(cmd, arg, {
      roster,
      listTraces: (a?: string) => listTraces(props.ws, a),
      readTrace: (id: string) => readTrace(props.ws, id),
      listPolicies: (a: string) => listPolicies(props.ws, a),
      deletePolicy: (a: string, p: string) => deletePolicy(props.ws, a, p),
    }).forEach(say);
  };

  return (
    <Box flexDirection="column">
      <Text color="cyan">{BANNER}</Text>
      {lines.map((l, i) => {
        if (l.rendered) {
          // Streaming commits each completed markdown block as its own rendered line. Show the dim
          // `from` label only once per reply — i.e. when the previous line isn't a rendered agent
          // line from the same speaker — and add vertical spacing between consecutive same-agent
          // blocks so they read as one reply instead of a repeated-label wall of text.
          const prev = lines[i - 1];
          const sameAgent = !!prev && prev.rendered === true && prev.kind === "agent" && prev.from === l.from;
          return (
            <Box key={i} flexDirection="column" marginTop={sameAgent ? 1 : 0}>
              {!sameAgent && l.from && <Text dimColor>{l.from}</Text>}
              {renderMarkdown(l.text, mdWidth).split("\n").map((ln, j) => (
                <Text key={j}>{ln}</Text>
              ))}
            </Box>
          );
        }
        return (
          <Text key={i} color={l.kind === "user" ? "white" : l.kind === "system" ? "gray" : "green"}>
            {l.kind === "user" ? "> " : l.from ? `${l.from}: ` : ""}{l.text}
          </Text>
        );
      })}
      {pending && (() => {
        if (pending.req.kind === "ask_human") {
          return (
            <QuestionCard
              question={pending.req.question}
              options={pending.req.options}
              keyHandlerRef={cardKeyRef}
              onDecision={(d) => { const r = pending.resolve; cardKeyRef.current = null; setPending(null); r(d); }}
            />
          );
        }
        const view = proposalView(pending.req);
        return (
          <ProposalCard
            title={view.title}
            fields={view.fields}
            keyHandlerRef={cardKeyRef}
            onDecision={(d) => { const r = pending.resolve; cardKeyRef.current = null; setPending(null); r(d); }}
          />
        );
      })()}
      {!pending && (
        <>
          {busy && <RunStatus activity={activity} />}
          <Box>
            <Text color={busy ? "gray" : "cyan"}>{busy ? "❯ " : "> "}</Text>
            <TextInput
              key={inputKey}
              defaultValue={inputSeed}
              placeholder="message root, or / for commands"
              onChange={onInputChange}
              onSubmit={submit}
            />
          </Box>
          {!pending && sugg.length > 0 && (
            <Box flexDirection="column">
              {sugg.map((c, i) => {
                const on = i === Math.min(selected, sugg.length - 1);
                return (
                  <Text key={c.name} color={on ? "cyan" : "gray"}>
                    {`${on ? "›" : " "} /${c.name}${c.usage ? " " + c.usage : ""} — ${c.summary}`}
                  </Text>
                );
              })}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

function initialLines(p: { model: Model | null; roster: RegistryRow[]; authSource: AuthSource }): Line[] {
  if (p.authSource.kind === "none")
    return noCredentialLines().map((text) => ({ kind: "system", text }));
  if (!p.model)
    return [
      { kind: "system", text: "taicho — no API key configured." },
      { kind: "system", text: "Set ANTHROPIC_API_KEY or OPENAI_API_KEY, then relaunch." },
    ];
  if (p.roster.filter((r) => !r.is_root).length === 0)
    return [
      { kind: "system", text: "taicho — your squad is empty (root is ready)." },
      { kind: "system", text: 'Describe your first agent to me (e.g. "I need a researcher that covers geopolitics, with web search"). /agents to list, ESC to quit.' },
    ];
  return [{ kind: "system", text: "taicho — squad ready. Bare messages go to root; @agent to address directly; /runs, /trace, /agents. ESC to quit." }];
}
