/** Plan 02 — the waterfall reader. Pure derivation (files in → Span[] out; no Ink) so it is
 *  unit-testable over fixture traces + transcripts. A "trace" = one root run plus its delegation
 *  subtree (exactly like a LangSmith trace = one top-level invocation). Every row the inspector
 *  draws — run / llm / tool / approval — is one Span on a shared absolute-time axis. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../store/files";
import { readTrace, listTraces } from "../store/trace";
import { readRunTranscript, type RunTranscriptEvent } from "../store/run-transcript";
import { readTaskState, type TaskState } from "../store/task-state";
import type { RunTrace } from "../schemas/trace";

export type SpanKind = "run" | "llm" | "tool" | "approval";
export type SpanStatus = "ok" | "error" | "running" | "blocked" | "interrupted";

export type SpanDetail =
  | { kind: "run"; outcome: RunTrace["outcome"]; task: string; tokens: number; costUsd: number | null; aggregate?: RunTrace["aggregate"]; notes: string[]; ledger: RunTrace["ledger"]; verification: RunTrace["verification"]; inputMessages?: unknown }
  | { kind: "llm"; iteration: number; tokens?: number; finishReason?: string; responseText?: string; error?: string; contextTokens?: number; compacted?: boolean }
  | { kind: "tool"; tool: string; argsPreview?: string; args?: string; result?: string; error?: string; childRunId?: string }
  | { kind: "approval"; label: string; approvalKind: string }
  // Plan 02 Phase 6: a synthetic TASK-root span (the drill-in for a task-level trace, which roots at a
  // Task and groups its runs across turns rather than a single user-run — see deriveTaskTrace).
  | { kind: "task"; taskId: string; title: string; status: string; agent?: string; summary?: string; runCount: number; tokens: number; costUsd: number | null };

export interface Span {
  id: string;
  parentId?: string;
  kind: SpanKind;
  name: string;
  agent: string;
  status: SpanStatus;
  startMs: number;
  endMs: number;
  tokens?: number;
  costUsd?: number | null;
  error?: string;
  detail: SpanDetail;
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function runStatus(outcome: RunTrace["outcome"]): SpanStatus {
  return outcome === "completed" ? "ok" : outcome === "failed" ? "error" : outcome; // blocked | interrupted map through
}

/** Read a run's initial input messages (best-effort; the "assembled prompt" for the drill-in). */
function readInputMessages(ws: string, runId: string): unknown {
  const file = join(paths.runRecordDir(ws, runId), "input.json");
  if (!existsSync(file)) return undefined;
  try { return (JSON.parse(readFileSync(file, "utf8")) as { messagesPassedToModel?: unknown }).messagesPassedToModel; }
  catch { return undefined; }
}

/** Tokens off a model_response usage payload (totalTokens, else in+out). */
function usageTokens(usage: unknown): number | undefined {
  const u = asObj(usage);
  const total = num(u.totalTokens);
  if (total != null) return total;
  const sum = (num(u.inputTokens) ?? 0) + (num(u.outputTokens) ?? 0);
  return sum || undefined;
}

/** Build the llm / tool / approval spans for ONE run from its transcript events. */
function childSpansOf(ws: string, trace: RunTrace): Span[] {
  const events = readRunTranscript(ws, trace.id);
  const spans: Span[] = [];
  const at = (ts: string) => Date.parse(ts);

  // ── llm spans: pair model_request(iter) → model_response|model_error(iter) ──
  const req = new Map<number, RunTranscriptEvent>();
  const resp = new Map<number, RunTranscriptEvent>();
  const err = new Map<number, RunTranscriptEvent>();
  for (const e of events) {
    if (e.iteration == null) continue;
    if (e.kind === "model_request") req.set(e.iteration, e);
    else if (e.kind === "model_response") resp.set(e.iteration, e);
    else if (e.kind === "model_error") err.set(e.iteration, e);
  }
  for (const [iter, r] of [...req.entries()].sort((a, b) => a[0] - b[0])) {
    const done = resp.get(iter) ?? err.get(iter);
    const errored = !resp.get(iter) && !!err.get(iter);
    const d = asObj(done?.data);
    const rd = asObj(r.data); // model_request carries Plan 05's context estimate + compaction flag
    const toolCalls = Array.isArray(d.toolCalls) ? d.toolCalls : [];
    spans.push({
      id: `${trace.id}#llm${iter}`,
      parentId: trace.id,
      kind: "llm",
      name: `llm #${iter}`,
      agent: trace.agent,
      status: errored ? "error" : "ok",
      startMs: at(r.ts),
      endMs: done ? at(done.ts) : at(r.ts),
      tokens: usageTokens(d.usage),
      error: errored ? str(d.error) : undefined,
      detail: {
        kind: "llm",
        iteration: iter,
        tokens: usageTokens(d.usage),
        finishReason: errored ? undefined : toolCalls.length ? "tool-calls" : "stop",
        responseText: str(d.text),
        error: errored ? str(d.error) : undefined,
        contextTokens: num(rd.contextTokens),
        compacted: rd.compacted === true,
      },
    });
  }

  // ── tool spans: pair tool_start(callId) → tool_end(callId) ──
  const tStart = new Map<string, RunTranscriptEvent>();
  const tEnd = new Map<string, RunTranscriptEvent>();
  for (const e of events) {
    const callId = str(asObj(e.data).callId);
    if (!callId) continue;
    if (e.kind === "tool_start") tStart.set(callId, e);
    else if (e.kind === "tool_end") tEnd.set(callId, e);
  }
  for (const [callId, s] of tStart) {
    const end = tEnd.get(callId);
    const sd = asObj(s.data);
    const ed = asObj(end?.data);
    const toolName = str(sd.tool) ?? "tool";
    const errored = end ? ed.ok === false : false;
    spans.push({
      id: `${trace.id}#tool:${callId}`,
      parentId: trace.id,
      kind: "tool",
      name: toolName,
      agent: trace.agent,
      status: end ? (errored ? "error" : "ok") : "running",
      startMs: at(s.ts),
      endMs: end ? at(end.ts) : at(s.ts),
      error: errored ? str(ed.error) : undefined,
      detail: {
        kind: "tool",
        tool: toolName,
        argsPreview: str(sd.argsPreview),
        args: str(sd.args),
        result: str(ed.result),
        error: errored ? str(ed.error) : undefined,
        childRunId: str(ed.childRunId),
      },
    });
  }

  // ── approval spans: FIFO-pair approval_start → approval_end (one card blocks at a time) ──
  const aStarts = events.filter((e) => e.kind === "approval_start");
  const aEnds = events.filter((e) => e.kind === "approval_end");
  aStarts.forEach((s, i) => {
    const end = aEnds[i];
    const sd = asObj(s.data);
    const label = str(sd.label) ?? "approval";
    spans.push({
      id: `${trace.id}#approval${i}`,
      parentId: trace.id,
      kind: "approval",
      name: label,
      agent: trace.agent,
      status: end ? "ok" : "running",
      startMs: at(s.ts),
      endMs: end ? at(end.ts) : at(s.ts),
      detail: { kind: "approval", label, approvalKind: str(sd.kind) ?? "" },
    });
  });

  return spans;
}

/** Walk the delegation subtree rooted at `runId`, appending Spans to `spans` (shared `seen` guards
 *  against cycles AND lets several roots merge into one tree — see deriveTaskTrace). Run spans nest by
 *  delegation; llm/tool/approval spans nest under their run; a `delegate_task` tool span adopts its
 *  child run span (via the captured childRunId). */
function walkRun(ws: string, runId: string, spans: Span[], seen: Set<string>, parentSpanId?: string): void {
  if (seen.has(runId)) return;
  seen.add(runId);
  let trace: RunTrace;
  try { trace = readTrace(ws, runId); }
  catch { return; } // a missing/unparseable child never breaks the rest of the tree
  const startMs = Date.parse(trace.started);
  const runSpan: Span = {
    id: trace.id,
    parentId: parentSpanId,
    kind: "run",
    name: `${trace.agent}${trace.triggeredBy === "user" ? " · chat" : " · deleg"}`,
    agent: trace.agent,
    status: runStatus(trace.outcome),
    startMs,
    endMs: startMs + (trace.durationMs || 0),
    tokens: trace.aggregate?.tokens ?? trace.tokens,
    costUsd: trace.aggregate ? trace.aggregate.costUsd : trace.costUsd,
    detail: {
      kind: "run",
      outcome: trace.outcome,
      task: trace.task,
      tokens: trace.tokens,
      costUsd: trace.costUsd,
      aggregate: trace.aggregate,
      notes: trace.notes,
      ledger: trace.ledger,
      verification: trace.verification,
      inputMessages: readInputMessages(ws, trace.id),
    },
  };
  spans.push(runSpan);
  const kids = childSpansOf(ws, trace);
  for (const k of kids) spans.push(k);

  // A verification retry spawns TWO child runs from ONE delegate_task call, but the tool span only
  // captures the retry's runId (the tool's return value). Pair each retry (verification.retried) with
  // its failed first attempt (same criteria) so BOTH nest under the delegate_task span instead of the
  // first attempt reparenting to the run span as a stray top-level sibling.
  const firstAttemptFor = new Map<string, string>(); // retryRunId → its failed first-attempt runId
  const pendingFirst: { criteria: string; runId: string }[] = [];
  for (const v of trace.verification) {
    if (!v.retried) { pendingFirst.push({ criteria: v.criteria, runId: v.runId }); continue; }
    let idx = -1;
    for (let i = pendingFirst.length - 1; i >= 0; i--) if (pendingFirst[i].criteria === v.criteria) { idx = i; break; }
    if (idx >= 0) { firstAttemptFor.set(v.runId, pendingFirst[idx].runId); pendingFirst.splice(idx, 1); }
  }

  // Recurse into delegated child runs, nesting each under its delegate_task tool span when the
  // childRunId was captured (plus any paired first attempt); otherwise directly under this run.
  const delegSpans = kids.filter((k) => k.kind === "tool" && k.detail.kind === "tool" && (k.detail.childRunId != null));
  const linked = new Set<string>();
  const nestUnder = (childId: string | undefined, spanId: string) => {
    if (childId && trace.delegatedOut.includes(childId) && !linked.has(childId)) { linked.add(childId); walkRun(ws, childId, spans, seen, spanId); }
  };
  for (const d of delegSpans) {
    const childId = d.detail.kind === "tool" ? d.detail.childRunId : undefined;
    nestUnder(childId, d.id);
    if (childId) nestUnder(firstAttemptFor.get(childId), d.id); // the failed first attempt, under the same span
  }
  for (const childId of trace.delegatedOut) if (!linked.has(childId)) walkRun(ws, childId, spans, seen, runSpan.id);
}

/** Walk the delegation subtree rooted at `rootRunId`, reading each run's trace + transcript into
 *  Spans on a shared time axis. A "trace" = one root run plus its delegation subtree. */
export function deriveTrace(ws: string, rootRunId: string): Span[] {
  const spans: Span[] = [];
  walkRun(ws, rootRunId, spans, new Set());
  return spans;
}

/** The top-level (non-delegated) runs a task groups: its `rootRunId`, plus any run whose
 *  `triggeredBy` is the task id (a background dispatch's root run; the generalization a task spanning
 *  multiple turns/runs relies on). Child runs are reached by the walker via delegatedOut, so they are
 *  deliberately NOT gathered here. Ordered by start time. */
function taskRootRunIds(ws: string, task: TaskState | null, taskId: string): string[] {
  const ids = new Set<string>();
  if (task?.rootRunId) ids.add(task.rootRunId);
  for (const t of listTraces(ws)) if (t.triggeredBy === taskId) ids.add(t.id);
  const roots = [...ids].filter(Boolean);
  const startOf = (id: string) => { try { return Date.parse(readTrace(ws, id).started); } catch { return Number.POSITIVE_INFINITY; } };
  return roots.sort((a, b) => startOf(a) - startOf(b));
}

/** Plan 02 Phase 6 — a TASK-level trace: root at a Task (Plan 04's persistent task record) rather than
 *  a single user-run, and gather ALL of the task's top-level runs — the grouping key for a task that
 *  spans multiple turns/runs — each with its full delegation subtree, under one synthetic task-root
 *  span on a shared time axis. Reuses the same walker + layout as deriveTrace, so the task waterfall
 *  renders identically (the task row sits above its per-run subtrees). Returns [] when nothing walks. */
export function deriveTaskTrace(ws: string, taskId: string): Span[] {
  const task = readTaskState(ws, taskId);
  const roots = taskRootRunIds(ws, task, taskId);
  if (!roots.length) return [];

  const taskRootId = `task:${taskId}`;
  const children: Span[] = [];
  const seen = new Set<string>();
  for (const r of roots) walkRun(ws, r, children, seen, taskRootId);
  if (!children.length) return [];

  const runRoots = children.filter((s) => s.kind === "run" && s.parentId === taskRootId);
  const tokens = runRoots.reduce((n, s) => n + (s.tokens ?? 0), 0);
  const costUsd = runRoots.some((s) => s.costUsd == null) ? null : runRoots.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  const startMs = Math.min(...children.map((s) => s.startMs).filter(Number.isFinite));
  const endMs = Math.max(...children.map((s) => s.endMs).filter(Number.isFinite));
  const status: SpanStatus =
    runRoots.some((s) => s.status === "error") ? "error"
      : runRoots.some((s) => s.status === "running") ? "running"
        : runRoots.some((s) => s.status === "blocked" || s.status === "interrupted") ? "interrupted" : "ok";

  const taskSpan: Span = {
    id: taskRootId,
    kind: "run", // a run-like container: renders with the run bar/glyphs; its drill-in is task-flavored
    name: `task · ${task?.agent ?? task?.title ?? taskId}`,
    agent: task?.agent ?? "task",
    status,
    startMs: Number.isFinite(startMs) ? startMs : 0,
    endMs: Number.isFinite(endMs) ? endMs : 0,
    tokens,
    costUsd,
    detail: {
      kind: "task", taskId, title: task?.title ?? taskId, status: task?.status ?? "unknown",
      agent: task?.agent, summary: task?.summary, runCount: runRoots.length, tokens, costUsd,
    },
  };
  return [taskSpan, ...children];
}

/** The single header summary for a derived trace (root run span). */
export function traceSummary(spans: Span[]): { durationMs: number; tokens: number; costUsd: number | null; status: SpanStatus } | null {
  const runs = spans.filter((s) => s.kind === "run");
  if (!runs.length) return null;
  const root = runs.find((s) => s.parentId == null) ?? runs[0];
  const start = Math.min(...spans.map((s) => s.startMs).filter(Number.isFinite));
  const end = Math.max(...spans.map((s) => s.endMs).filter(Number.isFinite));
  return { durationMs: Math.max(0, end - start), tokens: root.tokens ?? 0, costUsd: root.costUsd ?? null, status: root.status };
}
