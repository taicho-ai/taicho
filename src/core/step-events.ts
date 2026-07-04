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
  note?: string;       // a run-level breadcrumb (e.g. a verification verdict) — not a phase
  ok?: boolean;        // tool_end / approval_end success flag
}

/** What run.ts forwards to `deps.onStep` — the same info stamped with which agent/run produced it. */
export interface StepEvent extends StepInfo {
  agent: string;
  runId?: string;
}
