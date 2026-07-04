# Plans — Task Index

A running, structured list of ideas broken into tasks. Each plan has a short task list here
and a detail doc under `reference/`. This file is the index; `reference/` carries the depth.

Status legend: `[ ]` open · `[~]` in progress · `[x]` done · `[?]` open **decision** (needs a call before build)

## How these plans get built (read first if you're an implementing agent)

**[`reference/agent-execution-workflow.md`](reference/agent-execution-workflow.md)** — the
operating contract. Short version: one workflow agent per plan (or phase group), each in **its
own git worktree** branched off `main` (`git worktree add ../taicho-plan-NN -b plan-NN-<slug>
main` + `bun install`; the repo root is the captain's LIVE workspace — never work or run there),
implement per the plan + reference doc (all Phase 0 decisions are closed — don't re-open them),
**test your own work** (typecheck + `bun test` + Layer-1 for UI + the evidence harness for video
proof), flip your checkboxes here in the same PR, and ship **one PR per unit of work** with the
evidence manifest pasted in. Suggested PR order: **Plan 11 first** (so later PRs can prove
themselves), then 01 (Ph 1–3), then 02 Ph 0 + 10 Ph 1 together, then the rest as interlocks
clear. Review happens against the plan docs, in the captain's main session.

---

## Plan 01 — Hand-Off Artifacts

**Detail:** [`reference/hand-off-artifacts.md`](reference/hand-off-artifacts.md)

**One line:** Give agents a real channel to hand work products to each other (and to the human)
**by reference**, so heavy content lives on disk as addressable artifacts instead of polluting the
shared context window.

**Why now:** `write_artifact` exists but is *write-only* — there is no `read_artifact`. Agents
literally cannot consume each other's output. The only hand-off channel today is `delegate_task`
returning the child's full text into the parent's context. That is the pollution we want to kill.

### Phase 0 — Decisions (closed 2026-07-04 — went with recommendations)
- [x] **Model:** structured artifacts (typed, versioned, ID-addressable, provenance) vs raw files in a folder. *Decided (2026-07-04): structured.*
- [x] **Topology:** shared addressable store **+** explicit delegation handles. *Decided (2026-07-04): both, layered.*
- [x] **Resources vs artifacts:** role-tag inputs (human/ingest-provided) separately from outputs, or one flat pool. *Decided (2026-07-04): one store, role-tagged.*
- [x] **Feedback scope for v1:** include versioning + annotations now, or ship read/hand-off first and layer feedback after. *Decided (2026-07-04): read + hand-off first, feedback next.*

### Phase 1 — Artifact model & store
- [x] Define an `Artifact` zod schema in `src/schemas/` (id, title, type, producer agent, runId, version, parents[], summary, location, created). **Payload-agnostic** (see reference §5b): body is opaque bytes, `type` is a free-form tag, and `location` is local-file *or* external-ref (MCP-fronted systems) — never assume text.
- [x] Add `src/store/artifacts.ts`: addressable, versioned, **immutable-per-version** store over `artifacts/`, with a manifest/index for lookup by id.
- [x] Keep back-compat: `trace.artifacts` continues to record references (ids/paths).

### Phase 2 — Tools (the missing read half)
- [x] `save_artifact` — structured write; pulls provenance from `ctx` (agentId, runId, parent artifacts). Replaces/wraps today's `write_artifact`.
- [x] `read_artifact` — fetch an artifact by id. **This is the missing pickup.**
- [x] `read_artifact` must be **size-capped, summary-first** (metadata + summary by default; body by explicit ask, truncated with a marker) — an uncapped read re-creates the context pollution this plan exists to kill.
- [x] `list_artifacts` — discover artifacts; filter by producer / type / tag.
- [x] Wire into `toolsForAgent`, default agent tool grants (`roster.ts`), `prompt.ts` guidance, and a seed skill.

### Phase 3 — Hand-off by reference
- [x] `delegate_task`: add `inputArtifacts: string[]` — resolve and pass handles to the child instead of inlining content.
- [x] Child return shape: `outputArtifacts + summary` instead of a full-text payload; parent context receives **handles + summary**, not the body.
- [x] Extend `RunTrace` to record `inputArtifacts` / `outputArtifacts` → builds the hand-off graph (mirrors `delegatedOut`).

### Phase 4 — Feedback & revision
- [ ] Versioning: a `save_artifact` revision creates a new version linked to its parent.
- [ ] Annotations/feedback on an artifact (from an agent or the human) that becomes the input to a revision run.
- [ ] Connect to coaching/policy — `policy.artifact` currently keys on a path; move to an artifact id.
- [ ] UI: surface artifacts to the captain (view / annotate / approve).
- [ ] **Hook for Plan 06:** a verification verdict is an annotation like any other — same annotation → revision path (see `reference/delegation-verification.md` §3c).

### Phase 4b — Retention & GC
- [x] Retention policy: immutable-per-version + heavy media = unbounded disk. *Decided (2026-07-04): keep-latest-N-versions + age-based archive, config-disposed; GC only unreferenced versions (nothing in a trace/policy/task).* 
- [ ] `gc_artifacts` maintenance path (or `/artifacts gc`) honoring the policy; never breaks an id referenced by a trace, policy, or task.

### Phase 5 — Context-hygiene synthesis (related pending work)
**Detail:** [`reference/context-hygiene-audit.md`](reference/context-hygiene-audit.md)
- [x] Reconcile `thread.jsonl` vs `conversation` ledger/context source-of-truth (decided 2026-07-04: option **C**).
- [x] Move turn audit (ledger + context + task) into the engine (`run.ts`), guarded by `triggeredBy === "user"`.
- [ ] De-duplicate the two ~30-line audit blocks in `App.tsx submit()` into one seam.
- [ ] Cut dead/no-op code: `modelMessageContent` (unused identity no-op), `statusFromOutcome` (identity). (`verifiedClaims`: decided 2026-07-04 in Plan 06 — rename → `verifications[]` and populate, not cut.)
- [ ] Make replayed context carry artifact handles, not payloads (this is where the two halves meet).

### Phase 6 — Tests & docs
- [x] Unit tests for the artifact store: immutability, versioning, provenance/lineage.
- [x] Layer-1 `App.test.tsx` coverage for save/read/list + a delegation hand-off.
- [ ] Real-binary e2e (tui-test): agent A produces an artifact, agent B consumes it **by reference**, parent context stays thin.
- [ ] Update `TESTING.md`, `CLAUDE.md`, `prompt.ts` workspace-layout notes. *(partial: `prompt.ts` root workspace-layout note updated for the artifact store; `TESTING.md`/`CLAUDE.md` deferred.)*

---

## Plan 02 — Observability Waterfall

**Detail:** [`reference/observability-waterfall.md`](reference/observability-waterfall.md)

**One line:** An in-terminal, interactive trace inspector — a LangSmith-style **waterfall**: a span
tree with absolute-time bars, drill-into-span for inputs/outputs/tokens/cost/coaching-ledger. Native
to the terminal, **no external service**.

**Why:** the recent evidence work (transcript / ledger / task / child-runs / failure) is **write-only
— nothing reads it back**. The waterfall is the *reader* that lights up nearly every observability
gap at once (see `reference/observability-waterfall.md` §2 for the gap→feature mapping).

**Decisions closed (brainstorm):**
- Interactive focus-pane inspector; **post-hoc first**, live deferred to v2.
- **Absolute-time Gantt bars** with a min-width floor (≥1 cell) + duration-adaptive scale.
- **Run-rooted** traces: one `triggeredBy: "user"` run + its delegation subtree (= one LangSmith trace).
- `/trace` with no arg opens the **latest** run.

### Phase 0 — Span capture gaps (small adds for accurate bars)
- [ ] Wrap tool `execute()` to emit tool-span **start/end** in `transcript.jsonl` (today only the emit ts exists).
- [ ] Time approval / `ask_human` waits as `approval` spans — **core, not optional**: approval waits dominate wall-clock in this system; a waterfall without them misattributes the wait to whatever span contains it.

### Phase 1 — Span model & derivation (pure, testable)
- [ ] Define the `Span` type — `kind: run|llm|tool|approval`, `parentId`, `startMs`/`endMs`, `tokens`/`cost`, `status`, `error`, `detail`.
- [ ] `deriveTrace(rootRunId)`: walk `delegatedOut` recursively (`readTrace`) → run spans; read each run's `transcript.jsonl` → llm/tool spans; link a `delegate_task` tool span to its child run span.
- [ ] Roll up tokens/cost onto run spans (reuse `aggregate`).
- [ ] Unit tests over fixture traces + transcripts.

### Phase 2 — Waterfall layout (pure)
- [ ] Timeline scale: map `[traceStart, traceEnd]` → N columns; **min-width floor** ≥1 cell/bar; adaptive to total duration.
- [ ] Row render: indent by depth + tree glyphs, status icon, bar, duration, tokens.
- [ ] Expand/collapse state + visible-rows computation.
- [ ] Unit tests: tiny spans get the floor, nesting indent, collapse hides subtree.

### Phase 3 — Interactive inspector (Ink)
- [ ] `TraceInspector` component; owns the keyboard via the existing `cardKeyRef` pattern while open.
- [ ] Keys: `↑↓` move · `→/←` expand/collapse · `⏎` open detail · `q`/esc close.
- [ ] Selected-span summary line pinned at the bottom.
- [ ] Detail view per kind: **llm** (assembled prompt from `input.json`, response, tokens, finish reason) · **tool** (args/result/error) · **run** (outcome, rolled-up cost, `notes`, **coaching ledger: policies/KB/skills retrieved·applied·skipped**).
- [ ] Layer-1 `ink-testing-library` tests: render, nav, drill-in, error span.

### Phase 4 — Command surface & integration
- [ ] Upgrade `/trace`: no-arg → latest run; `<id>` → that run. (Replaces today's shallow one-liner.)
- [ ] Post-run inline hint: *"/trace to inspect."*
- [ ] `/runs` stays the picker; add duration to its rows.
- [ ] Update `COMMANDS` + `/help`.

### Phase 5 — Tests & docs
- [ ] Real-binary e2e (tui-test): run a delegation, open `/trace`, assert the tree renders + a drill-in works.
- [ ] Update `TESTING.md`, `CLAUDE.md` (an observability section), `prompt.ts` if needed.

### Phase 6 — v2 (deferred)
- [ ] **Live mode:** stream spans into a redrawing waterfall as the run executes, replacing the flat `↳` breadcrumbs; reuse the same span tree.
- [ ] **Task-level traces** spanning multiple user turns.

**Covers observability gaps 1–7** (write-only evidence, shallow `/trace`, no tree, hidden aggregation,
thin failure diagnosis, "is it done?", "why did it do that?"). **Residual → Plan 03.**

---

## Plan 03 — Structured logging & headless surface *(placeholder)*

Residual observability gaps the waterfall does **not** cover, plus the headless half it enables:
- [ ] **Structured file logging** that doesn't fight Ink — replace scattered `console.error/warn`
      (which corrupt/​vanish under the full-screen TUI) with a leveled, file-captured `taicho.log`;
      a general `--verbose`/debug mode (today only codex-specific `TAICHO_DEBUG`).
- [ ] **Documented event schema + live tail** for headless/external observers (the e2e harness polls
      files by hand today).
- [ ] **Headless run mode** — a `taicho run "<goal>"` (or programmatic) entry that drives `executeRun`
      without Ink. `RunDeps` is already the seam (model, approval, onStep are all injectable); the only
      real design point is the approval channel (auto-reject / policy-driven / prompt-on-stdin). Also
      makes real-binary e2e far cheaper, and is a prerequisite for Plan 04's scheduled triggers (v2).

---

## Plan 04 — Async & Parallel Execution

**Detail:** [`reference/async-parallel-execution.md`](reference/async-parallel-execution.md)

**One line:** Turn the squad from a blocking call stack into a concurrent one — detached background
tasks, real fan-out, targeted steering, and runs that survive a crash.

**Why:** today a user turn is one synchronous cascade; the captain blocks behind a spinner and
agents only exist inside a keypress. Parallelism exists solely as an accident of one model turn's
tool batch. Nothing survives a process death (traces flush at run *end*). This is the biggest
capability hole for the "squad" framing — persistent agents, but not autonomous ones.

**Interlocks:** ship after Plan 01 Phases 1–3 (background results must return **by reference**);
shares incremental-transcript flushing with Plan 02's live mode; `dispatch_task.criteria` is Plan
06's field. **Pauses** the context-hygiene audit's "trim task-state / cut `verifiedClaims`" cuts
until Phase 0 here is decided.

### Phase 0 — Decisions (closed 2026-07-04 — went with recommendations)
- [x] **Task model:** detached runs vs a persistent task queue. *Decided (2026-07-04): persistent queue — evolve `task-state.ts`, don't cut it.*
- [x] **Result delivery:** notify-only vs auto-inject a summary turn when a background task settles. *Decided (2026-07-04): notify + `/tasks` pull.*
- [x] **Resume on boot:** auto-resume interrupted tasks vs report-and-ask. *Decided (2026-07-04): report-and-ask first.*
- [x] **Cap location:** `budgets.maxConcurrentRuns` per agent (config disposes). *Decided (2026-07-04): yes.*

### Phase 1 — Task model & store
- [x] Promote `task-state.ts`: `Task` schema (id, goal, agent, status queued|running|done|failed|cancelled|interrupted, resultRef, rootRunId, timestamps) + DB index; survives restarts. *(evolved `TaskState`: added queued/cancelled statuses + kind/agent/goal/resultRef/summary; files under `tasks/` canon + rebuildable `tasks` DB index (migrate v5, `reindexTasks`). "done" kept as the existing "completed".)*
- [x] `/tasks` command: list + status + cancel. *(default view hides completed chat turns; shows background + in-flight; `/tasks cancel <id>` aborts a running task or drops a queued one.)*

### Phase 2 — Background execution
- [x] `dispatch_task` tool — fire-and-forget; returns `{ taskId }` immediately; cascade runs off-turn via the same `executeRun` (`triggeredBy: taskId`).
- [x] `check_task` / `await_task` tools (status+summary+handle only — reference hand-off, never payload; summary capped at 500 chars).
- [x] REPL notification when a background task settles.

### Phase 3 — Real fan-out
- [x] `maxConcurrentRuns` budget + enforcement. *(added to `AgentDef.budgets` + config `PartialBudgets`; `TaskScheduler` is a per-agent semaphore — over-cap dispatches sit `queued` and the queue pumps on settle.)*
- [x] Audit shared-mutable seams under interleaving (`runCounter` check-then-act in `delegationGuard`, `childSpend`, `globalPolicyCache`, SQLite). *(audited: Bun is single-threaded so each `execute()` runs to completion between awaits; the work-item + guard check-then-act is synchronous at execute entry — proven by the interleaved-dispatch test. `childSpend` folding is synchronous. Real concurrency vector is background dispatch, gated by the scheduler.)*

### Phase 4 — Targeted steering
- [x] Per-run steer queues keyed by runId (replaces the single global `steerQueue`). *(`RunDeps.pollSteerFor` bound to each run's id in `run.ts`; App holds a `steerRoutes` Map<runId, steers[]>.)*
- [x] Routing: plain steer → root; `@agent` steer → that agent's active run. *(App tracks `activeRuns` + `foregroundRootRef` via onRunStart/onRunEnd.)*

### Phase 5 — Recovery & resume
- [x] Flush `transcript.jsonl` incrementally (append per event, not at run end) — shared with Plan 02 live mode. *(`loop.ts` `onEvent`; `run.ts` appends live and drops the post-loop re-append.)*
- [~] Checkpoint the loop's message array per iteration; resume an interrupted run from the last completed iteration. *(checkpoint WRITING done — `checkpoint.json` per iteration via `loop.ts` `checkpoint`; automatic resume EXECUTION deferred, consistent with the closed Phase 0 "report-and-ask first" decision.)*
- [x] Boot reconciliation of `tasks/`: `running`/`queued` → `interrupted`, then report-and-ask per Phase 0. *(`reconcileTasks` on boot → startupNotice lists the interrupted tasks; captain reviews via `/tasks`.)*

### Phase 6 — v2 (deferred)
- [ ] Scheduled/triggered runs (cron-style, watches) — needs Plan 03's headless mode. **DEFERRED (v2).**

### Phase 7 — Tests & docs
- [x] Unit: task store lifecycle; steer routing; delegationGuard under interleaved dispatches. *(`task-state.test.ts`, `tasks.test.ts` (scheduler), `run.test.ts` (dispatch wiring/guards/steer/checkpoint), `tools.test.ts` (dispatch/check/await), `loop.test.ts` (onEvent/checkpoint).)*
- [x] Layer-1 `App.test.tsx`: dispatch → keep chatting → notification → `/tasks`.
- [ ] Real-binary e2e: kill mid-run → boot reconciliation reports the interrupted task. **DEFERRED** (stretch goal; agent-flow evidence stays green; the bespoke kill-mid-run tape not built this pass).
- [x] Update `TESTING.md`, `CLAUDE.md`, `prompt.ts` delegation guidance.

---

## Plan 05 — Context Compaction

**Detail:** [`reference/context-compaction.md`](reference/context-compaction.md)

**One line:** Nothing in taicho ever makes context smaller — bound in-run message growth and boot
replay before long sessions die of window overflow.

**Why:** the loop appends every tool round-trip for up to 30 iterations; `thread.jsonl` replays
every completed turn forever. No summarization, no trimming, no warning. This is the failure mode
that bites first in real use. Plan 01 Phase 5 keeps payloads out; this bounds the coordination
layer itself. **Depends on** Plan 01 Phase 5's single write seam (`recordTurnOutcome`) landing
first for the cross-turn half.

### Phase 0 — Decisions (closed 2026-07-04 — went with recommendations)
- [x] **In-run fold:** deterministic (truncate old tool results, keep call names + key lines) vs LLM-summarized. *Decided (2026-07-04): deterministic first.*
- [x] **Threshold:** per-model window table + `defaults.compactAt` override, default ~70%. *Decided (2026-07-04): yes.*

### Phase 1 — Measure
- [ ] Cheap token estimate (chars/4) over assembled system + messages; record `contextTokens` on the trace; surface in the waterfall LLM-span detail (Plan 02).

### Phase 2 — In-run compaction
- [ ] When next-call estimate crosses the threshold: fold oldest tool round-trips into one compact summary message; keep system, original brief, and recent N iterations verbatim.
- [ ] Emit a `compaction` event to `transcript.jsonl` — compaction must be visible in the trace.

### Phase 3 — Cross-turn compaction
- [ ] Boot replay = rolling summary + recent-K-turns tail; older turns collapse into a persistent conversation summary.
- [ ] Write the summary through the same `recordTurnOutcome` seam (ledger stays append-only truth; compaction changes what *replays*, never what is *recorded*).

### Phase 4 — Tests & docs
- [ ] Unit: estimator; fold correctness (kept-verbatim window, summary content); threshold trigger.
- [ ] Loop test: long tool-heavy run compacts instead of exhausting; transcript records it.
- [ ] Update `TESTING.md`, `CLAUDE.md`.

---

## Plan 06 — Delegation Verification (quality loop)

**Detail:** [`reference/delegation-verification.md`](reference/delegation-verification.md)

**One line:** Delegation stops being blind trust — acceptance criteria ride the brief, a bounded
check runs on return, one retry with feedback, and failures surface instead of silently propagating.

**Why:** `delegate_task` returns `{ result: child.text }` straight into the parent's context;
"completed" means the loop ended, not that the goal was met. The only quality loop today runs
through the human after the fact (coaching). **Resolves** the audit's open `verifiedClaims`
question (recommended: rename → `verifications[]` and populate, or cut — decided in Phase 0 here).

### Phase 0 — Decisions (closed 2026-07-04 — went with recommendations)
- [x] **Verifier:** independent checker call vs parent self-check vs dedicated critic agent. *Decided (2026-07-04): checker call; critic-agent later opt-in.*
- [x] **Retry policy:** one bounded retry with verdict feedback, then surface the failed verdict alongside the result. *Decided (2026-07-04): yes.*
- [x] **`verifiedClaims`:** rename → `verifications[]` and populate, or cut. *Decided (2026-07-04): rename + populate.*

### Phase 1 — Criteria in the brief
- [x] `delegate_task` (and Plan 04's `dispatch_task`) gains `criteria?: string`; rides the brief into the child's system prompt via `assemble`. *(delegate_task done + CRITERIA line in the brief block; `dispatch_task` is Plan 04's tool — doesn't exist yet, deferred to that plan.)*

### Phase 2 — The verification step
- [x] On child return with `criteria`: checker call → `{ pass, reasons[] }` before the result reaches the parent's context. *(`src/core/verification.ts` — independent model call on the delegating agent's resolved model, via `runLoop` with an empty toolset.)*
- [x] On fail: one retry (goal + verdict reasons as feedback), consuming `maxWorkItemsPerRequest`; second fail returns the result **with the failed verdict attached**.
- [x] Record verdicts on the trace (`trace.verification`) + transcript → waterfall span + ledger answer to "why did it retry?".

### Phase 3 — Artifact & coaching tie-in
- [ ] Verdict = annotation on the artifact version (Plan 01 Phase 4's same annotation → revision path).
- [ ] Repeated failure patterns feed coaching (propose a policy note).
- [x] Populate `verifications[]` on the task (per Phase 0 decision). *(renamed `verifiedClaims` → `verifications[]` in `task-state.ts`; `updateTaskFromTrace` populates it from `trace.verification` on root + children.)*

### Phase 4 — Tests & docs
- [x] Unit: pass path (no extra calls when no criteria), fail→retry→pass, fail→fail→surfaced verdict, budget consumption.
- [x] Layer-1: captain sees the attached failed verdict.
- [x] Update `prompt.ts` delegation guidance, `TESTING.md`, `CLAUDE.md`.

---

## Plan 07 — Unified streaming *(placeholder)*

Only the Codex path streams (`loop.ts` `codexBackend` branch); Anthropic / OpenAI / OpenRouter use
plain `generateText` — no live deltas, so the streaming-markdown UI only lights up for subscription
users.
- [ ] Unify the loop on `streamText` for every provider (the codex branch already proves the
      drain-to-completion shape); delete the two-branch split.
- [ ] Verify usage/cost/toolCalls parity per provider (OpenRouter `providerMetadata` arrives on the
      streamed path too) and that `guardModelCall`'s idle watchdog gets chunk pings everywhere.

## Plan 08 — Security hardening *(placeholder)*

Known-v1 posture that should become deliberate instead of implicit:
- [ ] **Per-agent MCP tool grants** — today every connected server's tools go to every agent
      (`tools.ts` "gatekeeping can come later"); make it an allowlist per agent (like `agent.tools`).
- [ ] **Injection-aware guard** — an agent that has ingested untrusted content (read_url / MCP
      results) and holds `run_command` is a classic injection→execution chain; at minimum, force
      approval (ignore dcg `allow`) for commands proposed after untrusted content entered the run.
- [ ] **Sandbox-then-escalate** for `run_command` (the documented future hardening in the
      root-capabilities spec).

## Plan 09 — Global budgets & cost accounting *(placeholder)*

Budgets stop at the request boundary; nobody can answer "what did this week cost."
- [ ] **Deck-level spend ceilings** — daily/weekly token + USD caps in `taicho.yaml`, enforced in
      the same place per-run caps are (the loop meters; config disposes).
- [ ] **`/costs`** — cross-session rollup from traces (by agent / day / provider), honest about
      `costUsd: null` subscription runs (report tokens there).

---

## Plan 10 — Squad UI: live agent status & multi-pane view

**Detail:** [`reference/squad-ui-status.md`](reference/squad-ui-status.md)

**One line:** Make the squad visible while it works — a live per-agent status model (idle /
thinking / writing / working / waiting / delegating), transparent tool calls with arg previews,
a glanceable status bar, and (later) split panes per agent.

**Why:** during a run the captain sees a spinner and post-hoc `↳` breadcrumbs. Tool calls surface
only after the model call settles (the SDK executes them inside `generateText`), args never show,
and nothing says which agent is doing what — or that one is blocked waiting for an approval.

**Direction set by the user (2026-07-04, revised same day):** **both surfaces ship in this plan**
— the status bar (glanceable summary) and split panes (one agent per pane). No v1/v2 split. Note:
panes reach full value once Plan 04 makes agents genuinely concurrent, but they're useful
immediately for watching a delegation cascade's nested activity.

**Interlocks:** the engine emitters (tool `execute()` wrapper, approval wrapping) are **shared
with Plan 02 Phase 0** — build once, feed both the waterfall's spans and live status. The
`writing` state on non-Codex providers needs Plan 07 (unified streaming). The bar is how Plan 04
background tasks stay visible.

### Phase 0 — Decision (closed 2026-07-04)
- [x] **Bar position:** top vs bottom. *Decided (2026-07-04): bottom, directly above the input — glanceable where the eyes already are.*

### Phase 1 — Typed live event stream (engine; shared with Plan 02 Phase 0)
- [ ] Extend `onStep` to a typed event: `{ agent, runId, phase: model_start|delta|tool_start|tool_end|approval_start|approval_end|final, tool?, argsPreview?, text? }`.
- [ ] `tool_start`/`tool_end` from the tool `execute()` wrapper (same hook as Plan 02 span timing).
- [ ] `approval_start`/`approval_end` wrapping `ctx.requestApproval` (same hook as Plan 02 approval spans).
- [ ] `argsPreview`: one-line, redacted, length-capped arg render — transparency without payload dumping; never log auth material.

### Phase 2 — Status model (pure, testable)
- [ ] `AgentStatus` reducer: event stream → per-run status (idle/thinking/writing/working/waiting/delegating) + current tool + elapsed-in-state.
- [ ] Unit tests: event sequences → expected status transitions (incl. nested delegation and approval waits).

### Phase 3 — Status bar (Ink)
- [ ] `StatusBar` component: one compact segment per live agent (glyph · agent · state · tool+argsPreview · elapsed); `waiting` rendered loud.
- [ ] Graceful collapse: hidden when nothing runs; "+N more" past terminal width.
- [ ] Absorb the live role of the `↳` breadcrumbs (breadcrumbs remain as scrollback record).
- [ ] Layer-1 `App.test.tsx`: bar appears on run start, shows tool during execution, shows waiting during an approval card, clears on completion.

### Phase 4 — Split panes
- [ ] `SquadPanes` layout: terminal splits into one pane per **live** agent (status line + its live stream: tool lines with argsPreview, streamed/final text), REPL pane keeps focus and full width when the squad is idle.
- [ ] Pane lifecycle: panes appear when an agent goes live, collapse on completion (brief settle state so results are seen); cap visible panes by terminal size with "+N more" overflow (bar remains the complete summary).
- [ ] View modes + toggle: `/view bar` · `/view panes` · `/view both` (default **both**: panes above, bar pinned above the input); persist the choice.
- [ ] Resize handling: re-flow panes on terminal resize; degrade to bar-only below a minimum size.
- [ ] Focus/keys: REPL always owns the keyboard (panes are display-only in this plan — steering stays via the input, targeted per Plan 04 Phase 4).
- [ ] Layer-1 `App.test.tsx`: pane appears on delegation, streams tool lines, collapses on completion; degradation below min size.

### Phase 5 — Tests & docs
- [ ] Real-binary e2e (tui-test): delegation run shows both agents in panes + both statuses in the bar; `/view` toggles work.
- [ ] Evidence scenario (Plan 11): tape showing two agents live in panes + bar during a delegation.
- [ ] Update `TESTING.md`, `CLAUDE.md`.

---

## Plan 11 — Evidence-Grade E2E (video proof)

**Detail:** [`reference/e2e-evidence.md`](reference/e2e-evidence.md)

**One line:** One command per scenario drives the compiled binary through a real user flow in a
real terminal and hands back watchable proof — a true session video + screenshots + machine-checked
workspace assertions, tied together in an evidence manifest.

**Why:** `CLI_TESTING.md` already demands this and documents the honest gap: today's MP4 is
rendered from a log after the fact (a presentation, not a recording), and the `expect` driver's
fixed sleeps are flaky with Ink. The deterministic keystone (`TAICHO_E2E_MODEL`, `e2e-model.ts`)
already works — only the recording half is missing. **VHS** closes it: true headless-terminal
video, `Wait+Screen /regex/` wait-gating (same discipline as Layer 1's `waitFor`), screenshots.

**Principle:** video is **evidence, not assertion** — workspace file assertions decide pass/fail;
the video shows what happened. Becomes **Layer 4** in TESTING.md; replaces
`e2e/record-agent-flow.expect`; closes CLI_TESTING.md "Next Improvements" 1–3.

### Executor runbook (hand-off — start here to build this plan)
**[`reference/integration-testing-runbook.md`](reference/integration-testing-runbook.md)** — the
self-contained execution guide for a context-free agent: ground rules (temp workspace ONLY — the
repo root is the live dev workspace; no `bun add`), exact commands, the full
`scripts/e2e-evidence.ts` skeleton, the scenario-spec contract, the complete agent-flow tape +
assertion set, manifest schema, a run-twice verification checklist (including the
watch-the-video step and a negative-path check), and a failure-mode table. The phases below are
the tracking view; the runbook is the build view.

### Phase 0 — Decisions (closed 2026-07-04 — user direction + recommendation)
- [x] **Recorder:** VHS (asciinema+agg as fallback). *Decided (2026-07-04).*
- [x] **Proof unit:** tape + wrapper assertions + `manifest.json`; video never the assertion. *Decided (2026-07-04).*
- [x] **Determinism:** e2e-model modes per scenario; real-model evidence stays manual (Layer 3 rules). *Decided (2026-07-04).*

### Phase 1 — Tooling & harness
- [x] `brew install vhs` (pulls ttyd; ffmpeg already present); pin the version note in TESTING.md. *vhs 0.11.0 / ttyd 1.7.7 installed + pinned in TESTING.md & CLI_TESTING.md.*
- [x] `scripts/e2e-evidence.ts <scenario>`: build binary → temp workspace (NEVER the repo root — live dev workspace) → run `vhs e2e/tapes/<scenario>.tape` → run the scenario's file assertions → write `evidence/<scenario>/manifest.json` (video, screenshots, assertion results w/ expected·actual, workspace pointer, git SHA, timestamp); non-zero exit on any failure. *Wrapper also warms the freshly-built binary (macOS cold-exec flake fix) and copies vhs's relative outputs into evidenceDir.*
- [x] Gitignore `evidence/` output; keep tapes + assertion specs in-repo. *`evidence/` already in .gitignore; scenario spec (tape source + assertions) lives at `e2e/scenarios/agent-flow.ts`.*

### Phase 2 — First scenario: agent-flow
- [x] `e2e/tapes/agent-flow.tape`: create agent → `Wait+Screen /New agent/` → approve → delegate → `Wait+Screen /Root used proof-agent/`, with screenshots at the approval card and final state. *Tape is returned by the scenario's `tape()` and written into the temp ws at run time (per runbook §3c); screenshots captured at the approval card and final delegation.*
- [x] Port the assertion set from `e2e/agent-flow.tui.ts` / CLI_TESTING.md (trace outcome, `delegatedOut`, child `final.md`, ledger, `child-runs.json`) into the wrapper. *7 assertions; run ids discovered dynamically (date-stamped).*
- [x] Delete `e2e/record-agent-flow.expect` + the rendered-MP4 flow once the tape passes. *Deleted the expect recorder; CLI_TESTING.md rewritten to drop the rendered-MP4 flow. `e2e/agent-flow.tui.ts` (Layer 2) kept.*

### Phase 3 — Scenario roster
- [ ] `conversation-audit` tape (port the interrupted-turn scenario from `e2e/conversation-audit.tui.ts`).
- [ ] Convention: every headline capability (Plans 01, 04, 06, 10) adds its proof scenario (e2e-model mode + tape + assertions) in its own test phase.

### Phase 4 — Docs & CI
- [x] Rewrite `CLI_TESTING.md` around the new harness; add Layer 4 to `TESTING.md`'s table; update `CLAUDE.md`. *CLI_TESTING.md rewritten (assertion contract kept, manifest = deliverable, gotchas documented); TESTING.md now four layers + a Layer 4 section; CLAUDE.md testing line updated.*
- [ ] (later) `charmbracelet/vhs-action` in CI, evidence folder as build artifact — only once tapes prove stable locally.
