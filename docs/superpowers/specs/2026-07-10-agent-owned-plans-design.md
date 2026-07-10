# Plan 18 — Agent-owned plans

**Date:** 2026-07-10
**Status:** shipped (branch `plan-18-plans`)
**Topic:** A root agent that writes down what it intends to do, ticks items off as it orchestrates, and
cannot lie to the captain about whether an item actually happened.

## 1. Background & problem

A root agent orchestrating six delegations held its intent in exactly one place: the model's attention
over an ever-growing message array. Three forces already in the codebase erode that:

- `compaction.ts` folds the oldest tool round-trips into a 2000-char summary. A plan stated in turn
  three is a gist by turn thirty.
- `conversation-replay.ts` keeps six turns verbatim and rolls the rest into one line each.
- `dispatch_task` returns a `taskId` immediately and settles off-turn. The intent that motivated it has
  nowhere to wait.

**The existing task system is the wrong primitive, and the resemblance is a trap.** `TaskState.steps[]`
looks like a checklist, but `updateTaskFromTrace` regenerates it from the delegation graph on every
write, and `reconcileTasks` force-marks every pending task `interrupted` at boot. It models *work in
flight*. A plan models *intent not yet executed*, which must survive a reboot untouched.

## 2. Goals & non-goals

**Goals**
- A durable, versioned plan owned by an agent, surviving compaction, crashes, and multi-turn conversations.
- Checkboxes that reflect what *happened*, not what the model *claims*.
- The plan visible to the model before every step, and to the captain at a glance.

**Non-goals**
- GC. Plans are kilobytes; `artifacts.ts`'s retention machinery exists because artifact bodies are not.
- Plan templates / reusable checklists. That is a skills-shaped problem.
- Dependency edges between items. Ordering is presentation; a DAG invites a scheduler `TaskScheduler` already is.

## 3. The load-bearing idea: structure vs state

Versioning every tick would produce thirty-six versions of a twelve-item plan whose *shape never
changed*. So they are split, and this repo already runs both halves:

- a **version** (`plans/<id>/v<N>.json`) is an immutable snapshot of the item SET — the intent. Minted
  only when the shape changes. This is `artifacts.ts`: `flag:"wx"` exclusive-create, retry on `EEXIST`,
  lineage in `parents`.
- a **transition** is an append-only line in `plans/<id>/events.jsonl`. This is `annotations.ts`.

Current state is `fold(events)` over the latest version — the ledger-is-truth / cache-is-derived rule
that already governs `ledger.jsonl` → `thread.jsonl`. Version history answers *how did the plan evolve*;
the event log answers *what actually happened*.

`writePlan` deep-equality-dedups the item set, so a model restating its plan every iteration mints
nothing. Item ids are stable across versions, so an event logged against v1 still resolves after v2.

## 4. Data model (`src/schemas/plan.ts`, `src/store/plans.ts`)

`PlanItem {id, text, assignee?}` · `Plan {id, version, owner, goal, items[], parents[], producer, runId, created}`
`PlanEvent {item, status, by: "model"|"engine", runId, boundRunId?, note?, rejected?, ts}`

`PlanEvent.rejected` is the subtle one. A refused model attempt is still appended — a model marking a
failed delegation `done` is a fact worth having — but the fold **skips** rejected events. Without that
flag the attempt would be the last line for the item and would *win*, which is precisely the lie the
engine-owns rule exists to prevent.

SQLite migration **v10** adds a `plans` table of FOLDED counters only; `reindexPlans` rebuilds it from
the files.

## 5. Correlation — the checkbox cannot lie

`delegate_task` / `dispatch_task` take an optional `itemId`. The engine binds the item `in_progress`
*before* the child runs (so a crash leaves it for `reconcilePlans`), then settles it from the child's
real `trace.outcome`. With `criteria` set, it goes green only when the independent Plan 06 checker
agrees, and a failed verdict's reasons land on the item.

**Once an item carries a `boundRunId`, only the engine may set its terminal status.** The retry path
re-guards against the RESOLVED agent, never the original `to` — passing a team id would re-run the
ranker and could hand the retry to a different member.

`reconcilePlans` appends `interrupted` for in-flight items at boot and never touches the intent.
PENDING items survive a reboot, unlike a task.

## 6. Injection (`src/core/plan-inject.ts`)

`assemble()` runs exactly once per run, so the live plan **never** enters the system prompt — a plan
there is stale after iteration one and would contradict the tail slot the model also reads. The system
prompt gets only the static `PLAN_OPERATING_NOTE` (stable tier, cacheable).

The live plan **never enters `messages` either.** `withPlanSlot(messages, planText)` builds
`[...messages, slot]` for the model CALL only. Four properties fall out for free:

- context cost is FLAT, not cumulative
- **compaction is orthogonal by construction** — `compactMessages` never sees the slot, so no future
  tuning of `keepHead`/`compactKeepRecent` can eat the plan
- the prefix cache is untouched (system + head never change)
- the checkpoint and transcript record the real conversation, not a synthetic message

An agent without a plan pays zero tokens, zero store reads, zero overhead.

*(This improves on the original design doc, which spliced the slot in and out of the history array.)*

## 7. Surfaces

`ui/PlanPanel.tsx` — display-only, so the REPL keeps the keyboard. Fixed height; an over-long plan never
hides a FAILED or IN_PROGRESS item, and surviving rows keep the plan's own order. `/plan [on|off]`
persists via `.prefs.json`. Seeded from the store at boot, so a plan survives a restart visibly.

`StepInfo.plan` is deliberately **phase-less**: a `"plan"` `StepPhase` would fall through
`statusReducer`'s switch and corrupt the live status map. Its existing guard drops a phase-less event.

`trace.plan` + `trace.planEvents` (both `.optional()`, not `.default()`, so hand-built RunTrace fixtures
need no edit). The OTel run span carries `taicho.plan.handle` and `taicho.plan.items.*` — Plan 17's
thesis made concrete: an agent can ask its own backend which items keep failing verification.

## 8. Testing

- `store/plans.test.ts` — version dedup, wx race, fold precedence, rejected-loses-the-fold, boot reconcile.
- `core/plan-inject.test.ts` — identity when no plan; flat context across 20 iterations; compaction orthogonality.
- `core/run.test.ts` — engine ticks from the child's real outcome; verification-backed green; the refused
  attempt is recorded and does not win; `dropped` requires a note; a worker gets no plan tools.
- `core/otel.test.ts` — plan attributes on a real exported span; absent when there is no plan.
- `ui/PlanPanel.test.tsx` + `ui/App.test.tsx` — Layer 1, per the rule that UI wiring never ships on typecheck alone.
- `scripts/otel-verify.ts` — Layer 4b: a real OTLP endpoint, a real compiled binary.

Gates: `bun run typecheck` · `bun test` (730) · `bun run build` — all green.
