# CLAUDE.md

Guidance for working in **taicho** — a standalone, conversational CLI (Bun + TypeScript + Ink)
for running a squad of persistent, stateful agents that discover each other, delegate work, and
produce artifacts. You can enter at any agent, steer it mid-run, inspect traces, and make
corrections stick as policy.

## Commands

Requires [Bun](https://bun.sh). There is no `test` npm script — run `bun test` directly.

```
bun install
bun run dev            # Ink REPL with hot reload (TAICHO_DEBUG=1 by default)
bun run start          # Ink REPL, no watch
bun run build          # compile single minified binary → dist/taicho
bun run typecheck      # bunx tsc --noEmit
bun test               # full suite (bun:test); colocated *.test.ts files
bun test src/core/loop.test.ts   # a single file
```

Always run `bun run typecheck` **and** `bun test` before claiming a change is done; for changes
that touch model/provider wiring, also `bun run build` (the single-binary bundle catches import
issues tsc won't).

## Architecture

- **`src/index.tsx`** — entry. Loads config, opens the SQLite DB, resolves auth, builds the
  model/resolver/pricer (`buildFromAuth`), renders the Ink `App`. Boot failures (e.g. a
  misconfigured provider) print a `taicho: …` line and `process.exit(1)`.
- **`src/ui/`** — `App.tsx` is the REPL (chat, `@agent` direct messages, `/slash` commands,
  Esc-to-cancel/steer, approval cards). `slash.ts`, `input.ts`, `ProposalCard.tsx`,
  `TraceInspector.tsx` (the `/trace` waterfall — see **Observability** below). `StatusBar.tsx` +
  `SquadPanes.tsx` (Plan 10) are the **live squad view**: the bar is a one-line summary of every live
  agent; the panes are one-per-agent detail (status line + recent tool lines with `argsPreview`).
  Both render from `core/agent-status.ts` (the reducer over the `onStep` event stream); `/view
  bar|panes|both|waterfall|stream` (default `both`) switches surfaces and persists via `store/prefs.ts`.
  Panes are display-only — the REPL always owns the keyboard. Layer-4 recorded proof (Plan 10 Phase 5):
  `bun scripts/e2e-evidence.ts squad-panes` shows both panes + bar live during a delegation, driven by
  a **slow-mode e2e model** (`e2e-model.ts` `squad-panes` mode) that holds the child's model call
  in-flight ~4s so the pane doesn't flash faster than a recorded frame — see TESTING.md's Squad UI section.
  `RollingStream.tsx` (Plan 13) is the **`/view stream`** surface: a fixed-height per-agent tail of the
  live reply/work stream — only the last N lines (default 4, cap 5), older lines scroll off, never
  growing. It is the reply/work channel the panes deliberately OMIT (echoing streamed reply text inside
  a pane raced the scrollback reply channel — see TESTING.md's Squad UI note), so it lives behind its
  own opt-in `/view stream` mode leaving the default `both` untouched. It folds the SAME `onStep` delta
  events the bar/panes/live-trace consume into a bounded per-run buffer (no new engine plumbing) and is
  **display-only**: it never feeds back into transcript/ledger/boot-replay (Plan 05 owns compaction —
  this is a view, not a rewrite of the record; the reply still commits to scrollback via `streamRef`).
- **`src/core/`** — the engine:
  - `loop.ts` — the single metered agent loop. Model proposes, config disposes: budgets/caps and
    cancellation are enforced here; it is the one place spend (tokens + advisory USD) is counted.
  - `run.ts` — orchestrates ONE run: assemble prompt → build tools → `runLoop` → write trace.
    `RunDeps` are the seams; `executeRun` recurses for delegation (depth/cycle/run caps).
  - `turn-audit.ts` — the per-turn audit **engine seam** (Plan 01 Ph5). `executeRun` calls
    `recordUserTurn` (run start) + `recordTurnOutcome` (run end), guarded to a user CONVERSATION turn
    (`triggeredBy === "user" && !ingestSource`), so every caller (REPL, headless, tests) gets identical
    ledger + task + boot-replay audit — not just the Ink UI. The ledger (`conversations/<id>/ledger.jsonl`)
    is append-only TRUTH; `context.json` is the include/exclude decision log; `thread.jsonl` is a
    DERIVED, compacted boot-replay cache. Was an App-local closure (PR #17) — moved here.
  - `conversation-replay.ts` — Plan 05 Ph3 cross-turn (boot-replay) compaction + the replay cache.
    `rebuildReplayCache` rewrites `thread.jsonl` from the ledger's INCLUDED turns each completed turn:
    `compactReplay` keeps the recent `defaults.replayKeepTurns` turns (default 6) VERBATIM and folds
    older turns into ONE deterministic `[CONVERSATION COMPACTION]` rolling summary. Replay carries
    artifact HANDLES + summaries (resolved via `readArtifact` — envelope only, never the body), never
    payloads — where Plan 01's two halves meet. Deterministic (no LLM call); reuses `compaction.ts`'s
    `estimateTokens` + marker-summary shape. Compaction changes what REPLAYS, never what is RECORDED.
  - `tasks.ts` — Plan 04 async/parallel. `TaskScheduler` is a per-agent concurrency semaphore over
    **detached** background runs (`dispatch_task` → `{taskId}` immediately; cascade runs off-turn via
    the same `executeRun`, `triggeredBy: taskId`). `budgets.maxConcurrentRuns` caps how many of an
    agent's tasks run at once; extras sit `queued` and the queue pumps when a slot frees. `check_task`
    / `await_task` return status+summary+handle (reference hand-off, never the payload). The REPL owns
    the scheduler + settle/notify; the engine exposes `RunDeps.dispatch` / `awaitTask`. Steering is
    per-run (`pollSteerFor` keyed by runId — plain steer → foreground root, `@agent` → that agent's
    live run). `loop.ts` flushes `transcript.jsonl` incrementally (`onEvent`) + checkpoints the
    message array per iteration (`checkpoint`) so a crash is legible; boot reconciles `tasks/`
    (`running`/`queued` → `interrupted`, report-and-ask).
  - `verification.ts` — the delegation checker (Plan 06): when `delegate_task` carries `criteria`,
    `runChecker` runs ONE independent model call (child output + criteria → `{pass, reasons[]}`) on
    the delegating agent's resolved model, via `runLoop` with an empty toolset. `tools.ts` owns the
    policy (check → one bounded retry with feedback → surface the failed verdict); `run.ts` owns the
    checker's model plumbing (`ctx.checkCriteria`). Verdicts land on `trace.verification` + transcript.
  - `compaction.ts` — Plan 05 in-run context compaction (deterministic; no LLM call). Cheap `chars/4`
    token estimate over system + messages; a per-model context-window table × `defaults.compactAt`
    (default ~70%) gives the threshold (config-disposed). When the next-call estimate crosses it, the
    loop folds the OLDEST tool round-trips into ONE `user` summary message — keeping the system prompt,
    the original brief (`keepHead`), and the most recent `compactKeepRecent` round-trips VERBATIM — and
    emits a `compaction` transcript event (never invisible). Peak estimate is recorded as
    `trace.contextTokens` and surfaced in the waterfall LLM-span detail. Cross-turn (boot-replay)
    compaction is `conversation-replay.ts` (Plan 05 Ph3) — it hooks the `turn-audit.ts` seam.
  - `scheduler.ts` — Plan 04 Phase 6 scheduled/triggered runs. A PURE engine (clock, file-stat, and the
    fire action are all INJECTED — deterministic + unit-tested with no real timers): cron eval (5-field,
    **UTC**) + `SchedulerRunner`, which on each `tick(now)` fires the due schedules through the headless
    `executeRun` path (`runHeadless`). Triggers: **cron**, **interval**, file-**watch** (mtime). A
    scheduled run is UNATTENDED → reuses headless's auto-**reject** approvals (no unsupervised privileged
    exec; `approve` is the trusted opt-in). Never re-fires a schedule while its run is in flight
    (concurrency ≤1/schedule). `schedule-cli.ts` runs the `taicho schedule <add|list|remove|run>`
    subcommand; the same `parseScheduleCommand` backs the REPL's `/schedules`. The REPL arms persisted
    schedules on boot and ticks on a 15s interval (the real firing floor).
  - `model.ts` — provider+model → AI-SDK model instance (`buildModel`, `createModelResolver`).
  - `providers/openai-codex.ts` — ChatGPT-subscription (Codex backend) provider: a `createOpenAI`
    instance with a custom `fetch` that injects the OAuth bearer + Codex headers and refreshes on 401.
  - `auth/` — OAuth PKCE login, token refresh, profile store, constants, status.
  - `trace-tree.ts` / `trace-layout.ts` — the pure derivation + layout behind the `/trace` waterfall
    (see **Observability** below); `TraceInspector.tsx` is the view.
  - `prompt.ts`, `tools.ts`, `registry.ts`, `discovery.ts`, `pricing.ts`, `memory.ts`, `draft.ts`.
- **`src/store/`** — persistence: `config.ts` (provider/model/auth resolution + `taicho.yaml`),
  `db.ts` (SQLite), `roster.ts` (agent.md canon + registry index; `createAgent` **baseline-merges**
  `DEFAULT_WORKER_TOOLS` — the artifact grant — under any model-proposed `tools`, so an explicit
  `tools: []` can never again mint a toolless worker (Plan 14); `reconcileWorkerTools` backfills that
  baseline onto any EXISTING worker born with `tools: []` on boot), `thread.ts`, `trace.ts`,
  `policy.ts`, `files.ts`, `vectors.ts`,
  `task-state.ts` (persistent task queue: `tasks/*.json` canon + a rebuildable `tasks` DB index;
  chat turns + background dispatches, `reconcileTasks`/`reindexTasks` on boot),
  `schedules.ts` (Plan 04 Ph6 durable schedules: `schedules/<id>.json` canon — a small captain-owned
  set, so a file scan is the whole query surface, no DB index; a bad cron is rejected at CREATE time),
  `artifacts.ts` (addressable, versioned, immutable-per-version hand-off store over `artifacts/`;
  `gcArtifacts` archives unreferenced old versions, keep-latest-N + lineage/trace-safe),
  `annotations.ts` (Plan 01 Ph4 **feedback & revision**: append-only `artifacts/<id>/annotations.jsonl` —
  feedback pinned to a version; an OPEN annotation rides an input artifact into a revision run; a Plan 06
  verification verdict is an annotation like any other).
- **`src/coaching/`** — corrections → durable, conditional, approval-gated policy notes.
- **`src/schemas/`** — zod schemas (`agent`, `brief`, `policy`, `trace`, `artifact`, `annotation`).

## Observability — the `/trace` waterfall (Plan 02)

taicho already produces rich per-run evidence (traces, `transcript.jsonl`, the coaching ledger,
verification verdicts, `failure.md`) — but it was **write-only**. The **`/trace` inspector is the
reader** for it: a LangSmith-style waterfall (a span tree with absolute-time bars, drill-into-span),
native to the terminal, **no external service**.

- **Command surface.** `/trace` (no arg) opens the **latest** `triggeredBy:"user"` run; `/trace <id>`
  opens that run. `/runs` is the picker (rows carry duration). A trace = **one root user run plus its
  delegation subtree** — exactly like one LangSmith trace. Wired in `App.tsx` (`setInspect`); the
  post-run `trace: <id>` breadcrumb carries a `· /trace to inspect` hint.
- **`deriveTrace(ws, rootRunId): Span[]`** (`src/core/trace-tree.ts`) — **pure** (files in → `Span[]`
  out, no Ink; unit-tested over real-engine fixtures in `trace-tree.test.ts`). Walks `delegatedOut`
  recursively into **run** spans; reads each run's `transcript.jsonl` into **llm** spans (pair
  `model_request`→`model_response`/`model_error` by `iteration`), **tool** spans (`tool_start`→
  `tool_end` by `callId`), and **approval** spans (`approval_start`→`approval_end`); a `delegate_task`
  tool span **adopts** its child run span via the captured `childRunId` (a verification retry's failed
  first attempt nests under the same tool span). Tokens/cost roll up onto run spans (reuses
  `aggregate`).
- **The `Span` model** — `kind: run|llm|tool|approval`, `parentId`, `startMs`/`endMs`, `tokens`,
  `costUsd`, `status`, `detail` — is the single unit everything renders from. `trace-layout.ts` (pure)
  maps `[traceStart, traceEnd]` onto a fixed column budget with a **≥1-cell min-width floor** (so
  sub-second llm/tool spans never vanish) and a duration-adaptive scale; expand/collapse is a set of
  collapsed span ids → visible-rows.
- **`TraceInspector.tsx`** — the Ink view. Keys: `↑↓` move · `→/←` expand/collapse · `⏎` open detail ·
  `q`/esc close. It owns the keyboard while open via the **`cardKeyRef` pattern** (App's one
  boot-registered `useInput` forwards keys — dodges the first-keystroke race). Detail per kind: **llm**
  (response, tokens, finish reason, context estimate) · **tool** (args/result/error) · **run**
  (outcome, rolled-up cost, notes, the **coaching ledger** = policies/KB/skills
  retrieved·applied·skipped, verification verdicts).
- **Span capture (Phase 0).** The bars' durations need `tool_start`/`tool_end` and
  `approval_start`/`approval_end` in the transcript — emitted by the tool `execute()` wrapper and the
  `requestApproval` wrapper (the **same seam Plan 10's live status uses**). Approval waits are **core**
  spans, not optional: human latency dominates wall-clock here, so a waterfall without them would
  misattribute the wait.
- **Live mode (Phase 6).** `/view waterfall` streams spans into a **redrawing** waterfall as the run
  executes — the live counterpart to the post-hoc inspector. `src/core/live-trace.ts` folds the
  **same** live event stream the status bar/panes consume (`onRunStart`/`onStep`/`onRunEnd`) into a
  partial `Span` tree, incrementally (no disk reads, no re-derive per frame); `LiveWaterfall.tsx`
  renders it through the **same** `trace-layout`, with running bars growing to `now`. The flat `↳`
  breadcrumbs stay in scrollback as the record. `callId` was added to the live step event so live tool
  spans pair start↔end exactly like the persisted ones.
- **Task-level traces (Phase 6).** `/trace task_<id>` roots the waterfall at a **Task** (Plan 04's
  persistent task) rather than a single user-run: `deriveTaskTrace(ws, taskId)` gathers **all** of the
  task's top-level runs (its `rootRunId` + every run whose `triggeredBy` is the task id — the grouping
  key for a task spanning multiple turns/runs) and nests each run's subtree under one synthetic
  task-root span, reusing the same walker + layout as `deriveTrace`.

## Models, providers & auth

Credentials are read from the environment only — **never** from `taicho.yaml`. Providers:

- `anthropic` (`ANTHROPIC_API_KEY`, default `claude-sonnet-4-6`)
- `openai` (`OPENAI_API_KEY`, default `gpt-5.5`)
- `openrouter` (`OPENROUTER_API_KEY`) — uses the official `@openrouter/ai-sdk-provider`. **No
  default model**: requires an explicit namespaced `vendor/model` slug via `TAICHO_MODEL` or
  `taicho.yaml`. Built with `usage:{include:true}` so the real per-call cost comes back at
  `providerMetadata.openrouter.usage.cost` (read in `loop.ts` when `captureProviderCost` is set).
- ChatGPT **subscription** via `/login openai` (Codex backend, no API key).

Selection (`store/config.ts` `resolveConfig`/`resolveAuth`): a signed-in subscription is preferred
over env keys; otherwise auto-detect Anthropic → OpenAI → OpenRouter (OpenRouter last). An explicit
`TAICHO_PROVIDER` (`anthropic|openai|openrouter|openai-codex`) always wins. `TAICHO_MODEL` overrides
the model; `taicho.yaml` `defaults`/`agents.<id>` set per-agent provider/model/budgets. Provider
*selection* is env-driven — `defaults.provider` in yaml does NOT switch boot auth (only per-agent
resolution).

### Gotchas
- **Codex backend** (subscription) rejects non-streaming requests and requires the system prompt in
  the top-level `instructions` field with `store:false` — `loop.ts` streams (`codexBackend`) and
  routes `system → providerOptions.openai.instructions`. The env (api.openai.com / Anthropic /
  OpenRouter) path uses plain `generateText` with a normal `system`.
- **OpenRouter** model must be namespaced (`vendor/model`); `model.ts` throws an actionable error
  otherwise (this also catches a first-party default bleeding into a per-agent override).
- **Cost honesty**: subscription runs record `costUsd: null` + `costNote:"subscription"`; OpenRouter
  records its real returned cost; other env-key runs use the static `pricing.ts` table (tokens are
  the hard budget — unknown models price to 0, never throw).
- Tokens are always metered (budgets/caps still enforced) regardless of provider.

## Conventions

- Bun + TypeScript ESM, React 19 / Ink 7 for the TUI, zod for all schema validation.
- Tests are colocated `*.test.ts` using `bun:test`; model calls are mocked with
  `MockLanguageModelV3` from `ai/test` — **no network in tests**. See **`TESTING.md`** for the four
  testing layers (in-process Ink via ink-testing-library, real-binary via `@microsoft/tui-test`,
  real-model verification scripts, and **Layer 4 VHS evidence** — `bun scripts/e2e-evidence.ts
  <scenario>` records a true session video + workspace-file assertions, see `CLI_TESTING.md`) and
  the non-obvious gotchas (separate keystroke writes, ANSI escapes, the `bun test` vs `tui-test`
  file split).
- Keep the resolver return shape (`{ model, modelId, subscription?, captureCost? }`) in sync across
  its mirrors: `model.ts` (`ResolvedModel`), `run.ts` (`RunDeps`), `index.tsx` (`BuiltAuth`),
  `ui/App.tsx` (`ResolveModelFn`).
- **Delegation verification is criteria-gated (Plan 06):** `delegate_task` runs a checker + one
  bounded retry ONLY when the model passes `criteria`. No criteria ⇒ no extra model call, zero cost,
  today's trust-everything behavior — keep it that way (the agent-flow e2e delegates without criteria
  and must stay unchanged). The checker is an INDEPENDENT call, not the parent's self-check; the
  retry consumes a `maxWorkItemsPerRequest` like any delegation. Verdicts surface to the captain via
  the `onStep` `note` breadcrumb and are recorded on `trace.verification` + task-state `verifications[]`.
- **Workers are never born toolless (Plan 14):** `roster.ts`'s `DEFAULT_WORKER_TOOLS` (the artifact
  grant: `write_artifact`/`save_artifact`/`read_artifact`/`list_artifacts`/`annotate_artifact`/
  `list_annotations`) is the worker capability FLOOR — the hand-off-by-reference tools every worker
  needs so it produces real artifacts, not loose `final.md` text. `createAgent` **baseline-merges**
  it under any model-proposed `tools` (extras ADD, never REPLACE), so `create_agent` with a missing or
  empty `tools: []` — which the old `draft.tools ?? [defaults]` let sail through (`??` only fills
  null/undefined) — can no longer defeat the default. Privileged/opt-in capability (`delegate_task`,
  `run_command`, `create_agent`, `ask_human`, KB tools, `mcp:<server>` — Plan 08 least privilege) is
  NOT in the baseline; the model requests it explicitly. `reconcileWorkerTools` (boot, in `index.tsx`)
  backfills the baseline onto any EXISTING worker persisted with `tools: []`, leaving deliberate
  non-empty grants (and root/librarian) untouched.
- **Logging (Plan 03):** never `console.error/warn` from engine/store code — a stray write corrupts
  the Ink TUI. Use the leveled `log` from `src/core/logger.ts`; it writes to `taicho.log` in the
  workspace and redacts auth material centrally (so no call site can leak a token). Raise to debug
  with `--verbose`/`-v`, `TAICHO_VERBOSE`, `TAICHO_LOG_LEVEL=debug`, or the historical `TAICHO_DEBUG`
  (now a general level, not codex-only). The only intentional `console.error`s left are the boot/auth
  UX prints in `index.tsx` (authorize URLs, subscription notice, boot-failure `taicho: …` + exit).
- **Headless (Plan 03):** `taicho run "<goal>"` drives `executeRun` without Ink; `taicho tail
  [runId] [--follow]` streams a run's events. `index.tsx` dispatches on `process.argv` before the
  Ink render. Approvals default to auto-reject (unattended-safe); `--approve auto|prompt` opt in. The
  on-disk event schema + observation guide is `docs/events.md`.
- Never log auth tokens; use `redactAuthHeader` (or the redaction built into `core/logger.ts`).
- Design docs live in `docs/superpowers/specs/`; plans in `docs/superpowers/plans/`.
