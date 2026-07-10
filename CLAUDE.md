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
  Esc-to-cancel/steer, approval cards). `slash.ts`, `input.ts`, `ProposalCard.tsx`. `StatusBar.tsx` +
  `SquadPanes.tsx` (Plan 10) are the **live squad view**: the bar is a one-line summary of every live
  agent; the panes are one-per-agent detail (status line + recent tool lines with `argsPreview`).
  Both render from `core/agent-status.ts` (the reducer over the `onStep` event stream); `/view
  bar|panes|both` (default `both`) switches surfaces and persists via `store/prefs.ts`.
  Panes are display-only — the REPL always owns the keyboard. Layer-4 recorded proof (Plan 10 Phase 5):
  `bun scripts/e2e-evidence.ts squad-panes` shows both panes + bar live during a delegation, driven by
  a **slow-mode e2e model** (`e2e-model.ts` `squad-panes` mode) that holds the child's model call
  in-flight ~4s so the pane doesn't flash faster than a recorded frame — see TESTING.md's Squad UI section.
  `AgentBlock.tsx` + `OperationView.tsx` (Plan 13 corrected) are the **consistent agent blocks**: the
  default squad view for delegated work. Every sub-agent is rendered as a single block (header + fixed
  2-line body) that NEVER changes shape across its lifecycle — live/done/failed variants change only
  the state label, rail colour, and body content. The block IS the record: the block you watched live
  is the exact block that settles into scrollback. Root's own direct reply still uses the scrollback
  (the conversational reply channel); blocks are for the squad. `shift+tab` enters focus mode (↑↓
  navigate, ⏎ opens the operation view drill-in, esc returns). The `/view stream` mode has been
  **deleted** — consistent blocks are the default, not an opt-in.
  `ArtifactViewer.tsx` (Plan 15) is the **artifact browser**: a full-screen card that renders the
  selected artifact's body as markdown, scrollable. The **completion action bar** appears when a user
  turn produces artifacts, offering "View artifacts (N)" and "Continue chatting". `gatherConversationArtifacts`
  in `trace-tree.ts` walks the delegation subtree, collects artifact handles from each run's trace,
  de-dups by handle, and returns them ordered by created desc (latest first).
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
  - `otel.ts` — OpenTelemetry export (Plan 16); the ONLY trace visualization path now (see
    **Observability** + **OpenTelemetry** below). `conversation-artifacts.ts` — the Plan 15 artifact
    browser's run-tree walker (extracted from the retired trace-tree.ts).
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

## Observability — OpenTelemetry only (Plan 16 + Plan 17)

**Trace visualization is OpenTelemetry's job — taicho ships no bespoke trace UI.** The in-terminal
`/trace` waterfall (Plan 02: `trace-tree.ts`/`trace-layout.ts`/`live-trace.ts` + `TraceInspector.tsx`/
`LiveWaterfall.tsx`, the `/trace` + `/runs` commands, the `/view waterfall` mode) was **retired in
Plan 17** — it duplicated what OTel + any backend (Jaeger, Grafana Tempo, Honeycomb, LangSmith)
already do better, and an external backend gives the AGENTS a queryable API to self-diagnose that a
terminal reader never could. See **OpenTelemetry** below for the export (`src/core/otel.ts`).

What REMAINS after the retirement (deliberately kept — NOT tracing UI):
- **The run-evidence substrate** — `RunTrace` (`store/trace.ts`) and `transcript.jsonl`
  (`store/run-transcript.ts`). It's the DATA the product logic runs on: `/costs` (`core/costs.ts`),
  coaching (`turn-audit.ts`), tasks, `memory.ts` recent-runs digest, and crash-recovery checkpoints.
  `gatherConversationArtifacts` (moved to `core/conversation-artifacts.ts` when trace-tree was deleted)
  still walks the delegation tree for the Plan 15 artifact browser.
- **The live squad view** — `StatusBar.tsx` + `SquadPanes.tsx` + `AgentBlock.tsx` + `OperationView.tsx`
  (Plan 10/13), fed by the `onStep` event stream via `core/agent-status.ts`. This is the captain's LIVE
  steering wheel (watch + steer agents mid-run) — post-hoc external OTel backends can't replace it, so
  it stays.
- **The execution log** — `taicho.log` (Plan 03, `core/logger.ts`) is the plain app log for correlation.
  Plan 17 stamps each line with the active OTel `trace_id`/`span_id` (`format()` reads
  `trace.getSpanContext(context.active())`) so a log line lines up with the exact span in the backend.

## OpenTelemetry — standard export (Plan 16)

taicho exports its model/tool/delegation activity as **standard OpenTelemetry** — `gen_ai.*`
semantic-convention spans + metrics — over OTLP to ANY backend the user configures (Jaeger, Grafana
Tempo, Honeycomb, LangSmith, Langfuse, Datadog…). taicho ships **no bundled observability UI**; users
drop in their own OTLP config via the standard `OTEL_*` env vars. **Off by default**: with no
`OTEL_EXPORTER_OTLP_ENDPOINT`, `initTelemetry` returns undefined and every seam skips it (zero overhead,
no provider, no network). Since Plan 17 this is the ONLY trace-visualization path (the internal `/trace`
waterfall was retired). **User-facing setup + copy-paste backend configs: `docs/observability.md`.**
Design/rationale: `docs/superpowers/specs/2026-07-09-opentelemetry-design.md`.

- **`src/core/otel.ts`** — `initTelemetry` builds a `NodeTracerProvider` +
  `AsyncLocalStorageContextManager` (context propagation across the delegation's await boundaries — Bun
  implements `AsyncLocalStorage`) + a `MeterProvider`, both OTLP. Returns a `Telemetry` handle threaded
  through `RunDeps` like the spend ledger (undefined ⇒ disabled). Test seam: inject `spanExporter` /
  `metricReader` (in-memory, no network). The OTLP exporters read the STANDARD `OTEL_*` env vars
  themselves (endpoint/headers/protocol) — nothing bespoke.
- **`loop.ts`** — every `streamText` gets `experimental_telemetry: { isEnabled, tracer, … }`, so the AI
  SDK emits the gen_ai spans (`ai.streamText` → `ai.streamText.doStream`). `recordInputs`/`recordOutputs`
  are gated by `OTEL_TAICHO_CAPTURE_CONTENT` — **off by default**, so prompt/completion text never leaves
  the process unless opted in. Per call, `onModelCall` feeds the token/duration/cost metrics.
- **`run.ts`** — `executeRun` opens a `run <agent>` span BEFORE the try (so a pre-loop throw still closes
  it) and makes it ACTIVE around `runLoop` via `context.with`, so the gen_ai spans AND delegated child
  runs nest under it — a delegation is ONE distributed trace. `finishRunSpan` is idempotent (finalize +
  catch), stamps tokens/cost/context/outcome, and decrements the active-run gauge exactly once. A
  `taicho.*` attribute namespace carries what the spec doesn't (agent, run id, triggered-by, depth,
  advisory USD, context tokens). The OTel `trace` import is aliased `otelTrace` to avoid colliding with
  the local `RunTrace` object named `trace`.
- **Boot (`index.tsx`)** — `initTelemetry()` once; threaded into headless, the REPL (`App` props), and
  the schedule-fire path. Every exit path awaits `telemetry.shutdown()` so the `BatchSpanProcessor`
  flushes buffered spans before the process dies (a SIGTERM handler too).
- **Metrics** — `gen_ai.client.token.usage` + `gen_ai.client.operation.duration` histograms,
  `taicho.cost.usd` counter (0/absent for subscription — never a fabricated price), `taicho.run.active`
  gauge, `taicho.run.duration` histogram.

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
- **Model-call timeout is a TRANSPORT deadline, not a loop watchdog** (Plan 12). There is NO idle
  timer in `loop.ts`. A per-request deadline lives on the provider `fetch`
  (`core/providers/request-timeout.ts` `withRequestTimeout`), applied to EVERY provider path (codex +
  env-key anthropic/openai/openrouter). It can only ever see one model turn's HTTP exchange — never
  tool execution (which runs inside `consumeStream`, after the HTTP stream closes; timing that was the
  old watchdog's bug). A genuine hang aborts the real connection and surfaces a retryable `ETIMEDOUT`
  routed through the AI SDK's own `maxRetries` (no hand-rolled retry); on exhaustion the run fails with
  the REAL error. Config-disposed via `defaults.modelRequestTimeoutMs` (default 120s).

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
