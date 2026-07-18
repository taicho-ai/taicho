/** Plan 10 Phase 2 — the live status model (pure, testable). Folds the typed engine event stream
 *  (events.ts) into one AgentStatus per ACTIVE run. The StatusBar (and later panes) render from this;
 *  nothing is invented in the UI. Keyed by runId so a delegation cascade shows every live agent at
 *  once (parent `delegating`, child `working`). Elapsed-in-state is `now - since`, computed at render. */
import type { StepEvent } from "@taicho/agent";

export type AgentState = "idle" | "thinking" | "writing" | "working" | "waiting" | "delegating";

export interface AgentStatus {
  runId: string;
  agent: string;
  state: AgentState;
  tool?: string;         // the current tool (working/delegating) or approval label (waiting)
  argsPreview?: string;  // redacted one-liner for the current tool
  since: number;         // ms timestamp when the current state began (for elapsed-in-state)
  inflightTools: number; // tools whose execute() is currently running
  waiting: boolean;      // blocked on the captain right now
}

export type StatusMap = ReadonlyMap<string, AgentStatus>;

const isDelegation = (tool?: string) => tool === "delegate_task" || tool === "dispatch_task";

/** Fold one event into the status map, returning a NEW map (so React state updates fire). Events
 *  without a phase or runId (plain note breadcrumbs, etc.) pass through untouched. */
export function statusReducer(map: StatusMap, ev: StepEvent, now: number): StatusMap {
  if (!ev.phase || !ev.runId) return map;
  const next = new Map(map);
  const runId = ev.runId;
  const prev: AgentStatus =
    next.get(runId) ?? { runId, agent: ev.agent, state: "idle", since: now, inflightTools: 0, waiting: false };

  const set = (s: Partial<AgentStatus> & { state: AgentState }): StatusMap => {
    const since = s.state !== prev.state ? now : prev.since;
    next.set(runId, { ...prev, agent: ev.agent, ...s, since });
    return next;
  };

  switch (ev.phase) {
    case "final":
      next.delete(runId); // the run produced its final text → it is settling; drop it from the live view
      return next;
    case "model_start":
      // A fresh model call: back to thinking (unless we're mid-approval, which owns the state).
      return prev.waiting ? next : set({ state: "thinking", tool: undefined, argsPreview: undefined });
    case "delta":
      return prev.waiting ? next : set({ state: "writing" });
    case "tool_start": {
      const inflightTools = prev.inflightTools + 1;
      return set({
        state: isDelegation(ev.tool) ? "delegating" : "working",
        tool: ev.tool,
        argsPreview: ev.argsPreview,
        inflightTools,
      });
    }
    case "tool_end": {
      const inflightTools = Math.max(0, prev.inflightTools - 1);
      if (prev.waiting) { next.set(runId, { ...prev, inflightTools }); return next; } // approval owns state
      // Back to thinking once no tool is in flight; otherwise stay busy.
      const state: AgentState = inflightTools > 0 ? prev.state : "thinking";
      return set({ state, tool: inflightTools > 0 ? prev.tool : undefined, argsPreview: inflightTools > 0 ? prev.argsPreview : undefined, inflightTools });
    }
    case "approval_start":
      return set({ state: "waiting", waiting: true, tool: ev.tool, argsPreview: ev.argsPreview });
    case "approval_end": {
      const state: AgentState = prev.inflightTools > 0 ? "working" : "thinking";
      return set({ state, waiting: false, tool: prev.inflightTools > 0 ? prev.tool : undefined });
    }
    default:
      return next;
  }
}

/** Ordered snapshot for rendering: waiting agents first (the "the squad is stalled on YOU" signal),
 *  then oldest-in-state first for stability. */
export function statusList(map: StatusMap): AgentStatus[] {
  return [...map.values()].sort((a, b) => Number(b.waiting) - Number(a.waiting) || a.since - b.since);
}
