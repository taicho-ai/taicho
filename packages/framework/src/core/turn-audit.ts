/** Plan 01 Phase 5 — the turn-outcome audit SEAM, moved from the UI into the engine.
 *
 *  Before this, `App.tsx submit()` carried two near-identical ~30-line audit blocks (chat vs @agent)
 *  and PR #17 de-duplicated them into an App-LOCAL `recordTurnOutcome`. That still lived in the React
 *  component, so any non-Ink caller (headless `taicho run`, tests) got run evidence but silently NO
 *  ledger, NO task, NO replay cache. This module lifts the audit into ONE engine seam that
 *  `executeRun` calls (guarded by `triggeredBy === "user"`), so every caller gets identical audit —
 *  and cross-turn compaction (Plan 05 Ph3) hooks the SAME seam to write the rolling replay summary.
 *
 *  The seam has two halves, both keyed off the ledger (append-only TRUTH — see context-hygiene
 *  audit decision C):
 *   - `recordUserTurn` at run START: append the user turn (status `submitted`) + open the task record.
 *   - `recordTurnOutcome` at run END: append the assistant turn (status = outcome), record the
 *     include/exclude context decision for BOTH turns, fold the run into its task, and REBUILD the
 *     derived boot-replay cache (rolling summary + recent-K tail). Compaction changes what REPLAYS,
 *     never what is RECORDED. */
import type { Database } from "bun:sqlite";
import type { RunTrace } from "@taicho-ai/contracts/trace";
import { appendLedgerTurn, newTurnId, recordContextDecision } from "../store/conversation";
import { createTaskState, taskIdForRun, updateTaskFromTrace, setTaskFields } from "../store/task-state";
import { rebuildReplayCache } from "./conversation-replay";

export interface UserTurn {
  userTurnId: string;
  taskId: string;
}

/** Run START (user turns only): record the user message in the ledger + open the task record. */
export function recordUserTurn(ws: string, db: Database, o: { agent: string; runId: string; text: string }): UserTurn {
  const userTurnId = newTurnId(o.agent, o.runId, "user");
  appendLedgerTurn(ws, o.agent, {
    turnId: userTurnId, runId: o.runId, timestamp: new Date().toISOString(),
    agent: o.agent, role: "user", content: o.text, status: "submitted",
  });
  createTaskState(ws, { runId: o.runId, title: o.text, userTurnId }, db);
  return { userTurnId, taskId: taskIdForRun(o.runId) };
}

/** Run END (user turns only): record the assistant turn + the context decision + the task update,
 *  then rebuild the derived boot-replay cache. A COMPLETED run is safe to replay as context; any
 *  other outcome is recorded in the ledger but EXCLUDED from replay (and leaves the cache untouched,
 *  since it rebuilds from the included set). */
export function recordTurnOutcome(
  ws: string,
  db: Database,
  o: {
    agent: string;
    runId: string;
    userTurn?: UserTurn;
    trace: RunTrace;
    children?: RunTrace[];
    text: string;
    keepRecentTurns?: number;
  },
): void {
  const assistantTurnId = newTurnId(o.agent, o.runId, "assistant");
  appendLedgerTurn(ws, o.agent, {
    turnId: assistantTurnId, runId: o.runId, timestamp: new Date().toISOString(),
    agent: o.agent, role: "assistant", content: o.text,
    status: o.trace.outcome,          // outcome ⊂ LedgerStatus (was statusFromOutcome, an identity)
    artifacts: o.trace.artifacts,     // handles this turn produced — carried by REFERENCE into replay
  });
  if (o.userTurn) {
    const include = o.trace.outcome === "completed";
    const reason = include ? "completed_turn" : `${o.trace.outcome}_run_not_safe_as_context`;
    recordContextDecision(ws, o.agent, { include, turnId: o.userTurn.userTurnId, runId: o.runId, reason });
    recordContextDecision(ws, o.agent, { include, turnId: assistantTurnId, runId: o.runId, reason });
    updateTaskFromTrace(ws, o.userTurn.taskId, o.trace, o.children ?? [], db);
  }
  // The replay cache is DERIVED from the ledger's INCLUDED turns; only a completed turn changes that
  // set, so only then is a rebuild meaningful (a failed/interrupted turn is already excluded and the
  // cache stays as it was). Older turns fold into the rolling summary here — Plan 05 Ph3.
  if (o.trace.outcome === "completed") {
    rebuildReplayCache(ws, o.agent, { keepRecentTurns: o.keepRecentTurns });
  }
}

/** Run START opened an append-only `submitted` ledger turn + a `running` task BEFORE the model was
 *  even resolved (recordUserTurn). If something between there and the normal close THROWS — e.g.
 *  `resolveModel` hitting the OpenRouter/explicit-model guard — the turn/task would otherwise DANGLE:
 *  a `submitted` turn with no terminal reply and a `running` task that never settles (and would only
 *  be swept to `interrupted` by the NEXT boot reconciliation). This closes the OPEN turn with a
 *  terminal `failed` outcome so the ledger + task are never left mid-flight. It mirrors the failed
 *  branch of `recordTurnOutcome` (append a `failed` assistant turn + EXCLUDE both turns from replay,
 *  leaving the replay cache untouched), but needs no RunTrace since no run ever completed. */
export function recordTurnFailure(
  ws: string,
  db: Database,
  o: { agent: string; runId: string; userTurn: UserTurn; error: string },
): void {
  const assistantTurnId = newTurnId(o.agent, o.runId, "assistant");
  appendLedgerTurn(ws, o.agent, {
    turnId: assistantTurnId, runId: o.runId, timestamp: new Date().toISOString(),
    agent: o.agent, role: "assistant", content: `error: ${o.error}`, status: "failed",
  });
  const reason = "failed_run_not_safe_as_context";
  recordContextDecision(ws, o.agent, { include: false, turnId: o.userTurn.userTurnId, runId: o.runId, reason });
  recordContextDecision(ws, o.agent, { include: false, turnId: assistantTurnId, runId: o.runId, reason });
  setTaskFields(ws, db, o.userTurn.taskId, { status: "failed", stepStatus: "failed" });
}
