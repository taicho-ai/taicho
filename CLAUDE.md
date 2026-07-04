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
  Esc-to-cancel/steer, approval cards). `slash.ts`, `input.ts`, `ProposalCard.tsx`.
- **`src/core/`** — the engine:
  - `loop.ts` — the single metered agent loop. Model proposes, config disposes: budgets/caps and
    cancellation are enforced here; it is the one place spend (tokens + advisory USD) is counted.
  - `run.ts` — orchestrates ONE run: assemble prompt → build tools → `runLoop` → write trace.
    `RunDeps` are the seams; `executeRun` recurses for delegation (depth/cycle/run caps).
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
  - `model.ts` — provider+model → AI-SDK model instance (`buildModel`, `createModelResolver`).
  - `providers/openai-codex.ts` — ChatGPT-subscription (Codex backend) provider: a `createOpenAI`
    instance with a custom `fetch` that injects the OAuth bearer + Codex headers and refreshes on 401.
  - `auth/` — OAuth PKCE login, token refresh, profile store, constants, status.
  - `prompt.ts`, `tools.ts`, `registry.ts`, `discovery.ts`, `pricing.ts`, `memory.ts`, `draft.ts`.
- **`src/store/`** — persistence: `config.ts` (provider/model/auth resolution + `taicho.yaml`),
  `db.ts` (SQLite), `roster.ts`, `thread.ts`, `trace.ts`, `policy.ts`, `files.ts`, `vectors.ts`,
  `task-state.ts` (persistent task queue: `tasks/*.json` canon + a rebuildable `tasks` DB index;
  chat turns + background dispatches, `reconcileTasks`/`reindexTasks` on boot).
- **`src/coaching/`** — corrections → durable, conditional, approval-gated policy notes.
- **`src/schemas/`** — zod schemas (`agent`, `brief`, `policy`, `trace`).

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
