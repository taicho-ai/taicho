import type { PlanState } from "../schemas/plan";

/** The typed live event stream shared by Plan 02 (waterfall spans) and Plan 10 (live status).
 *  One instrumentation seam, two consumers: the loop + tool `execute()` wrapper + approval wrapper
 *  emit these; the status reducer (`agent-status.ts`) and the App's onStep both read them. The same
 *  phases are persisted to `transcript.jsonl` (tool_start/tool_end/approval_start/approval_end) so the
 *  post-hoc waterfall can derive accurate bars. */
export type StepPhase =
  | "model_start"    // a model call went out (nothing streamed yet) → "thinking"
  | "delta"          // a streamed text delta arrived → "writing"
  | "tool_start"     // a tool execute() began → "working" (or "delegating" for delegate/dispatch)
  | "tool_end"       // a tool execute() settled
  | "approval_start" // blocked on the captain (approval card / ask_human) → "waiting"
  | "approval_end"   // the captain answered
  | "final";         // the run produced its final text (no more tool calls) → run is settling

/** What the loop / tool wrapper emit (before run.ts stamps the agent + runId). */
export interface StepInfo {
  phase?: StepPhase;
  text?: string;       // streamed delta text (phase="delta") or final text (phase="final")
  delta?: string;      // legacy alias for a streamed delta (kept so App streaming reads it directly)
  tool?: string;       // tool name (tool_start/tool_end) or an approval label (approval_*)
  argsPreview?: string;// one-line, redacted, length-capped render of the tool args
  callId?: string;     // Plan 02 Phase 6: the tool's call id — lets the LIVE waterfall pair a
                       // tool_start with its tool_end deterministically (mirrors the persisted spanEvents)
  note?: string;       // a run-level breadcrumb (e.g. a verification verdict) — not a phase
  ok?: boolean;        // tool_end / approval_end success flag
  /** Plan 18: a snapshot of the emitting agent's plan, sent whenever an item changes.
   *
   *  DELIBERATELY PHASE-LESS. `statusReducer` switches on `phase` to mint an `AgentState`; a "plan"
   *  phase would fall through that switch and corrupt the live status map. Its existing guard —
   *  `if (!ev.phase || !ev.runId) return map` — drops this untouched, and App branches on `ev.plan`
   *  exactly the way it already branches on `ev.note`. The reducer is not modified at all. */
  plan?: PlanState;
}

/** What run.ts forwards to `deps.onStep` — the same info stamped with which agent/run produced it. */
export interface StepEvent extends StepInfo {
  agent: string;
  runId?: string;
}
