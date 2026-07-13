# Plan 20 — Hardening

**Date:** 2026-07-13
**Status:** approved (design), not yet built
**Topic:** Fix the confirmed defects from the 2026-07-13 state review. No new features — make
existing claims true.

## 0. Origin and scope rule

A full-codebase review (63-agent survey + adversarial verification, 2026-07-13) confirmed a short
list of real defects and unwired seams. This plan fixes them. The scope rule: **anything with real
feature surface is OUT** and recorded as a follow-up — background verification (§1's rejected
option), task retry/resume, a schedule daemon, coaching conditional recall, exemplars,
distribution. Hardening PRs must not grow design surface.

## 1. Plan-item settle for background tasks (the Plan 18 bug)

`dispatch_task` binds a plan item `in_progress` with `boundRunId = taskId` (`tools.ts:566-570`),
and nothing ever settles it: `settlePlanItemForTask` (`store/plans.ts:162`) has **zero production
callers** — `tools.ts:565`'s own comment claims the REPL settle path calls it; it doesn't. A plan
item fulfilled by a background task stays `in_progress` until the next boot's `reconcilePlans`
wrongly marks it `interrupted`.

**Fix:** App's `settleTask`/`failTask` (`App.tsx:474-487`) — the settle owner today — call
`settlePlanItemForTask(ws, taskId, status)`, mapping task outcome → item status:
`completed → done`; `failed`/`cancelled`/`interrupted` → `failed`. Refresh the pinned plan panel
after the settle (re-read current plan state and push, the same way the boot seed does).

**`criteria` on the background path — decided: honesty over feature.** `dispatch_task` advertises
"an independent check + one retry, exactly as for delegate_task" (`tools.ts:530,536`), but no
checker ever runs at settle and criteria isn't even stored on the task record. Two options were
considered:

- (a) run the Plan 06 checker at settle — REJECTED for this plan. It is a real feature: off-turn
  model resolution, spend attribution for a call belonging to no live run, and retry semantics that
  don't map to a detached task. It deserves its own design.
- (b) **make the tool description honest** — criteria rides into the child's prompt
  (`prompt.ts:140`) and is NOT independently verified on the background path. CHOSEN.

The checkbox still cannot lie: the item settles from the task's REAL outcome. It just isn't
checker-gated until (a) ships as its own plan.

## 2. The reopened idle timer: keep it, fix its three defects

The reopen was justified — commit `7526ca8`: the transport deadline (`request-timeout.ts`)
structurally cannot catch a stream that hangs *and ignores the fetch abort*, so a chunk-idle timer
raced against `consumeStream`, disarmed during tool execution, is the correct backstop. The
alternative (a body-idle `TransformStream` at the transport layer) was considered and REJECTED:
mid-stream errors are not retried by the AI SDK either, so it buys nothing over fixing the timer,
with a bigger blast radius across every provider path.

Three defects, three fixes (`loop.ts:215-308`):

1. **`toolExecuting` boolean → an executing COUNTER.** Increment on `tool-call` chunk, decrement on
   `tool-result`, re-arm the timer only at zero. Today the first tool-result re-arms while a second
   tool still executes — a parallel tool slower than `timeoutMs` with no intervening chunks is
   falsely killed, the exact bug class Plan 12 existed to remove.
2. **Clear the timer on the error path.** Cleanup only runs after a successful race
   (`loop.ts:308`); a throw leaks an armed `setTimeout` per failed iteration. Move cleanup to a
   `finally`.
3. **Fix the lying comments.** `loop.ts:19-25` ("there is NO model-call watchdog here anymore")
   sits directly above the watchdog; `otel.ts:1-13` still describes `experimental_telemetry` and
   `/trace`; `compaction.ts:15-17` still says Phase 3 boot-replay compaction "is not yet built".

Known-and-accepted: the idle timeout fails the call without an SDK retry (it fires mid-consumption,
where retry would mean double-generation). That is semantics, not a bug; the spec records it so
nobody "fixes" it into a hand-rolled retry.

## 3. Focus-ring / Enter desync (likely wrong-run drill-in)

The focus ring highlights `allBlocks[focusIndex]` (settling-first order, foreground root EXCLUDED)
while Enter opens `[...blockFeed.keys()][focusIndex]` (insertion order, root INCLUDED — root's own
deltas populate `blockFeed`), and ↑↓ bounds use `blockFeed.size` (`App.tsx:298-313` vs `342-347`
vs `1125-1131`). When root streamed before delegating, highlighting block 0 and pressing Enter
opens root's run, not the highlighted child.

**Fix:** ONE collection. Compute the rendered block list once (the same list `AgentBlock` rendering
consumes); `focusIndex` indexes it, Enter opens `rendered[focusIndex].runId`, ↑↓ bound is
`rendered.length`. Layer-1 `App.test.tsx` coverage is REQUIRED (root streams → delegates → focus →
Enter opens the CHILD's operation view) — this is exactly the class of UI-wiring bug our testing
rule exists for.

## 4. A checker that never ran must not pass

A checker whose model call errored or was cancelled parses `"[error]"`/`"[cancelled]"` into a
non-blocking advisory PASS (`verification.ts:77-81`, acknowledged in-code). A squad relying on
`criteria` gets silent passes during a provider outage.

**Fix:** detect the checker-never-ran case and produce
`{ pass: false, reasons: ["checker unavailable: <error>"] }` with a new optional
`checkerError: true` on `VerificationRecord` (schema-additive; old records parse). **Skip the
retry** when `checkerError` — the retry exists to fix the CHILD's output, and re-running the child
is pointless when the judge is down; it would burn a work item for nothing. The parent model sees
the verdict + reason and decides. Trace/annotation recording stays as today.

## 5. Roster reindex: hand-edits must take effect

The registry full reindex runs only when the index is empty or the librarian row is missing
(`index.tsx:67`), so editing `agents/<id>/agent.md` to declare `team: news` — the DOCUMENTED
membership mechanism — leaves `registry.team` stale until `taicho.db` is deleted. `membersOf`, team
routing, `validateTeams`, and per-team model resolution all read the stale rows.

**Fix:** drop the condition — always `await reindex(ws, db)` at boot. It is a file scan over
`agents/*/agent.md` for a roster measured in tens; files are canon and the registry is a derived
index, so unconditional rebuild is the discipline the rest of boot already follows
(`reindexKnowledge`/`reindexSkills`/`reindexTasks`/`reindexPlans` are all unconditional). Add
`/agents reindex` for mid-session hand-edits, mirroring `/kb reindex`.

## 6. SIGTERM: one composed handler

`index.tsx:149` registers `process.on("SIGTERM", () => { void telemetry.shutdown(); })` — neither
awaited nor exiting. With MCP enabled it races the MCP handler's `process.exit(0)` (spans drop);
with MCP disabled no handler exits, so SIGTERM is swallowed and the REPL keeps running.

**Fix:** one handler: close MCP connections, `await telemetry.shutdown()`, `process.exit(0)`.
Registered once at boot regardless of which subsystems are enabled (each step no-ops when its
subsystem is off).

## 7. Cleanup sweep (each trivial, all real)

- Delete `e2e/scenarios/trace-inspector.ts` + `live-waterfall.ts` — both import the
  Plan-17-deleted `core/trace-tree` and fail at import; the surfaces they drove no longer exist.
- Drop the phantom `search_knowledge` from `untrustedSources` (`tools.ts:875`) — no tool by that
  name is ever built (`recall` is listed separately and correctly arms the guard).
- Atomic task-file writes: `tasks/*.json` uses plain `writeFileSync` (`task-state.ts:72-76`);
  switch to the temp+rename idiom `schedules.ts:29-35` already uses. A crash mid-write currently
  corrupts the file, which `reindexTasks` then silently skips — the record vanishes from the index.
- Fix the stale `SquadPanes.resolveLayout` comment ("Panes hide in bar/waterfall mode" —
  `waterfall` is no longer a ViewMode).

## 8. Testing & ship shape

Per item: colocated `bun:test`; Layer-1 `App.test.tsx` for §1 (settle updates the plan panel;
boot no longer marks a completed background task's item `interrupted`) and §3 (the wrong-run
repro). Gate: `bun run typecheck` + `bun test` + `bun run build`.

Ships as **three PRs** off worktrees, per the `plans/tasks.md` operating contract:
1. engine — §2 idle timer + §4 checker honesty
2. REPL — §1 settle + §3 focus ring + §5 reindex + §6 SIGTERM
3. cleanup — §7 (+ the comment fixes from §2.3 if not already carried by PR 1)

## 9. Explicit follow-ups (recorded, not designed here)

Background verification at settle (§1a), task retry/resume, schedule daemon (fires without the
REPL), `/tasks` detail view + settle summaries, headless dispatch wiring
(`headless.ts:212-231` wires no dispatch/awaitTask), Esc-quit draining or warning about in-flight
background tasks, coaching conditional recall (the dormant `coaching/retrieval.ts` seam),
exemplars, distribution (#9: release pipeline, `--version`, hosted install.sh).
