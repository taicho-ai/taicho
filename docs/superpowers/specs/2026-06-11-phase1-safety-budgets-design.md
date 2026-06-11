# taicho v1 · Phase 1 — Safety & Budgets (Design)

**Date:** 2026-06-11
**Status:** proposed (slice-start decisions resolved to roadmap recommendations; user waived the approval gate — "just do, check later")
**Roadmap items:** #1 safety-robustness + #2 budgets-spend (combined — they share the recursive `runChild` path and partial-token accounting).

---

## 1. Goal
Make taicho **safe to run autonomously** and **truthful + bounded about cost**: no delegation tree can cycle or run away, the captain can always stop a run, every run records what it actually spent (even on failure), and an agent/run-tree cannot exceed configured token/cost/work-item budgets.

**Definition of done:**
1. A pathological agent that keeps delegating hits a depth cap (≤5) and a per-request run ceiling (≤50) — both return recoverable tool errors, not crashes; a cycle (A→B→A) is refused.
2. Pressing **Esc during an in-flight run cancels it** (and its children); the run records `outcome:"interrupted"` with the partial token/cost actually spent.
3. `maxTokensPerRun` is enforced mid-loop; exceeding it ends the run `blocked` with an accurate token count.
4. Per-run **cost in USD** is computed (input/output split × a per-model price table) and recorded; `maxCostPerRun` is enforced.
5. `maxWorkItemsPerRequest` (= delegate fan-out per run) is enforced and returns a recoverable error.
6. A delegating run's trace reports **aggregate** tokens/cost across its whole run-tree, and the aggregate respects the cap.
7. A child run's failure degrades to a tool-result `{error}` — it never fails the parent.
8. Failed/aborted runs no longer record `tokens:0`.

## 2. Resolved slice-start decisions
| Decision | Resolution |
|---|---|
| Limit breach behavior | **Recoverable** `{error}` tool-result (model can self-correct), matching the existing unknown-target/ACL contract — never a thrown/hard fail. |
| Depth / run-tree ceilings | `MAX_DELEGATION_DEPTH = 5`, `MAX_RUNS_PER_REQUEST = 50`. Constants now; config-overridable in Phase 2. |
| Cancel key | **Esc while busy = cancel active run**; Esc while idle = quit (today's behavior). Avoids Ctrl-C vs Ink SIGINT collision. |
| Cancelled outcome | Reuse `outcome:"interrupted"` (already in the enum and used by the `reserveRunId` placeholder) — a cancelled run overwrites the placeholder with a real interrupted trace + partial spend. No new enum value, no reader migration. |
| "Work item" | **`delegate_task` fan-out count per run** (uses existing `delegatedOut`/`counts`). |
| Token vs cost primacy | **Tokens = always-on hard cap** (exact, provider-agnostic). **Cost = advisory cap** (depends on price-table accuracy); unknown model → cost 0 + recorded warning, never crash. |
| Aggregate scope | **Per-run-tree, in-memory** (parent sums descendants). Durable org/lifetime budgets = post-v1 (need persistence). |
| Partial accounting | `runLoop` tracks tokens/iterations/toolCalls in a way that survives throw/abort and is returned to `executeRun`. |

## 3. Design

### 3.1 Delegation depth / cycle / fan-out guard (`core/run.ts`, `core/tools.ts`)
- `executeRun` opts gain `depth?: number` (default 0) and `ancestry?: string[]` (agent-id chain). `runChild` calls with `depth+1` and `ancestry+[opts.agent.id]`.
- A shared **run counter** lives on `RunDeps` (a `{ n: number }` ref or counter fn), incremented per `executeRun`, scoped to one top-level request.
- `delegate_task.execute` checks, in order, returning a recoverable `{error}` on any miss: `canDelegate` (exists) → target exists (exists) → `depth+1 > MAX_DELEGATION_DEPTH` → `to ∈ ancestry` (cycle) → `runCounter ≥ MAX_RUNS_PER_REQUEST`. Each refusal is recorded in the trace (a refusal note in `toolCalls`/a new `notes` field — see §4).
- `RunContext` exposes `delegationGuard(to): {ok:true} | {ok:false, error:string}` so the tool stays thin and the policy is testable in isolation.

### 3.2 Cancel / AbortSignal (`core/loop.ts`, `core/run.ts`, `ui/App.tsx`)
- `RunDeps` gains `signal?: AbortSignal`. `executeRun` passes it down; `runChild` shares the **same** signal (cancel cascades to the whole tree).
- `runLoop` checks `signal?.aborted` at the top of each iteration → stops, returns a result flagged `aborted: true`. `generateText` is also called with `abortSignal: signal` so an in-flight model call is interrupted (its tokens for that call may be lost — accepted; see risks).
- `executeRun` maps `aborted` → `outcome:"interrupted"`, recording tokens spent so far.
- `App.tsx`: hold an `AbortController` per top-level run in a ref. `useInput`: when **busy**, Esc calls `controller.abort()` (and shows "⊗ cancelling…"); when **not busy**, Esc quits (current behavior). The `{isActive:!pending}` gate stays.

### 3.3 Partial-token accounting (`core/loop.ts`, `core/run.ts`)
- `runLoop` already accumulates `tokens`/`counts`/`iterations` locally. Restructure so they're returned even on the error/abort path: wrap the model call in try/catch; on throw, return a `LoopResult` with `{text:"[error]", error: message, tokens, toolCalls, iterations, exhausted:false, aborted:false}` (or re-throw a custom error carrying partials — chosen impl: **return a result with an `error` field**, so `executeRun` branches on `result.error`/`result.aborted`/`result.exhausted` instead of try/catch-as-control-flow).
- `executeRun` records `result.tokens`/cost into the trace regardless of outcome (failed/blocked/interrupted/completed).

### 3.4 Token + cost budgets (`schemas/agent.ts`, `core/loop.ts`, `core/pricing.ts` new, `core/run.ts`, `schemas/trace.ts`)
- `AgentDef.budgets` gains `maxTokensPerRun?: number` and `maxCostPerRunUsd?: number` (both optional; undefined = uncapped for that dimension; `maxIterationsPerRun` stays).
- `runLoop` captures the input/output split from `res.usage` (`inputTokens`/`outputTokens`, not just `totalTokens`) per iteration, accumulating `{inputTokens, outputTokens, totalTokens}`.
- New `core/pricing.ts`: `priceUsd(provider, model, {inputTokens, outputTokens}): number` over a hardcoded `provider:model → {inUsdPerMTok, outUsdPerMTok}` table; unknown model → 0 + a one-time `console.warn`. (Pure, unit-tested.)
- `runLoop` enforces **before each generateText call**: if accumulated `totalTokens ≥ maxTokensPerRun` OR `costUsd ≥ maxCostPerRunUsd`, stop with `exhausted:true` (→ `outcome:"blocked"`). Mid-iteration only — a single in-flight call can overshoot by one generation (documented, not a bug).
- `RunTrace` gains `costUsd: number` (default 0) and `aggregate?: {tokens:number, costUsd:number}` for run-tree totals.

### 3.5 work-items + aggregate roll-up (`core/tools.ts`, `core/run.ts`)
- `delegate_task.execute` increments a per-run `workItems` counter (on `RunContext`); if `> agent.budgets.maxWorkItemsPerRequest`, return recoverable `{error:"work item budget exhausted"}` (no child spawned).
- `runChild` returns its `RunResult` (already does); `executeRun` sums each child's `trace.aggregate ?? {tokens,costUsd}` into this run's aggregate, and enforces `maxTokensPerRun`/`maxCostPerRunUsd` against the **aggregate** too (so a delegating root's cap bounds the whole tree).

## 4. Schema / type deltas
- `schemas/agent.ts`: `budgets.maxTokensPerRun?`, `budgets.maxCostPerRunUsd?`.
- `schemas/trace.ts`: `RunTrace.costUsd` (number, default 0), `RunTrace.aggregate?` ({tokens, costUsd}); optionally `RunTrace.notes?: string[]` for refusal records (depth/cycle/work-item) so `/trace` can show *why* a delegation was refused.
- `core/loop.ts`: `LoopResult` gains `inputTokens`/`outputTokens`, `error?: string`, `aborted: boolean` (already has `exhausted`).
- `core/run.ts`: `RunDeps.signal?`, run-counter; `RunContext.delegationGuard`, `workItems`.

## 5. Error handling
| Condition | Behavior |
|---|---|
| Depth/cycle/run-ceiling/work-item breach | Recoverable `{error}` tool-result + trace note; parent run continues. |
| Esc during run | Abort cascades to tree; `outcome:"interrupted"`, partial tokens/cost recorded. |
| Token/cost cap hit | `outcome:"blocked"` (reuse exhausted path), accurate accounting. |
| Model throw | `outcome:"failed"`, partial tokens/cost recorded (no more `tokens:0`), `console.error`. |
| Unknown model in price table | costUsd 0 + one-time warn; never crash. |
| Child run failure | Degrades to `{error}` tool-result in the parent (try/catch around `runChild`). |

## 6. Testing (TDD, `bun test`, network-free via `MockLanguageModelV3`)
- **pricing.ts** (pure): known model → correct USD; unknown → 0 + warn.
- **Depth guard:** a self-delegating agent (`canDelegateTo:["*"]`, low `maxIterationsPerRun`) → delegation refused at depth 5 with `{error}`, parent completes, trace notes the refusal; terminates (no stack blow-up).
- **Cycle:** A delegates to B delegates to A → refused.
- **Run ceiling / work-items:** fan-out past `maxWorkItemsPerRequest` → refused; run-counter past `MAX_RUNS_PER_REQUEST` → refused.
- **Token cap:** agent with `maxTokensPerRun` small + always-tool-call model → `outcome:"blocked"`, `trace.tokens` ≈ cap (not 0).
- **Cost cap:** same with `maxCostPerRunUsd` + a priced mock model.
- **Abort:** an `AbortController` aborted after the first iteration → run stops, `outcome:"interrupted"`, `tokens>0`. (`runLoop` checks `signal.aborted`.)
- **Partial accounting on throw:** throwing mock after a prior tool-call iteration → `outcome:"failed"`, `tokens>0`.
- **Aggregate:** root delegates to a worker that spends tokens → root `trace.aggregate.tokens` ≥ child tokens.
- App.tsx cancel wiring is manual-verify (no Ink test harness) — the abort logic itself is tested at the `runLoop`/`executeRun` layer.

## 7. Out of scope (Phase 1)
- Durable cross-session/org-wide/lifetime spend ledgers (need persistence — Phase 3+).
- Config-driven limit overrides (Phase 2 / config); Phase 1 ships constants + per-agent budget fields.
- Reviving `task_ledger` (dedup, unrelated).
- Graceful salvage of an in-flight generation's tokens on abort (accept loss of the current call).
- Approval-to-extend-budget UX (post-v1).

## 8. Build order (each its own TDD task, runnable + committed)
1. `pricing.ts` + tests (pure, no deps).
2. `LoopResult` deltas + `runLoop`: input/output capture, token/cost cap enforcement, abort check, partial-on-error return + tests.
3. `schemas` deltas (agent budgets, trace costUsd/aggregate/notes) + `executeRun`: cost compute, outcome mapping from structured flags, partial recording + tests.
4. Delegation guard (depth/cycle/run-ceiling/work-items) in `run.ts`/`tools.ts` + tests.
5. Aggregate roll-up across `runChild` + tests.
6. `App.tsx` Esc-cancel wiring (`AbortController` per run) + manual smoke.
7. Full green + final review.
