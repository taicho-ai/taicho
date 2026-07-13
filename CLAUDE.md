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
  2-line body) that NEVER changes shape across its lifecycle — the component defines live/done/failed
  variants that change only the state label, rail colour, and body content. Blocks live in the Ink
  live region: a finished block lingers ~800ms (`useBlockSettle`) and then clears — the durable record
  is the run record + the scrollback breadcrumbs, NOT a persisted block. (Known gaps vs the Plan 13
  intent: App never feeds the `failed` variant / settled `summary` / `artifact` header fields — a
  failed delegation renders as a plain done block — and nesting depth is hardcoded root=0/child=1.)
  Root's own direct reply still uses the scrollback (the conversational reply channel); blocks are
  for the squad. `shift+tab` enters focus mode (↑↓
  navigate, ⏎ opens the operation view drill-in, esc returns). The `/view stream` mode has been
  **deleted** — consistent blocks are the default, not an opt-in.
  `ArtifactBrowser.tsx` + `browser-model.ts` (Plan 21, replacing Plan 15's completion action bar +
  ArtifactViewer) are the **artifact browser**: runs END inside it — a COMPLETED foreground turn with
  ≥1 artifact docks the shelf (list + preview, scopes `1·2·3` = run / conversation / all-runs-grouped,
  `f` filters, `/` search, honesty count) over the chat; `⏎` opens the FULL-SCREEN reader with the
  verbs (`a` annotate, `y` approve, `r` request revision — a normal chat turn, `v` versions, `o`
  $EDITOR; shelf `g` = dry-run-previewed GC). Bare `/artifacts` re-enters (the old subcommands are
  retired). Keyboard: a fixed dispatch order (pending card → operation view → browser → chat) on the
  browser's OWN `browserKeyRef` — a pending approval SUSPENDS the dock, so `y` is never ambiguous;
  state survives in App's `browserState`. While docked, panes/blocks/plan panel yield; the status bar
  stays. `gatherConversationArtifacts` in `core/conversation-artifacts.ts` remains the run-scope
  walker (subtree, de-dup latest-per-id, created desc).
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
    `trace.contextTokens` and stamped on the OTel run span as `taicho.context.tokens`. Cross-turn (boot-replay)
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
  - `team-routing.ts` — Plan 19. A PURE function: `delegate_task(to:"news")` → the agent that will
    actually run. A team with a `lead` routes to it (one delegation level, one model call); a LEADLESS
    team is routed by the engine to the best-ranked member (`rankAgents`) for free — leadless is the
    default. The engine RESOLVES first, then cycle-checks the RESOLVED AGENT: checking the team id would
    let `root → news → editor → news` loop forever, since a team id is never in `ancestry`. A lead may
    not address its own team; ancestors are never routing candidates. The pick is never silent — it
    rides `ctx.emit` as a note and lands on `trace.notes`, because `rankAgents` is a keyword match and
    will sometimes choose badly. `run.ts`'s `ctx.resolveDelegation` is the seam.
  - `plan-inject.ts` — Plan 18. The live plan NEVER enters the system prompt (`assemble()` runs once, so
    a plan there is stale after iteration one and would contradict the tail slot) and NEVER enters
    `messages`. `withPlanSlot` builds `[...messages, slot]` for the model CALL only. Consequences that
    fall out for free: context cost is FLAT, the prefix cache is untouched, the checkpoint/transcript
    record the real conversation, and **compaction is orthogonal by construction** — `compactMessages`
    never sees the slot, so no future tuning of `keepHead`/`compactKeepRecent` can eat the plan. The
    system prompt carries only the STATIC `PLAN_OPERATING_NOTE` (stable tier, cacheable).
  - `prompt.ts`, `tools.ts`, `registry.ts` (the ACL grammar: an entry in `canSee`/`canDelegateTo` is
    `"*"`, an exact agent id, or Plan 19's `team:<id>` — additive, since no agent id contains a colon),
    `discovery.ts`, `pricing.ts`, `memory.ts`, `draft.ts`.
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
  `plans.ts` (Plan 18 **agent-owned plans**: `plans/<id>/v<N>.json` (immutable item SET — the intent)
  + `plans/<id>/events.jsonl` (append-only transitions). **Structure vs state**: a VERSION is minted only
  when the shape changes (a replan — `writePlan` deep-equality-dedups, so a model re-stating its plan
  every iteration mints nothing); a TICK is an appended event. Current state is `fold(events)` over the
  latest version — the ledger-is-truth / cache-is-derived discipline. `PlanEvent.rejected` marks a
  refused model attempt: the fold SKIPS it, or the attempt would be the last line for that item and
  would WIN, which is exactly the lie the engine-owns rule prevents. `reconcilePlans` appends
  `interrupted` for in-flight items at boot and never touches the intent — PENDING items survive a
  reboot, unlike a task),
  `teams.ts` (Plan 19 **teams**: `teams/<id>/team.md` canon — charter, optional `lead`, tool policy.
  A file scan like `schedules.ts`, no teams table. MEMBERSHIP IS NOT HERE — the agent declares
  `team: <id>` in its own frontmatter, one source of truth, and a team's roster is derived by grouping
  the `registry.team` column. Captain-owned: there is deliberately **no `create_team` tool**, because a
  team grants capability to its members and a model that could mint teams could escalate its own
  privileges. `assertPolicyRespectsFloor` rejects a `tools.deny` intersecting `DEFAULT_WORKER_TOOLS` at
  LOAD — Plan 14's floor is not a team's to punch through. `validateTeams` reports a lead that is
  missing or sits on another team, at boot, without blocking it),
  `spend-ledger.ts` (Plan 09 + Plan 19 ceilings: **one meter, two scopes**. `squad` bounds every agent;
  `team:<id>` bounds one team's members. `loop.ts` tests every scope a run belongs to before each model
  call and commits to all of them in ONE transaction; the exhaustion message names the scope that
  tripped. A delegated child meters against ITS team; the Plan 06 checker against the DELEGATING agent's;
  the coaching distiller against `squad` alone. Was `deck-budget.ts`/`DeckLedger` — the type counts
  money, not decks),
  `artifacts.ts` (addressable, versioned, immutable-per-version hand-off store over `artifacts/`;
  `gcArtifacts` archives unreferenced old versions, keep-latest-N + lineage/trace-safe),
  `annotations.ts` (Plan 01 Ph4 **feedback & revision**: append-only `artifacts/<id>/annotations.jsonl` —
  feedback pinned to a version; an OPEN annotation rides an input artifact into a revision run; a Plan 06
  verification verdict is an annotation like any other).
- **`src/coaching/`** — corrections → durable, conditional, approval-gated policy notes.
- **`src/schemas/`** — zod schemas (`agent`, `brief`, `policy`, `trace`, `artifact`, `annotation`,
  `team`). `knowledge.ts`'s `KbScope` PREPROCESSES the legacy `"deck"` value to `"squad"` so a
  pre-Plan-19 `kb/nodes/*.md` still parses; `reconcileKbScope` rewrites those files at boot (files are
  canon), and migration v7 fixes the derived rows.

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

- **`src/core/otel.ts`** — `initTelemetry` builds tracer providers +
  `AsyncLocalStorageContextManager` (context propagation across the delegation's await boundaries — Bun
  implements `AsyncLocalStorage`) + a `MeterProvider`, both OTLP. **One tracer provider per agent**
  (`tracerFor(agentId)`, `service.name` = the agent id) so backends group/colour the delegation graph
  by agent. Returns a `Telemetry` handle threaded through `RunDeps` like the spend ledger (undefined ⇒
  disabled). Test seam: inject `spanExporter` / `metricReader` (in-memory, no network). The OTLP
  exporters read the STANDARD `OTEL_*` env vars themselves (endpoint/headers) — nothing bespoke; the
  wire format is hardwired OTLP/HTTP **JSON** (the `-http` exporters — protobuf is not selectable).
- **`loop.ts`** — taicho emits its OWN per-iteration span, `chat <model> · iter N`, carrying
  `gen_ai.*` semantic-convention attributes including the GenAI-convention message list (NOT the AI
  SDK's `experimental_telemetry`, which is not used — its `ai.streamText` spans were replaced by these
  native spans for meaningful labels + I/O). Prompt/completion content capture is gated by
  `telemetry.captureContent` from `OTEL_TAICHO_CAPTURE_CONTENT` — **on by default; opt OUT with
  `0|false|no|off`**. Per call, `onModelCall` feeds the token/duration/cost metrics.
- **`run.ts`** — `executeRun` opens a `<agentId> · <runKind>` span (e.g. `root · user turn`,
  `researcher · delegated`) BEFORE the try (so a pre-loop throw still closes
  it) and makes it ACTIVE around `runLoop` via `context.with`, so the gen_ai spans AND delegated child
  runs nest under it — a delegation is ONE distributed trace. `finishRunSpan` is idempotent (finalize +
  catch), stamps tokens/cost/context/outcome, and decrements the active-run gauge exactly once. A
  `taicho.*` attribute namespace carries what the spec doesn't (agent, run id, triggered-by, depth,
  advisory USD, context tokens). The OTel `trace` import is aliased `otelTrace` to avoid colliding with
  the local `RunTrace` object named `trace`.
- **Boot (`index.tsx`)** — `initTelemetry()` once; threaded into headless, the REPL (`App` props), and
  the schedule-fire path. Normal exit paths await `telemetry.shutdown()` so the `BatchSpanProcessor`
  flushes buffered spans before the process dies. (Known gap: the SIGTERM handler fires `shutdown()`
  without awaiting or exiting — spans can drop on SIGTERM, and with MCP disabled the handler swallows
  the signal entirely.)
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
  the top-level `instructions` field with `store:false` — `codexBackend` routes
  `system → providerOptions.openai.instructions`. Since Plan 07 there is ONE streaming path for EVERY
  provider (`streamText` always; `generateText` is imported only for its result type) — the env
  (api.openai.com / Anthropic / OpenRouter) path just keeps a normal `system`.
- **OpenRouter** model must be namespaced (`vendor/model`); `model.ts` throws an actionable error
  otherwise (this also catches a first-party default bleeding into a per-agent override).
- **Cost honesty**: subscription runs record `costUsd: null` + `costNote:"subscription"`; OpenRouter
  records its real returned cost; other env-key runs use the static `pricing.ts` table (tokens are
  the hard budget — unknown models price to 0, never throw).
- Tokens are always metered (budgets/caps still enforced) regardless of provider.
- **Model-call hangs are bounded twice** (Plan 12, then reopened). (1) A per-request TRANSPORT
  deadline lives on the provider `fetch` (`core/providers/request-timeout.ts` `withRequestTimeout`),
  applied to EVERY provider path (codex + env-key anthropic/openai/openrouter); it sees one model
  turn's HTTP exchange, aborts the real connection on a hang, and surfaces a retryable `ETIMEDOUT`
  routed through the AI SDK's own `maxRetries`. (2) `loop.ts` additionally runs a **chunk-idle timer**
  ("Plan 12 (reopened)"): reset on every stream chunk, DISARMED while a tool executes and re-armed on
  the tool-result chunk, raced against `consumeStream` — so unlike the old deleted `guardModelCall`
  watchdog it cannot time our own tool execution. Caveats: its rejection fires at the loop (not in
  fetch), so it fails the call without the SDK retry; and the disarm flag is a boolean, not a counter,
  so parallel tool calls can re-arm it early (loop.ts's header comment still claiming "NO watchdog"
  is stale). Both use `defaults.modelRequestTimeoutMs` (default 120s, config-disposed).

## Conventions

- Bun + TypeScript ESM, React 19 / Ink 7 for the TUI, zod for all schema validation.
- Tests are colocated `*.test.ts` using `bun:test`; model calls are mocked with
  `MockLanguageModelV3` from `ai/test` — **no network in tests**. See **`TESTING.md`** for the four
  testing layers (in-process Ink via ink-testing-library, real-binary via `@microsoft/tui-test`,
  real-model verification scripts, and **Layer 4 VHS evidence** — `bun scripts/e2e-evidence.ts
  <scenario>` records a true session video + workspace-file assertions, see `CLI_TESTING.md`) and
  the non-obvious gotchas (separate keystroke writes, ANSI escapes, the `bun test` vs `tui-test`
  file split).
- Keep the resolver return shape in sync across its mirrors — but note they have already forked:
  `model.ts`'s `ResolvedModel` is `{ model, modelId, provider, captureCost? }`, while `run.ts`
  (`RunDeps`), `index.tsx` (`BuiltAuth`), and `ui/App.tsx` (`ResolveModelFn`) carry
  `{ model, modelId, subscription?, captureCost? }`. Touch one, check all four.
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
- **The checkbox cannot lie (Plan 18):** `delegate_task`/`dispatch_task` take an optional `itemId`. The
  engine binds the item `in_progress` BEFORE the child runs, then settles it from the child's REAL
  outcome — and, when `criteria` is set, only when the INDEPENDENT Plan 06 checker agrees. (KNOWN BUG:
  the settle half is only wired for `delegate_task` — `dispatch_task` binds the item but
  `settlePlanItemForTask` (`store/plans.ts`) has no callers, so a background task's item stays
  `in_progress` until boot's `reconcilePlans` wrongly marks it `interrupted`.) Once an item
  carries a `boundRunId`, only the engine may set its terminal status; a model that tries is refused, and
  the attempt is appended with `rejected: true` because a model marking a failed delegation done is a
  fact worth having. Plan tools are NOT in `DEFAULT_WORKER_TOOLS` (a plan is not needed to produce an
  artifact); root holds them, a lead asks. `StepInfo.plan` is deliberately **phase-less** — a `"plan"`
  StepPhase would fall through `statusReducer`'s switch and corrupt the live status map.
- **Teams are a legibility boundary, not a security one (Plan 19):** root keeps `canDelegateTo: ["*"]`,
  so it CAN name a member directly — it won't, because its roster shows teams, not their members. That
  is what makes the old `INLINE_ROSTER_MAX = 30` cliff unreachable: a sixty-agent squad renders as five
  team lines. Want the hard boundary? Narrow root's ACL to `["team:news", "team:trading"]`; the grammar
  supports it. The default doesn't assume you want it. A squad with no `teams/` renders the roster
  **byte-identically** to pre-Plan-19 — asserted in `prompt.test.ts`, because silently reshaping every
  existing prompt would be a real regression.
- **`registry` is baseline DDL, not a migration (Plan 19 gotcha):** `db.ts`'s `CREATE TABLE IF NOT
  EXISTS registry` cannot add a column to a table that already exists. `team` is therefore declared in
  BOTH the baseline (fresh workspaces) and a guarded `ALTER` in migration v8 (existing ones), and both
  are idempotent. Either alone is a bug. Any migration test for such a column must open a **pre-migration
  DB**, not a fresh `openDb()` — `migrate.test.ts`'s `rewindToV6` rebuilds the old shape on purpose.
  Note `migrate()` also runs standalone over a bare `Database` in `spend-ledger.test.ts`, so a migration
  must not assume a baseline table exists.
- **Switch defaults — a boolean switch is OPT-OUT unless enabling it can hurt someone.** A feature you
  had to deliberately turn on (OTel needs `OTEL_EXPORTER_OTLP_ENDPOINT`) must not then hand you a gutted
  version of itself behind a second flag. `OTEL_TAICHO_CAPTURE_CONTENT` was opt-in and shipped traces with
  no prompts, no completions, no tool I/O — structure that answers no question anyone actually asks. It is
  now opt-out (`0|false|no|off`), and **unrecognized values leave it ON**: an opt-out switch has to fail
  toward the useful behaviour, or a typo silently guts the feature and nothing says so.
  The rest of the env surface is *not* miscategorized, having audited it: `TAICHO_E2E_MODEL` (a test
  double — must stay opt-in), `TAICHO_VERBOSE`/`TAICHO_LOG_LEVEL`/`TAICHO_DEBUG` (verbosity, where quiet
  is the right default), and `TAICHO_PROVIDER`/`TAICHO_MODEL`/`TAICHO_MODELS_DIR`/`TAICHO_EMBED_MODEL`
  (selectors, not booleans). `mcp.enabled` already defaults on. Apply the rule to any new switch.
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
