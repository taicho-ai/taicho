# Reference — Async & Parallel Execution

Design detail for **Plan 04**. The Phase 0 forks are **closed (2026-07-04, all per
recommendation)** — see §4. It captures the problem, what the code actually does today, the
decided model, and the reasoning.

---

## 1. The problem

Today the squad is actually a **call stack**. A user turn is one blocking cascade:
`submit → executeRun(root) → delegate_task → executeRun(child) → …` — every frame awaits the one
below it, and the captain sits behind a spinner until the whole tree returns. Agents are
*persistent* (identity, memory, policies survive) but not *autonomous* — they only exist inside a
keypress.

What's missing, in increasing order of ambition:

1. **Detached work** — "kick this off, I'll keep talking / check back later."
2. **Real fan-out** — a researcher and a fact-checker running at the same time *by design*, not as
   an accident of one model turn.
3. **Recovery** — work that survives a crash or an interrupt instead of evaporating.
4. **Triggers** — runs that start without a keypress (schedules, watches). Deferred to v2.

## 2. Current state (evidence from the code)

- **The whole cascade is synchronous.** `delegate_task` (`src/core/tools.ts:65`) awaits
  `ctx.runChild(...)`, which awaits a recursive `executeRun` (`src/core/run.ts:164`). The UI's
  `submit()` awaits the root run. Nothing detaches.
- **Parallelism exists only inside one model turn's tool batch.** If the model emits several
  `delegate_task` calls in a single response, the AI SDK executes them concurrently — that is why
  `reserveRunId` exists ("concurrent same-target delegations in one model turn can't collide",
  `src/core/run.ts:142`). But the turn still blocks until *all* of them settle, and the shared
  mutable `RunContext` (`ctx.childSpend`, `ctx.workItems`, `deps.runCounter`) is only safe because
  Bun is single-threaded and the mutations are synchronous between awaits.
- **Steering is untargeted.** One global `steerQueue` (`src/ui/App.tsx:130`) is drained by
  whichever run's loop polls `pollSteer` next (`src/core/loop.ts:104`) — in a cascade, a correction
  lands on a random descendant. In a *parallel* world this goes from quirk to bug.
- **Nothing survives a death.** Traces, transcripts, and finals are written only at run **end**
  (`src/core/run.ts:299-303` — even `transcript.jsonl` is buffered in `LoopResult.transcript` and
  flushed after the loop returns). Kill the process mid-cascade and the only evidence is
  `input.json` + the reserved-id placeholder. `[interrupted]` is terminal; there is no resume.
- **A seed already exists.** `src/store/task-state.ts` (uncommitted) persists a per-turn
  `tasks/<taskId>.json` — currently write-only and UI-written. The context-hygiene audit flagged
  parts of it for cutting; **a task that outlives a turn is exactly the seed of this capability** —
  don't trim it until this plan's Phase 0 is decided.

## 3. Proposed model

### 3a. A Task is the unit of detached work (recommended)

Promote `task-state.ts` from write-only audit record to a real **task queue** entry:

```
Task { id, goal, agent, status: queued|running|done|failed|cancelled,
       resultRef (artifact id / final.md path), rootRunId, created, updated }
```

- Tasks are **persistent** (`tasks/*.json` + a DB index) so they survive restarts and are listable.
- A synchronous chat turn is just a task the captain happens to be watching. One execution path,
  two consumption modes.

### 3b. Tools — dispatch / check / await

- `dispatch_task({ to, goal, context?, criteria? })` → returns `{ taskId }` **immediately**. The
  child cascade runs off-turn (same `executeRun`, same budgets, `triggeredBy: taskId`).
- `check_task({ taskId })` → status + summary (never the full payload — hand-off stays by
  reference, per Plan 01).
- `await_task({ taskId })` — bounded await for when the parent genuinely needs the result to
  continue. This is `delegate_task`'s semantics, kept for the tight-coupling case.
- Captain surface: `/tasks` list; completion notice injected into the REPL when a background task
  settles ([?] Phase 0: notify-only vs auto-inject a summary turn).

### 3c. Concurrency discipline

- **A per-request concurrency cap** (e.g. `maxConcurrentRuns`) joins the budget block in
  `AgentDef.budgets` (`src/schemas/agent.ts:11`) — model proposes, config disposes, consistent with
  the existing cap philosophy.
- Audit the shared-mutable seams before real concurrency: `runCounter`, `childSpend`,
  `globalPolicyCache`, SQLite access. Bun is single-threaded so races are interleavings at await
  points, not data races — but `delegationGuard`'s check-then-act on `runCounter` is exactly such
  an interleaving.

### 3d. Targeted steering

Replace the single global queue with **per-run steer queues** keyed by runId, plus routing:
plain steer text → root run; `@agent …` steer → the named agent's active run. The waterfall
(Plan 02) and `/tasks` give the captain the visibility to know *what* to steer.

### 3e. Recovery & resume

- **Flush evidence incrementally.** Append to `transcript.jsonl` as events happen (move
  `appendRunTranscript` inside the loop) instead of at run end — this is also what Plan 02's live
  mode (v2) needs, and it makes a crash forensically legible.
- **Checkpoint the message array** per iteration (it is already the loop's only real state), so an
  interrupted/crashed run can resume from the last completed iteration.
- On boot: reconcile `tasks/` — anything `running` is marked `interrupted`; [?] Phase 0 fork:
  auto-resume vs report-and-ask (recommended: **report-and-ask** first; auto-resume once trusted).

## 4. Phase 0 decisions (closed 2026-07-04)

| # | Decision | Decided |
|---|----------|----------------|
| 1 | Task model: detached runs vs persistent task queue | **Persistent queue** — evolve `task-state.ts`, don't cut it. |
| 2 | Result delivery: notify-only vs auto-inject summary turn | **Notify + `/tasks`**; auto-inject later if it proves annoying to pull manually. |
| 3 | Keep `delegate_task` alongside `dispatch_task`? | **Yes** — await-semantics stay for tight coupling; dispatch is additive. |
| 4 | Resume: automatic vs report-and-ask on boot | **Report-and-ask** first. |
| 5 | Where the cap lives | `budgets.maxConcurrentRuns`, per agent, config-disposed. |

## 5. Synthesis with the other plans

- **Plan 01 (artifacts)** — background tasks *must* return by reference; a `dispatch_task` result
  is an artifact handle + summary, never a payload. Ship Plan 01 Phases 1–3 first.
- **Plan 02 (waterfall)** — incremental transcript flushing (3e) is shared infrastructure with
  live mode; the waterfall is how the captain watches a background cascade.
- **Plan 06 (verification)** — `criteria` on `dispatch_task` is the same field Plan 06 adds to
  `delegate_task`; a failed verification on a background task is a natural retry-in-place.
- **Context-hygiene audit** — its "cut `verifiedClaims` / trim task-state" recommendations are
  **paused** pending this plan's Phase 0 (see the note added there).

## 6. Explicitly out of scope / YAGNI (for now)

- Multi-process / worker-thread execution — Bun single-threaded interleaving is enough; the
  bottleneck is model latency, not CPU.
- Cron-style schedules and file/event watchers (v2, Phase 6).
- Inter-agent messaging outside the delegation tree (agent A pinging agent B mid-run).
