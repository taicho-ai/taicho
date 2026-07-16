# Plan 25 — Team Workflows

**Date:** 2026-07-16
**Status:** in progress (branch `plan-25-team-workflows`)
**Topic:** A team's process becomes a list of steps the *engine* walks — deterministically — instead of prose the model improvises.

## 1. The arc, finished

Plan 18 gave an agent its own **plan** (intent, regenerated per goal). Plan 19/22 gave the squad **teams**
(who). Plan 23 gave a team a prose **workflow.md** — member lanes + an orchestration slice — but it lands in
the lead's *system prompt*; the lead still improvises the actual order. Plan 25 moves determinism out of the
prompt and into the engine: it fills the `steps:` frontmatter `parseWorkflow` already reserves and strips.

**A workflow is a list of steps.** The engine runs them top to bottom; the model does the work *inside* each;
the human stands at the gates. Prose lanes stay — the graph says *when* a seat runs, the lane says *what* it
does when it gets there.

## 2. A step is one of five kinds

Distinguished in YAML by the key it carries (`normalizeNode` rejects a step with more than one kind-key, or
none, naming the id):

- **agent** (`run:`) — run one agent (or a team, routed to a member); `consumes`/`produces` name artifacts.
- **check** (`check:`) — verify an artifact against criteria; `on_fail` loops, bounded by `max_attempts`.
- **human** (`human:`) — pause, present a packet, route on the chosen option.
- **parallel** (`over:`/`branches:`) — fan out concurrently, optional `join`.
- **branch** (`branch:`) — classify, jump to a labelled step.

Most steps are a plain `agent` line; the others are reached only when a step needs them. The definition lives
in `teams/<id>/workflow.md` frontmatter (`workflow:` names it); `team` is injected from the path.

## 3. Nothing is invented — each kind is a seam

- agent → **executeRun** (the unit of work); state flows step→step as artifact **handles** via `inputArtifacts`.
- check → **runChecker** (Plan 06, already exported).
- human → **requestApproval** (the approval-card queue; the same suspension `ask_human` uses).
- parallel → **Promise.all(executeRun)** — one shared `spendLedger`/`runCounter`/`signal` bounds the fan-out.
- branch → a classifier **executeRun** + the `routes` map.

The driver (`core/workflow.ts`, `executeWorkflow`) is a **sixth caller** above executeRun (REPL, delegation,
scheduler, task cascade, headless are the other five). The step-runner is **injected** so the orchestration
is unit-testable without a live model; run.ts wires it.

## 4. Run state = fold(events), engine-owned

`workflows/<id>/runs/<runId>/events.jsonl` — append-only, engine-written. Current state = `fold(events)`
(last event per step wins; missing → pending). This is the Plan 18 discipline **minus** the
model-attempt/`rejected` split: the engine writes *every* event — a workflow step is never model-ticked, so no
attempt can lie. `reconcileWorkflowRuns` is the boot half: a step left `running` → append `interrupted`,
never rewrite history, report it. The **checkbox cannot lie**: a step is `done` only when its child run really
completed (and, for a check, only when the checker agreed).

## 5. Authoring — root proposes, the engine writes

The model never writes workflow canon (Plan 23's rule). `propose_workflow` (root-only, approval-gated, a twin
of `create_team`) drafts; the engine writes the `steps:` frontmatter only on the captain's approval. Not in
`DEFAULT_WORKER_TOOLS`.

## 6. Optional, always

No `steps:` → the team runs exactly as it does today (self-orchestration / Plan 23 prose). The presence of the
frontmatter is the whole opt-in; there is no mode to switch.

## 7. Triggers, and the one hard part

How a workflow *starts* is orthogonal: reuse the Plan 04 `Schedule` (cron/interval/watch); "pub-sub" is the
`watch` trigger. The genuinely-new, genuinely-hard piece: today `requestApproval` is an in-memory Promise, so
a workflow with a human gate is **attended-only** until a durable "awaiting-human" record (mirroring `tasks/`)
lets a scheduled run park, notify, and resume. That earns its own phase.

## 8. Phasing

1. **Schema + linear driver** — agent steps in order, artifact hand-off, shared budget. *(done)*
2. **Human gate** — `requestApproval` variant, packet, routes, revision-as-annotation (attended).
3. **check · parallel · branch** — the checker gate with `on_fail`; fan-out/join; classifier routing.
4. **/workflows UI** — list · workflow view · live run · past runs.
5. **propose_workflow** — the approval-gated authoring loop.
6. **Triggers + durable suspension** — schedule a workflow; park a human gate across a restart.

## 9. Surface

New: `src/schemas/workflow.ts`, `src/core/workflow.ts`, `src/store/workflow-runs.ts`, `src/ui/WorkflowBrowser.tsx`.
Touched: `store/workflows.ts` (load the def), `core/run.ts` (ApprovalRequest, the wired step-runner),
`core/tools.ts` (`propose_workflow`), `store/files.ts` (paths), `ui/App.tsx` (a docked surface), `roster.ts`
(root grant). Files are canon; a workflow-def file scan is the whole query surface (no DB table), like teams.

## 10. Testing

`bun:test`, `MockLanguageModelV3`, no network. `schemas/workflow.test.ts` (sugar → union, multi-kind rejection),
`store/workflow-runs.test.ts` (append/fold/reconcile), `core/workflow.test.ts` (the driver over an injected
step-runner: order, hand-off, failure-stop, abort, gates, branches). Gates: `bun run typecheck` · `bun test` ·
`bun run build`.
