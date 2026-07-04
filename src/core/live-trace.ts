/** Plan 02 Phase 6 — the LIVE waterfall. The post-hoc `deriveTrace` (trace-tree.ts) reads a settled
 *  run's files back into a Span tree; this is its live counterpart. It folds the SAME event stream
 *  that already drives the status bar/panes — `onRunStart` / `onStep` (agent-status.ts's inputs) /
 *  `onRunEnd` — into a PARTIAL Span tree, incrementally, as the run executes. No disk reads, no second
 *  event stream, no re-derive per frame: each fold mutates the accumulator; `liveSpans()` snapshots it
 *  (extending still-running bars to `now`) for the redraw. It reuses the Span model + trace-layout, so
 *  the live and post-hoc waterfalls render through the exact same layout code.
 *
 *  Pairing mirrors deriveTrace: llm spans pair model_start→(the next phase transition); tool spans
 *  pair tool_start→tool_end by `callId` (added to the live event for this — deterministic even when
 *  tools run concurrently); approvals FIFO-pair; a delegated child run nests under the EXACT
 *  `delegate_task` tool span that spawned it, keyed by the spawning callId (threaded through
 *  onRunStart, mirroring the post-hoc childRunId link) so the cascade reads identically — and two
 *  concurrent delegations in one turn never swap children. */
import type { Span, SpanStatus, SpanDetail } from "./trace-tree";
import type { StepEvent } from "./step-events";
import type { RunTrace } from "../schemas/trace";

export interface LiveRunInfo {
  runId: string;
  agent: string;
  triggeredBy: string;    // "user" | parent runId | a task id — resolves the parent edge
  spawnCallId?: string;   // the delegate_task callId that spawned this child (parent-run delegations
                          //   only) → adopt the EXACT tool span, mirroring the post-hoc childRunId link
}
export interface LiveRunEndInfo extends LiveRunInfo {
  outcome: RunTrace["outcome"];
}

/** The mutable accumulator. Spans are stored by id and mutated in place as they run and settle;
 *  the auxiliary maps track the currently-open span of each kind per run (to close it on the next
 *  transition), keeping the fold O(1) per event. */
export interface LiveTraceState {
  order: string[];                       // span ids in creation order (stable pre-layout ordering)
  spans: Map<string, Span>;              // id → span (mutated in place)
  openLlm: Map<string, string>;          // runId → its currently-open llm span id
  llmCount: Map<string, number>;         // runId → iterations seen (llm span numbering)
  toolByCall: Map<string, string>;       // `${runId}::${callId}` → tool span id (precise start↔end
                                         //   pairing; runId-scoped so the engine's per-run fallback
                                         //   callId `name#seq` can't collide across concurrent runs)
  toolStack: Map<string, string[]>;      // runId → open tool span ids (LIFO fallback when no callId)
  openApproval: Map<string, string[]>;   // runId → open approval span ids (FIFO)
  approvalCount: Map<string, number>;    // runId → approvals seen (approval span numbering)
}

export function emptyLiveTrace(): LiveTraceState {
  return {
    order: [],
    spans: new Map(),
    openLlm: new Map(),
    llmCount: new Map(),
    toolByCall: new Map(),
    toolStack: new Map(),
    openApproval: new Map(),
    approvalCount: new Map(),
  };
}

/** Append to a Map<key, T[]>, creating the array on first use. */
function pushInto<K>(map: Map<K, string[]>, key: K, value: string): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/** RunTrace outcome → SpanStatus (matches trace-tree's mapping; blocked/interrupted pass through). */
function outcomeToStatus(outcome: RunTrace["outcome"]): SpanStatus {
  return outcome === "completed" ? "ok" : outcome === "failed" ? "error" : outcome;
}

function add(st: LiveTraceState, span: Span): void {
  st.spans.set(span.id, span);
  st.order.push(span.id);
}

/** Close the run's open llm span at `now` (the model produced output / moved on). */
function closeLlm(st: LiveTraceState, runId: string, now: number): void {
  const id = st.openLlm.get(runId);
  if (!id) return;
  const s = st.spans.get(id);
  if (s && s.status === "running") { s.endMs = Math.max(s.endMs, now); s.status = "ok"; }
  st.openLlm.delete(runId);
}

/** Open a run span. Idempotent (a re-fired onRunStart is ignored). Parent: a delegated child nests
 *  under the EXACT `delegate_task` tool span that spawned it, addressed directly by the spawning
 *  callId (threaded through onRunStart) — `${parentRunId}#tool:${spawnCallId}`, the same id tool_start
 *  built. This is deterministic (no LIFO/FIFO queue that only accidentally pairs concurrent
 *  delegations), and a `dispatch_task`'s detached child (triggeredBy = a task id) simply never
 *  addresses a span, so it can't be mis-adopted. No callId (or the span isn't there) ⇒ nest directly
 *  under the run; a "user"/task root has no parent. */
export function liveRunStart(st: LiveTraceState, info: LiveRunInfo, now: number): LiveTraceState {
  if (st.spans.has(info.runId)) return st;
  let parentId: string | undefined;
  if (st.spans.has(info.triggeredBy)) {
    const delegId = info.spawnCallId ? `${info.triggeredBy}#tool:${info.spawnCallId}` : undefined;
    const deleg = delegId ? st.spans.get(delegId) : undefined;
    parentId = deleg && deleg.kind === "tool" ? deleg.id : info.triggeredBy;
  }
  const detail: SpanDetail = {
    kind: "run", outcome: "interrupted", task: "(running)", tokens: 0, costUsd: null,
    notes: [], ledger: { retrieved: [], applied: [], skipped: [], knowledge: [], skills: [] }, verification: [],
  };
  add(st, {
    id: info.runId, parentId, kind: "run",
    name: `${info.agent}${info.triggeredBy === "user" ? " · chat" : " · deleg"}`,
    agent: info.agent, status: "running", startMs: now, endMs: now, detail,
  });
  return st;
}

/** Fold one live StepEvent (a phase-tagged event with a runId) into the tree. */
export function liveStep(st: LiveTraceState, ev: StepEvent, now: number): LiveTraceState {
  const runId = ev.runId;
  if (!runId || !ev.phase) return st;
  // The run span is opened by onRunStart, which ALWAYS precedes any onStep for that run (run.ts fires
  // onRunStart before runLoop emits model_start). So an unknown run here means the event belongs to a
  // run that started BEFORE the last clear (a background task that outlived its dispatching turn) —
  // it belongs to a finished turn, so drop it rather than resynthesize a mis-rooted, mis-timed span.
  const runSpan = st.spans.get(runId);
  if (!runSpan) return st;
  if (runSpan.status === "running" && runSpan.endMs < now) runSpan.endMs = now;

  switch (ev.phase) {
    case "model_start": {
      closeLlm(st, runId, now);
      const iter = (st.llmCount.get(runId) ?? 0) + 1;
      st.llmCount.set(runId, iter);
      const id = `${runId}#llm${iter}`;
      add(st, {
        id, parentId: runId, kind: "llm", name: `llm #${iter}`, agent: ev.agent,
        status: "running", startMs: now, endMs: now, detail: { kind: "llm", iteration: iter },
      });
      st.openLlm.set(runId, id);
      break;
    }
    case "delta": {
      const id = st.openLlm.get(runId);
      const s = id ? st.spans.get(id) : undefined;
      if (s) s.endMs = now; // the model is producing output → grow its bar
      break;
    }
    case "tool_start": {
      closeLlm(st, runId, now); // the response produced tool calls → the model call is done
      const callId = ev.callId ?? `#tc${st.order.length}`;
      const id = `${runId}#tool:${callId}`;
      const tool = ev.tool ?? "tool";
      add(st, {
        id, parentId: runId, kind: "tool", name: tool, agent: ev.agent,
        status: "running", startMs: now, endMs: now,
        detail: { kind: "tool", tool, argsPreview: ev.argsPreview },
      });
      st.toolByCall.set(`${runId}::${callId}`, id);
      pushInto(st.toolStack, runId, id);
      break;
    }
    case "tool_end": {
      const key = ev.callId ? `${runId}::${ev.callId}` : undefined;
      let id = key ? st.toolByCall.get(key) : undefined;
      const stack = st.toolStack.get(runId) ?? [];
      if (id) { const i = stack.lastIndexOf(id); if (i >= 0) stack.splice(i, 1); }
      else id = stack.pop(); // LIFO fallback when no callId came through
      if (id) {
        const s = st.spans.get(id);
        if (s && s.status === "running") { s.endMs = Math.max(s.endMs, now); s.status = ev.ok === false ? "error" : "ok"; }
        if (key) st.toolByCall.delete(key);
      }
      break;
    }
    case "approval_start": {
      const n = st.approvalCount.get(runId) ?? 0;
      st.approvalCount.set(runId, n + 1);
      const id = `${runId}#approval${n}`;
      const label = ev.tool ?? "approval";
      add(st, {
        id, parentId: runId, kind: "approval", name: label, agent: ev.agent,
        status: "running", startMs: now, endMs: now, detail: { kind: "approval", label, approvalKind: "" },
      });
      pushInto(st.openApproval, runId, id);
      break;
    }
    case "approval_end": {
      const q = st.openApproval.get(runId) ?? [];
      const id = q.shift(); // FIFO: one card blocks at a time
      const s = id ? st.spans.get(id) : undefined;
      if (s && s.status === "running") { s.endMs = Math.max(s.endMs, now); s.status = "ok"; }
      break;
    }
    case "final": {
      closeLlm(st, runId, now); // the run produced its final text → its last model call is done
      break;
    }
  }
  return st;
}

/** Close a run span (any outcome) at `now`, settling any still-open child spans under it. */
export function liveRunEnd(st: LiveTraceState, info: LiveRunEndInfo, now: number): LiveTraceState {
  const s = st.spans.get(info.runId);
  if (s) {
    s.endMs = Math.max(s.endMs, now);
    s.status = outcomeToStatus(info.outcome);
    if (s.detail.kind === "run") s.detail.outcome = info.outcome;
  }
  closeLlm(st, info.runId, now);
  const settle: SpanStatus = info.outcome === "interrupted" ? "interrupted" : "ok";
  for (const id of st.toolStack.get(info.runId) ?? []) {
    const t = st.spans.get(id);
    if (t && t.status === "running") { t.endMs = Math.max(t.endMs, now); t.status = settle; }
  }
  for (const id of st.openApproval.get(info.runId) ?? []) {
    const a = st.spans.get(id);
    if (a && a.status === "running") { a.endMs = Math.max(a.endMs, now); a.status = settle; }
  }
  st.toolStack.delete(info.runId);
  st.openApproval.delete(info.runId);
  return st;
}

/** Snapshot the accumulator as a fresh Span[] for the layout/renderer. Still-running spans have their
 *  endMs extended to `now` so their bars grow between events (the redraw); settled spans keep the
 *  authoritative end their settle event stamped. Returns a NEW array so React re-renders. */
export function liveSpans(st: LiveTraceState, now: number = Date.now()): Span[] {
  const out: Span[] = [];
  for (const id of st.order) {
    const s = st.spans.get(id);
    if (!s) continue;
    out.push(s.status === "running" && now > s.endMs ? { ...s, endMs: now } : s);
  }
  return out;
}
