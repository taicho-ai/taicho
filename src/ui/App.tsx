import { useState, useRef, useEffect, useCallback } from "react";
import { Box, Text, useInput, useApp, useStdout, type Key } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import type { Database } from "bun:sqlite";
import { ProposalCard, type CardField, type CardKeyHandler } from "./ProposalCard";
import { QuestionCard } from "./QuestionCard";
import { StatusBar } from "./StatusBar";
import { SquadPanes, resolveLayout, type PaneEntry, type PaneFeedMap } from "./SquadPanes";
import { AgentBlock, useBlockSettle, useBlockTicker, tailLines, type AgentBlockData } from "./AgentBlock";
import { OperationView } from "./OperationView";
import { ArtifactViewer } from "./ArtifactViewer";
import { parseInput } from "./input";
import { BANNER } from "./banner";
import { statusReducer, statusList, type StatusMap, type AgentStatus } from "../core/agent-status";
import { gatherConversationArtifacts } from "../core/conversation-artifacts";
import { makeDeps, executeRun, type Model, type ApprovalRequest, type ApprovalDecision } from "../core/run";
import { loadAgent, loadIndex, LIBRARIAN_ID, type RegistryRow } from "../store/roster";
import { listTeams } from "../store/teams";
import { PlanPanel } from "./PlanPanel";
import type { PlanState } from "../schemas/plan";
import { currentPlanId, foldPlan } from "../store/plans";
import { listTraces, readTrace } from "../store/trace";
import { listPolicies, deletePolicy, approvePolicy } from "../store/policy";
import { updateTaskFromTrace, createBackgroundTask, setTaskFields, cancelTaskState, listTaskIndex, readTaskState, mkTaskId, TERMINAL_TASK_STATUS } from "../store/task-state";
import { TaskScheduler } from "../core/tasks";
import { SchedulerRunner, parseScheduleCommand, describeTrigger, formatScheduleLine } from "../core/scheduler";
import { runHeadless, scheduleFireOptions } from "../core/headless";
import { listSchedules, createSchedule, removeSchedule, readSchedule, updateSchedule } from "../store/schedules";
import type { Schedule } from "../schemas/schedule";
import { statSync } from "node:fs";
import type { RunResult, TaskAwaitResult, RunDeps } from "../core/run";
import type { ModelMessage } from "ai";
import type { AuthSource, TaichoConfig } from "../store/config";
import { isStdioServer } from "../store/config";
import type { SpendLedger } from "../store/spend-ledger";
import type { Telemetry } from "../core/otel";
import { formatAuthStatus, noCredentialLines, authExpiredMessage } from "../core/auth/status";
import { runSlash as runSlashPure, type Line, type SlashCommand, suggestCommands, cycleIndex } from "./slash";
import { renderMarkdown } from "./markdown";
import { splitCompletedBlocks } from "./markdown-stream";
import { draftPolicy, persistApprovedPolicy } from "../coaching/teach";
import { mergeDraft } from "../core/draft";
import type { McpManager } from "../core/mcp/manager";
import { addMcpServer, removeMcpServer } from "../store/mcp-store";
import { parseMcpCommand, formatMcpStatus, parseKbCommand, parseSkillCommand, parseArtifactsCommand, tokenize } from "./slash";
import { listArtifacts, readArtifact, readArtifactBody, artifactVersions, gcArtifacts, collectReferencedArtifacts } from "../store/artifacts";
import { annotateArtifact, listAnnotations } from "../store/annotations";
import { artifactHandle } from "../schemas/artifact";
import { syncKnowledgeSources } from "../knowledge/sync";
import { listNodeRows, forgetNodes, reindexKnowledge, reembedAll } from "../store/knowledge";
import { listSkills, readSkill, deleteSkill, reindexSkills } from "../store/skills";
import { getViewMode, setViewMode as persistViewMode, isViewMode, VIEW_MODES, getPlanPanel, setPlanPanel as persistPlanPanel, type ViewMode } from "../store/prefs";

/** One pending approval request in the queue: a stable id (the card's React key — stays fixed while
 *  this request is the head, so queuing a sibling behind it never remounts the visible card), the
 *  request, and the resolver of the tool's blocked promise. Plan 04 makes concurrent approvals
 *  possible (a background run and the foreground run can both block on the captain at once), so
 *  approvals are QUEUED — never a single clobberable slot. */
type PendingApproval = { id: number; req: ApprovalRequest; resolve: (d: ApprovalDecision) => void };

/** Default global background-run ceiling (total in-flight + queued dispatched tasks) when taicho.yaml
 *  doesn't set `tasks.maxBackgroundRuns`. Bounds a model-initiated dispatch chain that resets
 *  per-request budgets on each hop; over-ceiling dispatch is refused, not silently unbounded. */
const DEFAULT_BACKGROUND_RUN_CEILING = 32;

/** How often the REPL evaluates schedules for firing (Plan 04 Phase 6). The tick rate — not any
 *  schedule's interval — is the real floor on how often a scheduled run can fire in a live session,
 *  which naturally bounds a too-eager `--every`. */
const SCHEDULE_TICK_MS = 15_000;

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
      { label: "cwd", value: req.cwd ?? "(workspace)" },
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
  backgroundRunCeiling?: number; // Plan 04: global in-flight+queued dispatch ceiling (default 32)
  authSource: AuthSource;
  buildFromAuth: (s: AuthSource) => BuiltAuth;
  onLogin: () => Promise<AuthSource>;
  onLogout: () => boolean;
  rootThread?: ModelMessage[];
  mcp?: McpManager;
  mcpYamlServers?: string[];
  embed?: (text: string) => Promise<Float32Array>;
  startupNotice?: string;
  spendLedger?: SpendLedger; // Plan 09: squad-wide spend ledger (undefined ⇒ no squad ceilings configured)
  telemetry?: Telemetry;   // Plan 16: OpenTelemetry handle (undefined ⇒ OTLP export off)
  viewMode?: ViewMode;     // Plan 10: initial live-view mode (defaults to the persisted pref / `both`)
  terminalSize?: { columns: number; rows: number }; // Plan 10: authoritative size seam (tests/embeds); else live stdout
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Terminal size is reactive so the bar + panes (and markdown wrap) re-flow on a resize. An explicit
  // prop is authoritative (tests/embeds); otherwise we track the live stdout and its "resize" events.
  const liveSize = () => ({ columns: stdout?.columns ?? 80, rows: (stdout as { rows?: number })?.rows ?? 24 });
  const [termSize, setTermSize] = useState(() => props.terminalSize ?? liveSize());
  useEffect(() => {
    if (props.terminalSize) { setTermSize(props.terminalSize); return; }
    const update = () => setTermSize(liveSize());
    update();
    stdout?.on?.("resize", update);
    return () => { stdout?.off?.("resize", update); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout, props.terminalSize]);
  const mdWidth = termSize.columns - 2; // small margin so wrapping never hugs the edge
  // Plan 10: the live view mode (bar/panes/both), seeded from the persisted pref. /view switches it.
  const [viewMode, setViewMode] = useState<ViewMode>(() => props.viewMode ?? getViewMode(props.ws));
  // Plan 18: the live plan, fed by the phase-less `plan` step event. Null ⇒ the panel collapses to
  // nothing. Seeded from the store so a plan SURVIVES A RESTART visibly — it is on disk, and a plan
  // you cannot see is a plan you cannot steer. (reconcilePlans has already marked in-flight items
  // interrupted by the time this runs.)
  const [plan, setPlan] = useState<PlanState | null>(() => {
    const id = currentPlanId(props.db, "root");
    return id ? foldPlan(props.ws, id) : null;
  });
  const [planPanelOn, setPlanPanelOn] = useState<boolean>(() => getPlanPanel(props.ws));
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
  // A QUEUE of pending approval requests (not a single slot): with Plan 04, a background dispatched
  // run and the foreground run can both block on the captain at the same time. Each request appends
  // here; the card renders the HEAD; answering resolves THAT request's promise and pops to the next.
  // A single `pending` slot would let the second setPending clobber the first's resolver (lost forever).
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const approvalSeq = useRef(0); // monotonic id source so each queued approval has a stable card key
  const pending = pendingApprovals[0] ?? null; // the head request currently shown on the card
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
  if (!schedulerRef.current) schedulerRef.current = new TaskScheduler({ globalCap: props.backgroundRunCeiling ?? DEFAULT_BACKGROUND_RUN_CEILING });
  const scheduler = schedulerRef.current;
  // Plan 04 Phase 6: the schedule/trigger runner. It fires an UNATTENDED run through the headless
  // `executeRun` path (runHeadless — NOT the Ink approval card) whenever a schedule comes due. The
  // fire closure is held in a ref so it always sees the current model/deps (re-armed on /login).
  const fireScheduleRef = useRef<(s: Schedule) => Promise<void>>(async () => {});
  const schedRunnerRef = useRef<SchedulerRunner | null>(null);
  if (!schedRunnerRef.current) schedRunnerRef.current = new SchedulerRunner({
    now: () => Date.now(),
    statMtimeMs: (p) => { try { return statSync(p).mtimeMs; } catch { return null; } },
    fire: (s) => fireScheduleRef.current(s),
    // The runner advances scheduling state (lastRunAt/nextDueAt/runCount) on each fire; persist it as a
    // field patch so cadence survives a restart and never clobbers lastRunId/lastStatus (set by fire).
    persist: (id, patch) => { updateSchedule(props.ws, id, patch); },
  });
  const schedRunner = schedRunnerRef.current;
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
  const streamRunIdRef = useRef<string | undefined>(undefined); // Plan 13: track which run is streaming (so flushStream can gate on root)
  // Plan 10 live status: statusRef is the authoritative per-run status map (dodges stale closures in
  // the rapid onStep stream); `statuses` is the rendered snapshot.
  const statusRef = useRef<StatusMap>(new Map());
  const [statuses, setStatuses] = useState<AgentStatus[]>([]);
  const clearStatuses = () => { statusRef.current = new Map(); setStatuses([]); };
  // Plan 10 Phase 4: per-run activity feed for the split-pane view (recent tool lines + the live
  // streamed/final text), built off the SAME event stream the status map is. Reset at each new turn.
  const PANE_FEED_LINES = 4;
  const paneFeedRef = useRef<Map<string, PaneEntry>>(new Map());
  const [paneFeed, setPaneFeed] = useState<PaneFeedMap>(new Map());
  const clearPaneFeed = () => { paneFeedRef.current = new Map(); setPaneFeed(new Map()); };
  const bumpPaneFeed = (runId: string, mut: (e: PaneEntry) => PaneEntry) => {
    const cur = paneFeedRef.current.get(runId) ?? { lines: [] };
    const next = new Map(paneFeedRef.current);
    next.set(runId, mut(cur));
    paneFeedRef.current = next;
    setPaneFeed(next);
  };
  // Plan 13 (corrected): per-run block data for the consistent agent blocks. Each agent (root and
  // sub-agents) is rendered as a single block: header + fixed 2-line body. The block IS the record —
  // the block you watched live is the exact block that settles into scrollback. Built off the SAME
  // `delta` events the status map reads — no new engine plumbing. Display-only: it never touches
  // transcript/ledger/replay (the full text is still recorded on disk — this bounds the SCREEN).
  const BLOCK_KEEP_LINES = 5; // keep a few lines for the rolling tail inside the block body
  const blockFeedRef = useRef<Map<string, { lines: string; agent: string; parentRunId?: string; depth: number }>>(new Map());
  const [blockFeed, setBlockFeed] = useState<Map<string, { lines: string; agent: string; parentRunId?: string; depth: number }>>(new Map());
  const clearBlockFeed = () => { blockFeedRef.current = new Map(); setBlockFeed(new Map()); };
  const bumpBlockFeed = (runId: string, delta: string, agent: string, parentRunId?: string, depth = 0) => {
    const cur = blockFeedRef.current.get(runId);
    const merged = (cur?.lines ?? "") + delta;
    // Trim to the last BLOCK_KEEP_LINES lines so the accumulator stays bounded
    const segs = merged.split("\n");
    const trimmed = segs.length > BLOCK_KEEP_LINES ? segs.slice(-BLOCK_KEEP_LINES).join("\n") : merged;
    const next = new Map(blockFeedRef.current);
    next.set(runId, { lines: trimmed, agent, parentRunId, depth });
    blockFeedRef.current = next;
    setBlockFeed(next);
  };

  // Plan 13: focus state for block navigation. shift+tab enters focus mode, ↑↓ move, ⏎ opens, esc leaves.
  const [focusMode, setFocusMode] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [operationRunId, setOperationRunId] = useState<string | null>(null);

  // Plan 15: completion action bar + artifact viewer. When a user turn completes with artifacts, show
  // the action bar; ⏎ on "View artifacts" opens the viewer. The viewer is cardKeyRef-owned.
  const [completionArtifacts, setCompletionArtifacts] = useState<import("../schemas/artifact").Artifact[] | null>(null);
  const [artifactViewerOpen, setArtifactViewerOpen] = useState(false);
  const [actionBarFocus, setActionBarFocus] = useState(0); // 0 = View artifacts, 1 = Continue chatting

  // Plan 13 (corrected): compute block data from the block feed at the top level (hooks must not be
  // called inside conditionals or IIFEs). The consistent block view shows every AGENT (sub-agents,
  // delegated work) as a fixed-height block. Root's direct reply still uses the scrollback (the
  // conversational reply channel); blocks are for the squad, not the root's own answer.
  const now = Date.now();
  const liveBlocks: AgentBlockData[] = [];
  for (const [runId, data] of blockFeed) {
    // Skip root's direct reply — it goes to scrollback, not blocks
    if (runId === foregroundRootRef.current) continue;
    const status = statuses.find((s) => s.runId === runId);
    const variant = status ? "live" : "done";
    liveBlocks.push({
      runId,
      agent: data.agent,
      state: status?.state ?? "idle",
      since: status?.since ?? now,
      waiting: status?.waiting ?? false,
      lines: tailLines(data.lines, 3),
      variant,
      depth: data.depth,
    });
  }
  const { allBlocks } = useBlockSettle(liveBlocks);
  useBlockTicker(allBlocks.length > 0);

  // The live suggester: which commands match what's being typed (empty once past the command name).
  const sugg = suggestCommands(input);

  useInput((input, key) => {
    // While a card is up, this boot-registered useInput is the only listener guaranteed to be wired
    // when the captain's first keystroke arrives, so we forward it to the active card. (A card-owned
    // useInput registers a beat after its render commits and would drop that first key — the hang
    // we're fixing.) The card publishes its handler to cardKeyRef during render.
    if (pending || operationRunId || artifactViewerOpen) { cardKeyRef.current?.(input, key); return; } // a card OR the operation view OR artifact viewer owns the keyboard
    // Plan 15: completion action bar navigation. ←/→ move, ⏎ select, esc/type → dismiss.
    if (completionArtifacts && completionArtifacts.length > 0) {
      if (key.escape) { setCompletionArtifacts(null); setActionBarFocus(0); return; }
      if (key.leftArrow || key.rightArrow) { setActionBarFocus((f) => f === 0 ? 1 : 0); return; }
      if (key.return) {
        if (actionBarFocus === 0) { setArtifactViewerOpen(true); }
        else { setCompletionArtifacts(null); setActionBarFocus(0); }
        return;
      }
      // Any other key dismisses the bar and returns to chat
      setCompletionArtifacts(null); setActionBarFocus(0); return;
    }
    // Plan 13: focus mode navigation. shift+tab enters, esc leaves, ↑↓ move, ⏎ opens operation view.
    if (focusMode) {
      if (key.escape) { setFocusMode(false); setFocusIndex(0); return; }
      if (key.upArrow) { setFocusIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setFocusIndex((i) => Math.min((blockFeed.size || 1) - 1, i + 1)); return; }
      if (key.return) {
        const runIds = [...blockFeed.keys()];
        const targetRunId = runIds[focusIndex];
        if (targetRunId) setOperationRunId(targetRunId);
        return;
      }
      return; // consume other keys while in focus mode
    }
    if (key.shift && key.tab) { setFocusMode(true); return; } // enter focus mode
    if (key.escape) { if (busy) { aborter.current?.abort(); say({ kind: "system", text: "  ⊗ cancelling…" }); } else { void (async () => { await props.mcp?.closeAll(); await props.telemetry?.shutdown(); exit(); })(); } return; }
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

  // Plan 04 Phase 6: fire a due schedule through the headless `executeRun` path (runHeadless, NOT the
  // Ink approval card). Rebuilt every render so it closes over the CURRENT model/resolver (re-armed on
  // /login). A scheduled run is UNATTENDED: its approve mode (default `reject`) drives an auto-reject
  // approval channel — no captain, so no unsupervised privileged exec. Breadcrumbs route to scrollback.
  fireScheduleRef.current = async (s: Schedule) => {
    const activeModel = model;
    if (!activeModel) { say({ kind: "system", text: `  ⏰ schedule ${s.id} skipped — no model configured` }); return; }
    say({ kind: "system", text: `  ⏰ schedule ${s.id} firing → ${s.agent}: ${s.goal} (approvals: ${s.approve})` });
    try {
      const res = await runHeadless(
        { ws: props.ws, db: props.db, model: activeModel, resolveModel, priceUsd, configDefaults: props.configDefaults, mcp: props.mcp, embed: props.embed, spendLedger: props.spendLedger, telemetry: props.telemetry },
        // scheduleFireOptions stamps triggeredBy: schedule:<id> — keeps this UNATTENDED fire OUT of the
        // target agent's conversation ledger + boot-replay cache (it still gets full run evidence).
        // Otherwise every cron/interval/watch fire appended a user+assistant pair and replayed as prior
        // "conversation" on the next launch. Shared with index.tsx so the wiring can't drift.
        { ...scheduleFireOptions(s), out: (l) => say({ kind: "system", text: `  ${l}` }) },
      );
      // Record the outcome of this fire (lastRunId/lastStatus). The runner already advanced cadence.
      updateSchedule(props.ws, s.id, { lastRunId: res.runId, lastStatus: res.outcome ?? (res.ok ? "completed" : "failed") });
      say({ kind: "system", text: `  ${res.ok ? "✓" : "⚠"} schedule ${s.id} ${res.outcome ?? (res.ok ? "done" : "failed")}${res.runId ? ` — run ${res.runId}` : ""} — /schedules` });
    } catch (e) {
      updateSchedule(props.ws, s.id, { lastStatus: "failed" });
      say({ kind: "system", text: `  ⚠ schedule ${s.id} failed — ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // Arm persisted schedules on boot (reconcile — they survive a restart) and tick the runner on a
  // real interval. The timer is unref'd so it never keeps the process (or a test's event loop) alive.
  useEffect(() => {
    for (const s of listSchedules(props.ws)) schedRunner.add(s);
    const t = setInterval(() => { try { schedRunner.tick(); } catch { /* a bad schedule never wedges the REPL */ } }, SCHEDULE_TICK_MS);
    (t as { unref?: () => void }).unref?.();
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Commit the in-progress streamed text (if any) as a finalized agent line — called when a tool
  // interrupts the stream and at run end. No-op when nothing has streamed.
  // Plan 13 (corrected): only commit root's direct reply AND foreground @agent turns to scrollback;
  // background dispatched runs stay in blocks.
  const flushStream = () => {
    if (streamRef.current) {
      const runEntry = streamRunIdRef.current ? activeRuns.current.get(streamRunIdRef.current) : undefined;
      const isForegroundRun = !runEntry || runEntry.triggeredBy === "user";
      const isRootReply = streamFromRef.current === "root" || isForegroundRun;
      if (isRootReply) {
        const { blocks, tail } = splitCompletedBlocks(streamRef.current);
        if (blocks.length > streamBlocksRef.current) for (const b of blocks.slice(streamBlocksRef.current)) say({ kind: "agent", from: streamFromRef.current, text: b, rendered: true });
        if (tail.trim()) say({ kind: "agent", from: streamFromRef.current, text: tail, rendered: true });
      }
    }
    streamRef.current = ""; streamBlocksRef.current = 0; streamRunIdRef.current = undefined;
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

  // Enqueue an approval request and hand back a promise that resolves ONLY when the captain answers
  // THIS request. Concurrent requests queue behind the head; each keeps its own resolver, so none is
  // clobbered. `answerHead` (below) resolves the head's promise and pops it off.
  const requestApproval = (req: ApprovalRequest) =>
    new Promise<ApprovalDecision>((resolve) => {
      const id = ++approvalSeq.current;
      setPendingApprovals((q) => [...q, { id, req, resolve }]);
    });

  // Answer the head approval: resolve its promise, drop it, and let the next queued request surface.
  // cardKeyRef is cleared so the next card re-registers its own key handler on mount.
  const answerHead = (d: ApprovalDecision) => {
    cardKeyRef.current = null;
    setPendingApprovals((q) => {
      const [head, ...rest] = q;
      head?.resolve(d);
      return rest;
    });
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Race a promise against a timeout that ALWAYS clears its timer — a bare Promise.race([p, sleep(ms)])
  // leaves the losing setTimeout ref'd, keeping the event loop alive (and delaying Esc-quit) for up to
  // `ms`. Returns true if `p` settled first, false on timeout.
  const raceWithTimeout = (p: Promise<unknown>, ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); });
    return Promise.race([p.then(() => true), timeout]).finally(() => { if (timer) clearTimeout(timer); });
  };
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
    // Global ceiling (fix): each detached dispatch is an independent request for BUDGETS (depth +
    // runCounter reset), so per-request caps can't bound a dispatch CHAIN. Refuse over-ceiling BEFORE
    // creating the task record so a runaway fan-out is bounded and no orphan record is left behind.
    if (scheduler.atCapacity()) {
      const msg = `background run ceiling reached (${scheduler.inFlight()}/${scheduler.ceiling} in flight + queued) — await or cancel a task before dispatching more`;
      say({ kind: "system", text: `  ⊘ dispatch refused: ${msg}` });
      return { error: msg };
    }
    const taskId = mkTaskId();
    createBackgroundTask(props.ws, props.db, { taskId, agent: o.agent.id, goal: o.goal });
    say({ kind: "system", text: `  ⇢ dispatched ${taskId} → ${o.agent.id} (background)` });
    const start = () => {
      const controller = new AbortController();
      setTaskFields(props.ws, props.db, taskId, { status: "running", stepStatus: "running" });
      const childDeps = deps(activeModel, { signal: controller.signal });
      const messages: ModelMessage[] = [{ role: "user", content: o.context ? `${o.goal}\n\nContext: ${o.context}` : o.goal }];
      const brief = { from: o.parentAgentId, goal: o.goal, context: o.context, criteria: o.criteria, fromRun: o.parentRunId };
      // ancestry threads the dispatching run's chain + the dispatching agent so the detached run's
      // delegationGuard cycle check (ancestry.includes(to)) spans dispatch hops — an A→B→A ping-pong
      // is refused. Budgets (depth/runCounter) stay reset: a dispatch is still an independent request.
      const promise = executeRun(childDeps, { agent: o.agent, messages, brief, inputArtifacts: o.inputArtifacts, triggeredBy: taskId, ancestry: [...o.parentAncestry, o.parentAgentId] })
        .then((res) => { settleTask(taskId, o.agent.id, res); return res; }, (e) => { failTask(taskId, o.agent.id, e); });
      return { controller, promise };
    };
    scheduler.submit({ taskId, agentId: o.agent.id, cap: o.agent.budgets.maxConcurrentRuns, start });
    return { taskId };
  };

  // Block until a background task settles (bounded). Awaits the scheduler promise when it's running,
  // else polls the persisted record (covers already-settled and still-queued tasks). awaiterAgentId
  // (stamped by run.ts) is the agent whose run is calling await_task — used to detect a self-block.
  const awaitTask = async (taskId: string, timeoutMs = 120_000, awaiterAgentId?: string): Promise<TaskAwaitResult> => {
    const existing = readTaskState(props.ws, taskId);
    if (!existing) return { status: "unknown", error: `no task "${taskId}"` };
    if (TERMINAL_TASK_STATUS.has(existing.status)) return taskSummary(taskId);
    const running = scheduler.awaitRunning(taskId);
    if (running) {
      await raceWithTimeout(running, timeoutMs); // clears its timer on either outcome (no leaked timeout)
    } else {
      // Not running — it's QUEUED (a task only sits queued because its agent is at its concurrency
      // cap). If the awaiting run is itself a run of that SAME agent, it holds one of those slots and
      // can never free it while parked here: awaiting would deadlock until the timeout. Fail fast.
      if (existing.status === "queued" && awaiterAgentId && existing.agent === awaiterAgentId) {
        return { status: "unavailable", error: `await_task would deadlock: ${taskId} is queued behind ${awaiterAgentId}'s own concurrency slot (this run holds it). Raise maxConcurrentRuns, or await it after this run frees its slot.` };
      }
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const t = readTaskState(props.ws, taskId);
        if (t && TERMINAL_TASK_STATUS.has(t.status)) break;
        await sleep(50);
      }
    }
    return taskSummary(taskId);
  };

  const deps = (model: Model, over?: { signal?: AbortSignal }) => makeDeps({
    ws: props.ws, db: props.db, model,
    requestApproval,
    onStep: (ev) => {
      const { phase, tool, agent, delta, note, argsPreview } = ev;
      // Plan 18: a plan snapshot. Phase-less by construction, so statusReducer never sees it and the live
      // status map cannot be corrupted by a "plan" AgentState that does not exist. Handled exactly the
      // way `note` is: an early return, before any phase branch.
      if (ev.plan) { setPlan(ev.plan); return; }
      // Plan 10: fold every phase-tagged event into the live status map (drives the StatusBar) and
      // the per-run pane feed (drives SquadPanes). Both read the one event stream; nothing invented.
      if (phase && ev.runId) {
        const now = Date.now();
        statusRef.current = statusReducer(statusRef.current, ev, now);
        setStatuses(statusList(statusRef.current));
        // The pane feed carries tool activity only (the streamed/final reply stays in the scrollback
        // reply channel — duplicating it in the pane raced that channel; see SquadPanes PaneEntry).
        if (phase === "tool_start" && tool)
          bumpPaneFeed(ev.runId, (e) => ({ lines: [...e.lines, `→ ${tool}${argsPreview ? ` ${argsPreview}` : ""}`].slice(-PANE_FEED_LINES) }));
        // Plan 13 (corrected): accumulate block data for ALL runs. The consistent block view shows
        // every agent (root and sub-agents) as a fixed-height block. The full text is still recorded
        // on disk — this bounds the SCREEN, not the record.
        if (phase === "delta") {
          const d = ev.text ?? delta ?? "";
          if (d) {
            // Determine depth and parent for nesting (root = 0, children = 1+)
            const isRoot = ev.runId === foregroundRootRef.current;
            const depth = isRoot ? 0 : 1; // simplified: root at 0, all children at 1
            bumpBlockFeed(ev.runId, d, agent, undefined, depth);
          }
        }
      }
      if (delta) {
        // Plan 13 (corrected): ONLY accumulate root's direct reply AND foreground @agent turns in
        // streamRef (for scrollback). Background dispatched runs only go to the block feed — the
        // block is their only on-screen presence. Check by: (1) agent is root, OR (2) run is
        // foreground (triggeredBy === "user"), OR (3) no runId (legacy path).
        const runEntry = ev.runId ? activeRuns.current.get(ev.runId) : undefined;
        const isForegroundRun = !runEntry || runEntry.triggeredBy === "user";
        const isRootReply = agent === "root" || isForegroundRun;
        if (isRootReply) {
          streamedRef.current = true; streamFromRef.current = agent; streamRef.current += delta;
          streamRunIdRef.current = ev.runId;
          const { blocks } = splitCompletedBlocks(streamRef.current);
          if (blocks.length > streamBlocksRef.current) {
            for (const b of blocks.slice(streamBlocksRef.current)) say({ kind: "agent", from: agent, text: b, rendered: true });
            streamBlocksRef.current = blocks.length;
          }
        }
        return;
      }
      // A run-level breadcrumb (e.g. a delegation verification verdict) — surface it to the captain.
      if (note) { flushStream(); say({ kind: "system", text: `  ${note}` }); return; }
      // The scrollback breadcrumb now fires at real tool_start time (the status bar carries the live
      // role; the ↳ line stays as the record). argsPreview is redacted + capped upstream.
      // Plan 13 (corrected): suppress the breadcrumb for delegate_task — the consistent block
      // replaces it (the block is the delegation's only on-screen presence, not both).
      if (phase === "tool_start" && tool && tool !== "delegate_task") {
        flushStream();
        setActivity(`${agent} → ${tool}()`);
        say({ kind: "system", text: `  ↳ ${agent} → ${tool}()${argsPreview ? " " + argsPreview : ""}` });
      }
    },
    // Per-run steer routing (Phase 4): a run polls only ITS own queued steers.
    pollSteerFor: ({ runId }) => steerRoutes.current.get(runId)?.shift() ?? null,
    signal: over?.signal ?? aborter.current?.signal,
    priceUsd,
    resolveModel,
    configDefaults: props.configDefaults,
    mcp: props.mcp,
    embed: props.embed,
    spendLedger: props.spendLedger, // Plan 09: squad-wide ceilings enforced in the loop, shared by all runs
    telemetry: props.telemetry,   // Plan 16: OpenTelemetry export, shared by all runs this session
    dispatch,
    awaitTask,
    // Live-run bookkeeping only. The per-turn AUDIT (ledger user turn + task open) now lives in the
    // engine seam (recordUserTurn in executeRun, guarded by triggeredBy === "user") — Plan 01 Ph5.
    onRunStart: ({ runId, agent, triggeredBy }) => {
      activeRuns.current.set(runId, { agent, triggeredBy });
      if (triggeredBy === "user" && !foregroundRootRef.current) foregroundRootRef.current = runId;
    },
    onRunEnd: ({ runId }) => {
      activeRuns.current.delete(runId);
      steerRoutes.current.delete(runId);
      if (foregroundRootRef.current === runId) foregroundRootRef.current = null;
    },
  });

  // Is a run part of the FOREGROUND cascade (the watched turn), vs a background dispatched run? Walk
  // its triggeredBy chain: a foreground root is triggeredBy "user" (and is foregroundRootRef); a
  // background root is triggeredBy a `task_*` id. A descendant inherits its root's nature via the
  // chain of parent runIds still in activeRuns.
  const isForegroundRun = (runId: string): boolean => {
    let cur: string | undefined = runId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (cur === foregroundRootRef.current) return true;
      const entry = activeRuns.current.get(cur);
      if (!entry) return false;                      // parent already settled — can't confirm foreground
      if (entry.triggeredBy === "user") return true; // reached a foreground root
      if (entry.triggeredBy.startsWith("task_")) return false; // reached a background dispatch root
      cur = entry.triggeredBy;                        // walk up via the parent runId
    }
    return false;
  };

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
      // The same agent can be live in TWO runs (a foreground cascade AND a background dispatch). Prefer
      // the foreground-cascade run so an @agent correction lands on the turn the captain is watching,
      // not a random background run picked by Map insertion order. Fall back to the first match.
      const matches = [...activeRuns.current.entries()].filter(([, v]) => v.agent === parsed.to);
      if (!matches.length) { say({ kind: "system", text: `  no active run for @${parsed.to} to steer` }); return; }
      const hit = matches.find(([id]) => isForegroundRun(id)) ?? matches[0];
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
    streamRef.current = ""; streamFromRef.current = ""; streamedRef.current = false; streamBlocksRef.current = 0; streamRunIdRef.current = undefined;
    clearStatuses();
    clearPaneFeed();
    clearBlockFeed();
    try {
      if (parsed.kind === "chat") {
        // In-memory conversation for THIS session. The durable audit (ledger + task) and the derived
        // boot-replay cache (thread.jsonl, compacted per Plan 05 Ph3) are written by the engine seam.
        thread.current.push({ role: "user", content: parsed.text });
        const root = await loadAgent(props.ws, "root");
        const res = await executeRun(deps(activeModel), { agent: root, messages: [...thread.current], triggeredBy: "user" });
        flushStream(); // commit the final streamed turn; only fall back to res.text if nothing streamed
        if (!streamedRef.current) say({ kind: "agent", from: "root", text: res.text, rendered: true });
        if (res.trace.outcome === "completed") {
          thread.current.push({ role: "assistant", content: res.text });
          // Plan 15: gather artifacts from the conversation's run tree and show the completion action bar
          const artifacts = gatherConversationArtifacts(props.ws, res.runId);
          if (artifacts.length > 0) setCompletionArtifacts(artifacts);
        } else {
          thread.current.pop(); // drop the user turn so failures don't accumulate as context
          maybeSayAuthExpired(res.text);
          say({ kind: "system", text: `  run: ${res.runId} (${res.trace.outcome}, ${res.trace.tokens} tok, ${res.trace.costUsd == null ? "subscription" : "$" + res.trace.costUsd.toFixed(4)})` });
        }
        setRoster(loadIndex(props.db)); // create_agent may have grown the squad
      } else {
        const target = await loadAgent(props.ws, parsed.to).catch(() => null);
        if (!target) { say({ kind: "system", text: `No agent "${parsed.to}". Try /agents, or describe one to root.` }); return; }
        const res = await executeRun(deps(activeModel), { agent: target, messages: [{ role: "user", content: parsed.text }], triggeredBy: "user" });
        flushStream();
        if (!streamedRef.current) say({ kind: "agent", from: target.id, text: res.text, rendered: true });
        if (res.trace.outcome === "failed") maybeSayAuthExpired(res.text);
        say({ kind: "system", text: `  run: ${res.runId} (${res.trace.outcome}, ${res.trace.tokens} tok, ${res.trace.costUsd == null ? "subscription" : "$" + res.trace.costUsd.toFixed(4)}, ${res.trace.artifacts.length} artifact(s))` });
        // Plan 15: gather artifacts from the conversation's run tree and show the completion action bar
        const artifacts = gatherConversationArtifacts(props.ws, res.runId);
        if (artifacts.length > 0) setCompletionArtifacts(artifacts);
      }
    } catch (e) {
      // A pre-run failure that throws rather than returning a failed RunResult — e.g. resolveModel's
      // explicit-model guard for a misconfigured OpenRouter agent. Surface it instead of crashing Ink.
      say({ kind: "system", text: `  ${e instanceof Error ? e.message : String(e)}` });
    } finally { setBusy(false); clearStatuses(); clearBlockFeed(); }
  };

  const runSlash = async (cmd: string, arg: string) => {
    if (cmd === "view") {
      const mode = arg.trim().toLowerCase();
      if (!mode) { say({ kind: "system", text: `  live view: ${viewMode} (usage: /view ${VIEW_MODES.join("|")})` }); return; }
      if (!isViewMode(mode)) { say({ kind: "system", text: `  unknown view "${mode}" — try /view ${VIEW_MODES.join("|")}` }); return; }
      setViewMode(mode);
      persistViewMode(props.ws, mode);
      say({ kind: "system", text: `  live view → ${mode}` });
      return;
    }
    if (cmd === "plan") {
      const a = arg.trim().toLowerCase();
      if (a && a !== "on" && a !== "off") { say({ kind: "system", text: '  usage: /plan [on|off]' }); return; }
      const next = a ? a === "on" : !planPanelOn;
      setPlanPanelOn(next);
      persistPlanPanel(props.ws, next);
      const summary = plan ? ` (${plan.handle}: ${plan.counts.done}/${plan.counts.total} done)` : " (no live plan)";
      say({ kind: "system", text: `  plan panel → ${next ? "on" : "off"}${next ? summary : ""}` });
      return;
    }
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
        // Plan 07: route the distiller through the Codex-safe streaming shape when signed in with a
        // ChatGPT subscription (a bare non-streaming call 400s). Plan 09: meter it against the squad
        // ceiling (real model call, but no run trace ⇒ not surfaced in /costs — see coaching/teach.ts).
        const draft = await draftPolicy(activeModel, agentId, correction, {
          codexBackend: authSource.kind === "oauth-openai-codex",
          spendLedger: props.spendLedger,
          priceUsd,
        });
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
    if (cmd === "artifacts") {
      const parsed = parseArtifactsCommand(arg);
      if (parsed.kind === "error") { say({ kind: "system", text: `  ${parsed.message}` }); return; }
      if (parsed.kind === "list") {
        const all = listArtifacts(props.ws, parsed.q ? { q: parsed.q } : {});
        if (!all.length) { say({ kind: "system", text: "  (no artifacts)" }); return; }
        all.forEach((a) => {
          const open = listAnnotations(props.ws, artifactHandle(a), { status: "open" }).length;
          say({ kind: "system", text: `  [${artifactHandle(a)}] ${a.title} (${a.type}, ${a.role}) · ${a.producer}${open ? ` · ${open} open feedback` : ""}${a.summary ? ` — ${a.summary}` : ""}` });
        });
        return;
      }
      if (parsed.kind === "show") {
        const a = readArtifact(props.ws, parsed.handle);
        if (!a) { say({ kind: "system", text: `  no artifact "${parsed.handle}"` }); return; }
        say({ kind: "system", text: `  [${artifactHandle(a)}] ${a.title}` });
        say({ kind: "system", text: `  type=${a.type} role=${a.role} producer=${a.producer} run=${a.runId} versions=[${artifactVersions(props.ws, a.id).join(", ")}]` });
        if (a.parents.length) say({ kind: "system", text: `  parents: ${a.parents.join(", ")}` });
        if (a.summary) say({ kind: "system", text: `  summary: ${a.summary}` });
        // Render the artifact BODY (not just the envelope) so `/artifacts show` actually shows the
        // content — the in-terminal complement to the full-screen viewer. readArtifactBody returns
        // null for external (MCP-fronted) refs, so those just show the envelope + locator.
        if (a.location.kind === "external") {
          say({ kind: "system", text: `  external: ${a.location.uri}` });
        } else {
          const body = readArtifactBody(props.ws, artifactHandle(a));
          if (body && body.length) {
            say({ kind: "system", text: "  ───" });
            renderMarkdown(body.toString("utf8"), mdWidth).split("\n").forEach((ln) => say({ kind: "system", text: `  ${ln}` }));
          }
        }
        const anns = listAnnotations(props.ws, artifactHandle(a));
        if (!anns.length) say({ kind: "system", text: "  (no annotations)" });
        else anns.forEach((an) => say({ kind: "system", text: `  ✎ [${an.id}] (${an.status}) ${an.kind} · ${an.author}: ${an.body}${an.verdict ? ` [${an.verdict.pass ? "pass" : "FAIL"}]` : ""}` }));
        return;
      }
      if (parsed.kind === "annotate") {
        try {
          const an = annotateArtifact(props.ws, { target: parsed.handle, author: "human", body: parsed.body, kind: "feedback" });
          say({ kind: "system", text: `  ✎ annotated ${an.target} (${an.id}) — hand it to an agent to revise; the open feedback rides along.` });
        } catch (e) { say({ kind: "system", text: `  ${e instanceof Error ? e.message : String(e)}` }); }
        return;
      }
      if (parsed.kind === "approve") {
        try {
          const an = annotateArtifact(props.ws, { target: parsed.handle, author: "human", body: "approved by captain", kind: "approval" });
          say({ kind: "system", text: `  ✓ approved ${an.target}` });
        } catch (e) { say({ kind: "system", text: `  ${e instanceof Error ? e.message : String(e)}` }); }
        return;
      }
      // gc — protect a version by what CONSUMES it, never by its own producing run's record. Every
      // version an agent saves lands in that run's `trace.artifacts`, so folding that in would pin
      // every version ever produced and shadow keep-latest-N (nothing would ever be archived). Draw
      // the protected set from the hand-off graph (inputArtifacts/outputArtifacts) + task resultRefs;
      // annotations + parent-closure are honored inside gcArtifacts.
      const referenced = collectReferencedArtifacts({
        traces: listTraces(props.ws),
        taskResultRefs: listTaskIndex(props.db).map((t) => t.result_ref),
      });
      const r = gcArtifacts(props.ws, { referenced });
      say({ kind: "system", text: `  gc: archived ${r.archived.length} version(s), kept ${r.kept}${r.archived.length ? ` — ${r.archived.join(", ")}` : " (nothing to collect)"}` });
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
    if (cmd === "schedules") {
      const parsed = parseScheduleCommand(tokenize(arg));
      if (parsed.kind === "error") { say({ kind: "system", text: `  ${parsed.message}` }); return; }
      if (parsed.kind === "list") {
        const all = listSchedules(props.ws);
        if (!all.length) { say({ kind: "system", text: "  (no schedules — /schedules add <goal> --every 1h)" }); return; }
        all.forEach((s) => say({ kind: "system", text: formatScheduleLine(s) }));
        return;
      }
      if (parsed.kind === "add") {
        try {
          const s = createSchedule(props.ws, parsed.spec);
          schedRunner.add(s); // arm it live so it can fire this session
          say({ kind: "system", text: `  ⏰ added schedule ${s.id} → ${s.agent}: ${s.goal} (${describeTrigger(s.trigger)}, approvals: ${s.approve})` });
        } catch (e) { say({ kind: "system", text: `  could not add schedule — ${e instanceof Error ? e.message : String(e)}` }); }
        return;
      }
      if (parsed.kind === "remove") {
        const ok = removeSchedule(props.ws, parsed.id);
        schedRunner.remove(parsed.id);
        say({ kind: "system", text: ok ? `  removed schedule ${parsed.id}` : `  no schedule "${parsed.id}"` });
        return;
      }
      // run — fire once now through the runner's inFlight-guarded fireNow (NOT the raw fire closure),
      // so a manual run SHARES the cadence guard and can't run concurrently with a cadence fire of the
      // same schedule (the documented "≤1 in-flight per schedule"). fireNow returns false when the id
      // isn't armed in this session or is already running — report which.
      if (!readSchedule(props.ws, parsed.id)) { say({ kind: "system", text: `  no schedule "${parsed.id}"` }); return; }
      if (!schedRunner.fireNow(parsed.id)) {
        const why = schedRunner.has(parsed.id) ? "already running" : "not armed in this session";
        say({ kind: "system", text: `  schedule ${parsed.id} — ${why}` });
      }
      return;
    }
    runSlashPure(cmd, arg, {
      // Plan 19: read BOTH fresh. `teams` are captain-owned files and `roster` is the derived index of
      // agent.md, so an edit + reindex shows up without a restart — and, crucially, /teams' member
      // counts cannot disagree with the team list they are counted against.
      roster: loadIndex(props.db),
      teams: listTeams(props.ws).map((t) => ({ id: t.id, charter: t.charter, lead: t.lead })),
      listTraces: (a?: string) => listTraces(props.ws, a),
      listPolicies: (a: string) => listPolicies(props.ws, a),
      deletePolicy: (a: string, p: string) => deletePolicy(props.ws, a, p),
      // A proposed note's id is all the captain has (from the ⚑ message); find its owning agent by id.
      approvePolicy: (polId: string) => {
        for (const r of roster) { const n = approvePolicy(props.ws, r.id, polId); if (n) return n; }
        return null;
      },
    }).forEach(say);
  };

  // Plan 10: which live surfaces render for the current mode + terminal size (bar-only when small).
  const layout = resolveLayout(viewMode, termSize.columns, termSize.rows);

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
        // key = the head request's stable id: a fresh card (with its own reset useState) mounts per
        // request, but the visible head never remounts just because another request queued behind it.
        if (pending.req.kind === "ask_human") {
          return (
            <QuestionCard
              key={pending.id}
              question={pending.req.question}
              options={pending.req.options}
              keyHandlerRef={cardKeyRef}
              onDecision={answerHead}
            />
          );
        }
        const view = proposalView(pending.req);
        return (
          <ProposalCard
            key={pending.id}
            title={view.title}
            fields={view.fields}
            keyHandlerRef={cardKeyRef}
            onDecision={answerHead}
          />
        );
      })()}
      {/* Plan 10 Phase 4: split panes (one per live agent) sit above the spinner + bar. The mode
          (bar/panes/both) and terminal size decide what shows; too small ⇒ degrade to bar-only. */}
      {!operationRunId && layout.showPanes && (
        <SquadPanes statuses={statuses} feed={paneFeed} columns={termSize.columns} rows={termSize.rows} />
      )}
      {/* Plan 13 (corrected): consistent agent blocks — the default squad view. Every agent (root and
          sub-agents) is rendered as a single block: header + fixed 2-line body. The block IS the record. */}
      {!operationRunId && allBlocks.length > 0 && (() => {
        const blockWidth = Math.min(termSize.columns - 4, 96);
        return (
          <Box flexDirection="column">
            {allBlocks.map((b, i) => (
              <AgentBlock
                key={b.runId}
                block={b}
                focused={focusMode && i === focusIndex}
                width={blockWidth}
                now={now}
              />
            ))}
            {focusMode && <Text dimColor>  ↑↓ navigate · ⏎ open · esc to close</Text>}
          </Box>
        );
      })()}
      {/* Plan 13: operation view — drill-in to see the full output of a focused block. */}
      {operationRunId && (
        <OperationView
          ws={props.ws}
          runId={operationRunId}
          width={termSize.columns}
          keyHandlerRef={cardKeyRef}
          onClose={() => { cardKeyRef.current = null; setOperationRunId(null); }}
        />
      )}
      {/* Plan 15: completion action bar — shown when a user turn produces artifacts. */}
      {!pending && !operationRunId && !artifactViewerOpen && completionArtifacts && completionArtifacts.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={actionBarFocus === 0 ? "cyan" : "gray"} bold={actionBarFocus === 0}>
              {actionBarFocus === 0 ? "▸ " : "  "}View artifacts ({completionArtifacts.length})
            </Text>
            <Text dimColor>     </Text>
            <Text color={actionBarFocus === 1 ? "cyan" : "gray"} bold={actionBarFocus === 1}>
              {actionBarFocus === 1 ? "▸ " : "  "}Continue chatting
            </Text>
          </Box>
          <Text dimColor>←/→ move · ⏎ select · esc/type to chat</Text>
        </Box>
      )}
      {/* Plan 15: artifact viewer — full-screen card for browsing artifacts. */}
      {artifactViewerOpen && completionArtifacts && (
        <ArtifactViewer
          ws={props.ws}
          artifacts={completionArtifacts}
          width={termSize.columns}
          keyHandlerRef={cardKeyRef}
          onClose={() => { cardKeyRef.current = null; setArtifactViewerOpen(false); }}
        />
      )}
      {!pending && busy && <RunStatus activity={activity} />}
      {/* Plan 10: the live status bar, pinned directly above the input (shows during approvals too). */}
      {planPanelOn && plan && !operationRunId && <PlanPanel plan={plan} width={termSize.columns} />}
      {layout.showBar && statuses.length > 0 && <StatusBar statuses={statuses} width={termSize.columns} />}
      {!pending && !operationRunId && (
        <>
          <Box>
            <Text color={busy ? "gray" : focusMode ? "gray" : "cyan"}>{busy ? "❯ " : focusMode ? "  " : "> "}</Text>
            <TextInput
              key={inputKey}
              defaultValue={inputSeed}
              placeholder={focusMode ? "(focus mode — esc to return)" : "message root, or / for commands"}
              onChange={onInputChange}
              onSubmit={submit}
            />
          </Box>
          {sugg.length > 0 && (
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
  return [{ kind: "system", text: "taicho — squad ready. Bare messages go to root; @agent to address directly; /agents, /costs, /help. ESC to quit." }];
}
