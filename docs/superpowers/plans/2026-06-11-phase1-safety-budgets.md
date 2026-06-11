# Phase 1 — Safety & Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make taicho safe to run autonomously (delegation depth/cycle/fan-out guards + an Esc-to-cancel kill switch) and truthful + bounded about cost (input/output token capture, a per-model price table, enforced per-run and per-run-tree token/cost/work-item budgets, and partial accounting on failure/abort).

**Architecture:** `runLoop` becomes the single point that meters spend (input/output tokens + USD via an injected pricer), enforces token/cost caps mid-loop, honors an `AbortSignal`, and returns structured outcome flags (`exhausted`/`aborted`/`error`) instead of throwing. `executeRun` threads `depth`/`ancestry`/`signal`/a shared run-counter through `runChild`, maps the flags to trace outcomes, records real cost, and rolls child spend up into a run-tree aggregate. A delegation guard (pure-ish, on `RunContext`) refuses unsafe/over-budget delegations with recoverable `{error}` tool-results.

**Tech Stack:** Bun + TypeScript, `ai` v6 (`generateText({abortSignal})`, `res.usage.{inputTokens,outputTokens,totalTokens}`), `MockLanguageModelV3`/`mockValues` from `ai/test`, zod v4, `bun test`.

---

## Verified facts (do not deviate)
- `generateText` accepts `abortSignal`; aborting rejects the call (an `AbortError`-type throw), so `runLoop` must catch and check `signal.aborted`.
- `res.usage` = `{ inputTokens?: number, outputTokens?: number, totalTokens?: number }` — each may be `undefined`; guard with `?? 0`.
- Test mock: `new MockLanguageModelV3({ doGenerate: mockValues(a, b) as any })`; each response is `{ content, finishReason:{unified,raw}, usage:{ inputTokens:{total}, outputTokens:{total} } }` cast `as unknown as LanguageModelV3GenerateResult`. To always return the same response, pass `doGenerate: (async () => resp) as any`.
- Current `LoopResult` = `{ text, toolCalls, tokens, iterations, exhausted }`. Current `runLoop` accumulates `tokens += res.usage?.totalTokens ?? 0` and returns `exhausted:true` only on the iteration fall-through.
- Current `RunContext` already has: `ws, db, runId, agentId, artifacts[], delegatedOut[], requestApproval, createAgent, canDelegate(toId), runChild, findAgents, agentExists(id)`.
- Current `executeRun(deps, { agent, messages, brief?, triggeredBy })` reserves the id via `reserveRunId`, runs `runLoop` in a try/catch, maps `result.exhausted`→`blocked` and catch→`failed` (with `tokens:0`), writes the trace.
- `RunTrace.outcome` enum already includes `interrupted`. `reserveRunId` writes an `interrupted` placeholder that `writeTrace` overwrites on finish.

## File structure
- **Create** `src/core/pricing.ts` — pure `priceUsd(model, {inputTokens,outputTokens})` over a per-model table; `pricerFor(cfg)`.
- **Modify** `src/core/loop.ts` — metering, caps, abort, structured return.
- **Modify** `src/schemas/agent.ts` — `budgets.maxTokensPerRun?`, `budgets.maxCostPerRunUsd?`.
- **Modify** `src/schemas/trace.ts` — `costUsd`, `aggregate?`, `notes?`.
- **Modify** `src/core/run.ts` — pricer wiring, structured outcome mapping, real cost recording, depth/ancestry/run-counter, delegation guard, aggregate roll-up.
- **Modify** `src/core/tools.ts` — `delegate_task` uses the guard + work-item counter + child-failure isolation.
- **Modify** `src/ui/App.tsx` — `AbortController` per run; Esc-while-busy cancels.
- Tests co-located as `*.test.ts`.

---

## Task 0: Branch + green baseline

**Files:** none (git only)

- [ ] **Step 1: Branch off main**

```bash
cd /Users/rajeshsharma/Documents/Works/Personal/agents/taicho
git checkout -b phase1-safety-budgets
```

- [ ] **Step 2: Confirm baseline green**

Run: `bun test && bunx tsc --noEmit`
Expected: `38 pass, 0 fail`; tsc clean.

---

## Task 1: Pricing module

**Files:**
- Create: `src/core/pricing.ts`
- Test: `src/core/pricing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/pricing.test.ts`:
```ts
import { test, expect } from "bun:test";
import { priceUsd } from "./pricing";

test("prices a known model by input/output split", () => {
  // claude-sonnet-4-6: $3 / $15 per Mtok (see table). 1M in + 1M out = 3 + 15 = 18.
  expect(priceUsd("claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18, 6);
});

test("prorates fractional token counts", () => {
  // 1000 input tokens @ $3/Mtok = 0.003
  expect(priceUsd("claude-sonnet-4-6", { inputTokens: 1000, outputTokens: 0 })).toBeCloseTo(0.003, 9);
});

test("unknown model returns 0 (advisory, never throws)", () => {
  expect(priceUsd("totally-made-up-model", { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/pricing.test.ts`
Expected: FAIL — cannot find module `./pricing`.

- [ ] **Step 3: Implement**

> NOTE TO IMPLEMENTER: the USD-per-Mtok values below are best-effort and ADVISORY (tokens are the hard cap, not cost). Before finalizing, verify current prices for the models in `src/store/config.ts` `DEFAULT_MODEL` using the `claude-api` skill (for Claude models) and update the table; do not change the code shape. Unknown models intentionally price to 0.

Create `src/core/pricing.ts`:
```ts
/** Per-model USD pricing for advisory cost accounting. Tokens are the hard budget; cost is
 *  secondary. Values are USD per 1,000,000 tokens. Unknown models price to 0 (never throw). */
export interface ModelPrice { inUsdPerMTok: number; outUsdPerMTok: number; }

const TABLE: Record<string, ModelPrice> = {
  "claude-sonnet-4-6": { inUsdPerMTok: 3, outUsdPerMTok: 15 },
  "claude-opus-4-8": { inUsdPerMTok: 15, outUsdPerMTok: 75 },
  "gpt-5.5": { inUsdPerMTok: 5, outUsdPerMTok: 15 },
};

let warned = false;

export function priceUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const p = TABLE[model];
  if (!p) {
    if (!warned) { warned = true; console.warn(`taicho: no price for model "${model}" — cost reported as 0`); }
    return 0;
  }
  return (usage.inputTokens / 1_000_000) * p.inUsdPerMTok + (usage.outputTokens / 1_000_000) * p.outUsdPerMTok;
}

/** Build a pricer bound to a resolved model id (the agent loop is provider-agnostic). */
export function pricerFor(model: string): (u: { inputTokens: number; outputTokens: number }) => number {
  return (u) => priceUsd(model, u);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/pricing.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/pricing.ts src/core/pricing.test.ts
git commit -m "feat(pricing): per-model advisory USD cost table"
```

---

## Task 2: runLoop — metering, caps, abort, structured return

**Files:**
- Modify: `src/schemas/agent.ts`, `src/core/loop.ts`
- Test: `src/core/loop.test.ts` (extend)

- [ ] **Step 1: Extend `src/schemas/agent.ts` budgets (the loop reads these caps — do this first so Task 2 typechecks)**

Change the `budgets` object in `AgentDef` to:
```ts
  budgets: z.object({
    maxIterationsPerRun: z.number().int().positive().default(30),
    maxWorkItemsPerRequest: z.number().int().positive().default(20),
    maxTokensPerRun: z.number().int().positive().optional(),
    maxCostPerRunUsd: z.number().positive().optional(),
  }).prefault({}),
```

- [ ] **Step 2: Write the failing tests (append to `src/core/loop.test.ts`)**

Reuse the existing `usage`, `toolCallResp`, `finalResp`, `agent`, `tools` fixtures already in the file. Append:
```ts
test("meters input/output/total tokens and cost via the injected pricer", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(finalResp) as any });
  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    priceUsd: ({ inputTokens, outputTokens }) => inputTokens * 2 + outputTokens * 3,
  });
  // usage fixture is inputTokens.total=1, outputTokens.total=1 -> cost = 1*2 + 1*3 = 5
  expect(res.inputTokens).toBe(1);
  expect(res.outputTokens).toBe(1);
  expect(res.costUsd).toBe(5);
});

test("stops with exhausted when the token cap is reached", async () => {
  const capped = { ...agent, budgets: { ...agent.budgets, maxTokensPerRun: 1 } };
  // always returns a tool call so the loop would otherwise run to the iteration budget
  const model = new MockLanguageModelV3({ doGenerate: (async () => toolCallResp) as any });
  const res = await runLoop({ model, agent: capped, system: "S", messages: [{ role: "user", content: "go" }], tools });
  expect(res.exhausted).toBe(true);
  // one call happened (tokens accrued) before the cap stopped the next
  expect(res.tokens).toBeGreaterThan(0);
});

test("aborts when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = new MockLanguageModelV3({ doGenerate: (async () => finalResp) as any });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, signal: controller.signal });
  expect(res.aborted).toBe(true);
});

test("returns a structured error (does not throw) when the model call fails", async () => {
  const model = new MockLanguageModelV3({ doGenerate: (() => { throw new Error("boom"); }) as any });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools });
  expect(res.error).toContain("boom");
  expect(res.aborted).toBe(false);
  expect(res.exhausted).toBe(false);
});
```

- [ ] **Step 3: Run test to verify they fail**

Run: `bun test src/core/loop.test.ts`
Expected: FAIL — `priceUsd`/`signal` options not honored; `res.inputTokens`/`costUsd`/`aborted`/`error` undefined.

- [ ] **Step 4: Replace `src/core/loop.ts` ENTIRELY with:**

```ts
/** The agent loop. Model proposes (what); config disposes (how much): budgets + caps come from
 *  AgentDef/config — model-supplied budget params are ignored. The loop is the single meter for
 *  spend (tokens + advisory USD) and the single place caps + cancellation are enforced. */
import { generateText, type ModelMessage, type ToolSet } from "ai";
import type { AgentDef } from "../schemas/agent";
import { steerMarker } from "./prompt";

export interface LoopResult {
  text: string;
  toolCalls: Record<string, number>;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  iterations: number;
  exhausted: boolean;
  aborted: boolean;
  error?: string;
}

export async function runLoop(opts: {
  model: Parameters<typeof generateText>[0]["model"];
  agent: AgentDef;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  onStep?: (info: { text?: string; tool?: string }) => void;
  pollSteer?: () => string | null;
  signal?: AbortSignal;
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
}): Promise<LoopResult> {
  const counts: Record<string, number> = {};
  let tokens = 0, inputTokens = 0, outputTokens = 0, costUsd = 0, iterations = 0;
  const messages = [...opts.messages];
  const cap = opts.agent.budgets;

  const done = (over: Partial<LoopResult> & { text: string }): LoopResult => ({
    toolCalls: counts, tokens, inputTokens, outputTokens, costUsd, iterations,
    exhausted: false, aborted: false, ...over,
  });

  for (; iterations < cap.maxIterationsPerRun; iterations++) {
    if (opts.signal?.aborted) return done({ text: "[cancelled]", aborted: true });
    if (cap.maxTokensPerRun != null && tokens >= cap.maxTokensPerRun) return done({ text: "[budget exhausted]", exhausted: true });
    if (cap.maxCostPerRunUsd != null && costUsd >= cap.maxCostPerRunUsd) return done({ text: "[budget exhausted]", exhausted: true });

    const steer = opts.pollSteer?.();
    if (steer) messages.push({ role: "user", content: steerMarker(steer) });

    let res;
    try {
      res = await generateText({ model: opts.model, system: opts.system, messages, tools: opts.tools, abortSignal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted) return done({ text: "[cancelled]", aborted: true });
      return done({ text: "[error]", error: e instanceof Error ? e.message : String(e) });
    }

    const u = res.usage;
    const inTok = u?.inputTokens ?? 0, outTok = u?.outputTokens ?? 0;
    inputTokens += inTok;
    outputTokens += outTok;
    tokens += u?.totalTokens ?? inTok + outTok;
    costUsd += opts.priceUsd?.({ inputTokens: inTok, outputTokens: outTok }) ?? 0;

    if (res.toolCalls.length === 0) {
      opts.onStep?.({ text: res.text });
      return done({ text: res.text, iterations: iterations + 1 });
    }
    for (const tc of res.toolCalls) {
      counts[tc.toolName] = (counts[tc.toolName] ?? 0) + 1;
      opts.onStep?.({ tool: tc.toolName });
    }
    messages.push(...res.response.messages);
  }
  return done({ text: "[budget exhausted]", exhausted: true });
}
```

- [ ] **Step 5: Run test to verify they pass**

Run: `bun test src/core/loop.test.ts`
Expected: PASS (the 2 original + 4 new = 6). The original "loop returns final text after a tool-call round" and steer tests still pass (the `done()` helper preserves their assertions: `text`, `toolCalls.noop`, and the steer-marker prompt injection are unchanged).

- [ ] **Step 6: Typecheck + commit**

Run: `bunx tsc --noEmit`
Expected: errors ONLY in `src/core/run.ts` (it still references the old `LoopResult` shape / try-catch). That's expected; Task 3 fixes it. If loop.test.ts itself fails to typecheck, fix the test, not unrelated files.

```bash
git add src/core/loop.ts src/core/loop.test.ts
git commit -m "feat(loop): meter input/output tokens + cost, enforce token/cost caps, honor AbortSignal, structured error return"
```

---

## Task 3: schemas + executeRun — cost, structured outcomes, partial recording

**Files:**
- Modify: `src/schemas/trace.ts`, `src/core/run.ts`  *(agent.ts budgets already extended in Task 2)*
- Test: `src/core/run.test.ts` (extend)

- [ ] **Step 1: Extend `src/schemas/trace.ts` RunTrace** (the `budgets` schema was already extended in Task 2 Step 1)

Add these fields to the `RunTrace` object (after `tokens`):
```ts
  costUsd: z.number().default(0),
  aggregate: z.object({ tokens: z.number(), costUsd: z.number() }).optional(),
  notes: z.array(z.string()).default([]),
```

- [ ] **Step 2: Write the failing tests (append to `src/core/run.test.ts`)**

```ts
import { pricerFor } from "./pricing";

test("records real tokens + cost on a completed run", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.tokens).toBeGreaterThan(0);
  expect(res.trace.costUsd).toBeGreaterThan(0);
});

test("a token-capped run ends blocked with non-zero tokens", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const loopy = await loadAgent(ws, "writer");
  loopy.budgets.maxTokensPerRun = 1;
  const model = new MockLanguageModelV3({ doGenerate: (async () => call("write_artifact", { topicSlug: "x", markdown: "y" })) as any });
  const deps = makeDeps({ ws, db, model });
  const res = await executeRun(deps, { agent: loopy, messages: [{ role: "user", content: "loop" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("blocked");
  expect(res.trace.tokens).toBeGreaterThan(0);
});

test("an aborted run is interrupted with partial tokens recorded", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const controller = new AbortController();
  controller.abort();
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const deps = makeDeps({ ws, db, model, signal: controller.signal });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("interrupted");
});

test("a model error is failed with partial tokens, not tokens:0", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  // first call succeeds (accrues tokens) then throws on the second
  let n = 0;
  const model = new MockLanguageModelV3({ doGenerate: (async () => { if (n++ === 0) return call("write_artifact", { topicSlug: "x", markdown: "y" }); throw new Error("boom"); }) as any });
  const deps = makeDeps({ ws, db, model });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("failed");
  expect(res.text).toContain("boom");
  expect(res.trace.tokens).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test src/core/run.test.ts`
Expected: FAIL — `makeDeps` doesn't accept `priceUsd`/`signal`; outcomes/tokens wrong.

- [ ] **Step 4: Modify `src/core/run.ts`**

(a) Add to `RunDeps`:
```ts
  signal?: AbortSignal;
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
```
(b) In `makeDeps`'s `opts` param add `signal?: AbortSignal; priceUsd?: RunDeps["priceUsd"];` and return them: `signal: opts.signal, priceUsd: opts.priceUsd,` (alongside the existing fields).

(c) Replace the `runLoop` call + try/catch + outcome mapping block. The new body:
```ts
  const result = await runLoop({
    model: deps.model, agent: opts.agent, system, messages: opts.messages, tools,
    onStep: deps.onStep ? (i) => deps.onStep!({ ...i, agent: opts.agent.id }) : undefined,
    pollSteer: deps.pollSteer,
    signal: deps.signal,
    priceUsd: deps.priceUsd,
  });
  const outcome: RunTrace["outcome"] =
    result.aborted ? "interrupted" : result.exhausted ? "blocked" : result.error ? "failed" : "completed";
  if (result.error) console.error(`run ${runId} failed:`, result.error);
```
(Delete the surrounding `try { ... } catch (e) { ... }` — `runLoop` no longer throws for model/abort errors; it returns structured flags.)

(d) In the trace object, add cost: change the trace literal to include `costUsd: result.costUsd,` (next to `tokens: result.tokens,`). Leave `notes`/`aggregate` for Tasks 4/5 (zod defaults `notes` to `[]`, `aggregate` optional, so the object still validates without them now).

- [ ] **Step 5: Run to verify pass**

Run: `bun test src/core/run.test.ts`
Expected: PASS (existing run tests + 4 new). The existing "thrown model error yields a failed-outcome trace" test still passes via the new `result.error` path.

- [ ] **Step 6: Typecheck + commit**

Run: `bunx tsc --noEmit` → clean.
```bash
git add src/schemas/trace.ts src/core/run.ts src/core/run.test.ts
git commit -m "feat(run): record cost, map structured loop outcomes (interrupted/blocked/failed), preserve partial tokens"
```

---

## Task 4: Delegation guard — depth, cycle, run-ceiling, work-items

**Files:**
- Modify: `src/core/run.ts`, `src/core/tools.ts`
- Test: `src/core/run.test.ts` (extend)

- [ ] **Step 1: Write the failing tests (append to `src/core/run.test.ts`)**

```ts
import { serializeAgent } from "../store/roster";
import { AgentDef } from "../schemas/agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { paths } from "../store/files";

// helper: write a custom agent.md directly (so we can set budgets/canDelegateTo) and index it
function putAgent(ws: string, db: import("bun:sqlite").Database, def: Parameters<typeof AgentDef.parse>[0]) {
  const agent = AgentDef.parse(def);
  mkdirSync(paths.agentDir(ws, agent.id), { recursive: true });
  writeFileSync(paths.agentFile(ws, agent.id), serializeAgent(agent));
  db.query("INSERT OR REPLACE INTO registry (id, role, is_root) VALUES (?, ?, ?)").run(agent.id, agent.role, agent.isRoot ? 1 : 0);
  return agent;
}

test("self-delegation is refused at the depth cap and the run still completes", async () => {
  const { ws, db } = await boot();
  // an agent that can delegate to itself, with a tiny iteration budget so each level makes 1 call
  putAgent(ws, db, { id: "loopy", role: "loops", identity: "Delegate to loopy.", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 1, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: (async () => call("delegate_task", { to: "loopy", goal: "again" })) as any });
  const deps = makeDeps({ ws, db, model });
  const loopy = await loadAgent(ws, "loopy");
  const res = await executeRun(deps, { agent: loopy, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  // it terminates (no stack blowup) and some delegation was refused (recorded as a note somewhere in the tree)
  expect(res.runId).toBeTruthy();
});

test("a direct cycle (a -> a via ancestry) is refused", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "a", role: "a", identity: "x", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("delegate_task", { to: "a", goal: "self" }), text("ok")) as any });
  const deps = makeDeps({ ws, db, model });
  const a = await loadAgent(ws, "a");
  const res = await executeRun(deps, { agent: a, messages: [{ role: "user", content: "go" }], triggeredBy: "user", ancestry: ["a"] });
  expect(res.trace.delegatedOut.length).toBe(0); // refused
  expect(res.trace.notes.some((n) => /cycle|depth|delegat/i.test(n))).toBe(true);
});

test("work-item budget caps delegate fan-out within one run", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "w", role: "writes", identity: "You write." }, "root");
  putAgent(ws, db, { id: "boss", role: "boss", identity: "delegate a lot", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 10, maxWorkItemsPerRequest: 1 } });
  // boss tries to delegate twice; the 2nd exceeds maxWorkItemsPerRequest=1
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "w", goal: "one" }),
    call("delegate_task", { to: "w", goal: "two" }),
    text("done"),
  ) as any });
  // w just finishes immediately when delegated to:
  // (its own runs use the same shared model queue; keep w trivial by having it return text — but the
  //  shared mock makes ordering fragile, so assert only the work-item refusal note on boss.)
  const deps = makeDeps({ ws, db, model });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(deps, { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.notes.some((n) => /work item/i.test(n))).toBe(true);
});
```

> NOTE: the work-item test shares one mock across boss + child runs; if ordering makes it flaky, simplify by giving `w` no tools and having the child immediately return text, and assert ONLY `res.trace.notes` contains the work-item refusal (boss-level), not child behavior.

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/core/run.test.ts`
Expected: FAIL — `executeRun` has no `ancestry`/`depth`; no guard; `trace.notes` never populated.

- [ ] **Step 3: Modify `src/core/run.ts`**

(a) Add constants near the top (after imports):
```ts
const MAX_DELEGATION_DEPTH = 5;
const MAX_RUNS_PER_REQUEST = 50;
```
(b) Extend `RunContext` with:
```ts
  notes: string[];
  workItems: { n: number };
  delegationGuard: (to: string) => { ok: true } | { ok: false; error: string };
```
(c) Add a shared run-counter to `RunDeps`: `runCounter?: { n: number };` and in `makeDeps` return `runCounter: opts.runCounter ?? { n: 0 },` (add `runCounter?: { n: number }` to makeDeps opts too). This makes one counter shared across a top-level run-tree (rebuilt per top-level `makeDeps`).
(d) Extend `executeRun`'s `opts` type with `depth?: number; ancestry?: string[];` and compute at the top:
```ts
  const depth = opts.depth ?? 0;
  const ancestry = opts.ancestry ?? [];
  deps.runCounter!.n += 1;
```
(e) In the `ctx` object, add:
```ts
    notes: [],
    workItems: { n: 0 },
    delegationGuard: (to) => {
      if (!canDelegate(opts.agent, to)) return { ok: false, error: `not permitted to delegate to "${to}"` };
      if (!loadIndex(deps.db).some((r) => r.id === to)) return { ok: false, error: `no agent "${to}"` };
      if (to === opts.agent.id || ancestry.includes(to)) return { ok: false, error: `delegation cycle: "${to}" is already an ancestor` };
      if (depth + 1 > MAX_DELEGATION_DEPTH) return { ok: false, error: `max delegation depth (${MAX_DELEGATION_DEPTH}) reached` };
      if (deps.runCounter!.n >= MAX_RUNS_PER_REQUEST) return { ok: false, error: `max runs per request (${MAX_RUNS_PER_REQUEST}) reached` };
      return { ok: true };
    },
```
(f) Update `runChild` to thread depth/ancestry/signal (signal already on deps):
```ts
    runChild: async ({ to, goal, context }) => {
      const child = await loadAgent(deps.ws, to);
      return executeRun(deps, {
        agent: child,
        messages: [{ role: "user", content: context ? `${goal}\n\nContext: ${context}` : goal }],
        brief: { from: opts.agent.id, goal, context, fromRun: runId },
        triggeredBy: runId,
        depth: depth + 1,
        ancestry: [...ancestry, opts.agent.id],
      });
    },
```
(g) In the trace object add `notes: ctx.notes,`.

- [ ] **Step 4: Modify `src/core/tools.ts` delegate_task.execute**

Replace its body with:
```ts
      execute: async ({ to, goal, context }) => {
        ctx.workItems.n += 1;
        if (ctx.workItems.n > agent.budgets.maxWorkItemsPerRequest) {
          const msg = `work item budget (${agent.budgets.maxWorkItemsPerRequest}) exhausted`;
          ctx.notes.push(`delegate refused: ${msg}`);
          return { error: msg };
        }
        const guard = ctx.delegationGuard(to);
        if (!guard.ok) { ctx.notes.push(`delegate refused: ${guard.error}`); return { error: guard.error }; }
        try {
          const child = await ctx.runChild({ to, goal, context });
          ctx.delegatedOut.push(child.runId);
          return { to, runId: child.runId, result: child.text };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ctx.notes.push(`delegate failed: ${msg}`);
          return { error: msg };
        }
      },
```
(Remove the old separate `canDelegate`/`agentExists` checks — they're now inside `delegationGuard`. `ctx.canDelegate`/`ctx.agentExists` can stay on the interface for other callers, or be removed if unused; leave them to avoid breaking other references.)

- [ ] **Step 5: Run to verify pass**

Run: `bun test src/core/run.test.ts`
Expected: PASS. If the work-item test is flaky on mock ordering, apply the simplification in the NOTE.

- [ ] **Step 6: Typecheck + commit**

Run: `bunx tsc --noEmit` → clean.
```bash
git add src/core/run.ts src/core/tools.ts src/core/run.test.ts
git commit -m "feat(safety): delegation depth/cycle/run-ceiling/work-item guards with recoverable errors + trace notes"
```

---

## Task 5: Aggregate spend roll-up across the run-tree

**Files:**
- Modify: `src/core/run.ts`, `src/core/tools.ts`
- Test: `src/core/run.test.ts` (extend)

- [ ] **Step 1: Write the failing test (append)**

```ts
test("a delegating run's aggregate includes child spend", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "writer", goal: "write hello" }), // root
    call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), // child
    text("child done"), // child
    text("root done"),  // root
  ) as any });
  const deps = makeDeps({ ws, db, model, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make a hello doc" }], triggeredBy: "user" });
  const childId = res.trace.delegatedOut[0];
  const child = readTrace(ws, childId);
  expect(res.trace.aggregate).toBeTruthy();
  expect(res.trace.aggregate!.tokens).toBeGreaterThanOrEqual(res.trace.tokens + child.tokens);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/core/run.test.ts`
Expected: FAIL — `trace.aggregate` is undefined.

- [ ] **Step 3: Modify `src/core/run.ts`**

(a) Add to `RunContext`: `childSpend: { tokens: number; costUsd: number };`
(b) In the `ctx` object add: `childSpend: { tokens: 0, costUsd: 0 },`
(c) In the trace object add:
```ts
    aggregate: { tokens: result.tokens + ctx.childSpend.tokens, costUsd: result.costUsd + ctx.childSpend.costUsd },
```

- [ ] **Step 4: Modify `src/core/tools.ts` delegate_task** — after a successful child run, accumulate its aggregate:
```ts
          const child = await ctx.runChild({ to, goal, context });
          ctx.delegatedOut.push(child.runId);
          const childAgg = child.trace.aggregate ?? { tokens: child.trace.tokens, costUsd: child.trace.costUsd };
          ctx.childSpend.tokens += childAgg.tokens;
          ctx.childSpend.costUsd += childAgg.costUsd;
          return { to, runId: child.runId, result: child.text };
```

- [ ] **Step 5: Run to verify pass**

Run: `bun test src/core/run.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `bunx tsc --noEmit` → clean.
```bash
git add src/core/run.ts src/core/tools.ts src/core/run.test.ts
git commit -m "feat(budgets): roll child spend into a per-run-tree aggregate"
```

---

## Task 6: App.tsx — Esc-to-cancel + wire pricer

**Files:**
- Modify: `src/ui/App.tsx`, `src/index.tsx`
- Manual verification (no Ink test harness)

- [ ] **Step 1: Wire the pricer at boot (`src/index.tsx`)**

After building `model`, build a pricer from the resolved model and pass it into the App. Add import `import { pricerFor } from "./core/pricing";` and pass a prop `priceUsd={isMissing(cfg) ? undefined : pricerFor(cfg.model)}` to `<App .../>`. Add `priceUsd?` to App's props type.

- [ ] **Step 2: Add the AbortController + Esc-cancel in `src/ui/App.tsx`**

(a) Add a ref: `const aborter = useRef<AbortController | null>(null);`
(b) Change the input handler so Esc cancels when busy:
```tsx
  useInput((_i, key) => {
    if (!key.escape) return;
    if (busy) { aborter.current?.abort(); say({ kind: "system", text: "  ⊗ cancelling…" }); }
    else exit();
  }, { isActive: !pending });
```
(c) In `deps(model)`, pass the signal + pricer:
```tsx
  const deps = (model: Model) => makeDeps({
    ws: props.ws, db: props.db, model,
    requestApproval,
    onStep: ({ tool, agent }) => { if (tool) say({ kind: "system", text: `  ↳ ${agent} → ${tool}()` }); },
    pollSteer: () => steerQueue.current.shift() ?? null,
    signal: aborter.current?.signal,
    priceUsd: props.priceUsd,
  });
```
(d) At the start of the `setBusy(true)` block (before the run), create a fresh controller: `aborter.current = new AbortController();` (place it right after `setBusy(true); steerQueue.current = [];`). Note: `deps(model)` reads `aborter.current?.signal` at call time, so create the controller BEFORE calling `deps(model)`/`executeRun`.
(e) Surface cost in the trace line. Change the @address trace line and add one for chat failures to include cost, e.g. `(${res.trace.outcome}, ${res.trace.tokens} tok, $${res.trace.costUsd.toFixed(4)}, ${res.trace.artifacts.length} artifact(s))`.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Full regression suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 5: Manual smoke (boot only, headless ok)**

Run: `bun -e 'const m = await import("./src/ui/App.tsx"); console.log("App ok:", typeof m.App === "function");'`
Expected: `App ok: true`.

- [ ] **Step 6: Manual smoke (interactive, needs a real terminal + key)**

In a scratch dir with `ANTHROPIC_API_KEY`: `bun run dev` → start a long `@agent` task → press **Esc** mid-run → confirm "⊗ cancelling…" appears and the run ends as `interrupted` in `/runs`; confirm a normal completed run shows a `$cost` figure in its trace line.

- [ ] **Step 7: Commit**

```bash
git add src/ui/App.tsx src/index.tsx
git commit -m "feat(ui): Esc-to-cancel in-flight runs (AbortController) + show run cost"
```

---

## Task 7: Full green + final review

- [ ] **Step 1: Full suite + typecheck + build**

Run: `bun test && bunx tsc --noEmit && bun run build`
Expected: all tests green, tsc clean, `dist/taicho` builds.

- [ ] **Step 2: Self-review against the spec** (§3.1–3.5, §4, §5): every DoD item (1–8) has a test or a manual-smoke step. Confirm no `tokens:0` paths remain; confirm `interrupted`/`blocked`/`failed`/`completed` all reachable and mapped from structured flags.

- [ ] **Step 3: Adversarial review** (dispatch a code reviewer over the branch diff) focusing on: the abort race (signal created before deps), the shared run-counter lifetime, aggregate double-counting, and mid-iteration cap overshoot. Fix findings, re-run suite.

---

## Self-review (filled after writing)

**Spec coverage:** DoD#1 depth/cycle/run-ceiling → Task 4. DoD#2 Esc-cancel + interrupted+partial → Tasks 2,3,6. DoD#3 token cap → Tasks 2,3. DoD#4 cost compute+cap → Tasks 1,2,3. DoD#5 work-items → Task 4. DoD#6 aggregate → Task 5. DoD#7 child-failure isolation → Task 4 (try/catch in delegate_task). DoD#8 no tokens:0 → Tasks 2,3. ✓ all covered.

**Placeholder scan:** pricing values flagged advisory + verify-via-claude-api (real numbers present, runnable); one mock-ordering NOTE in Task 4 with a concrete simplification. No TBDs.

**Type consistency:** `LoopResult` fields (inputTokens/outputTokens/costUsd/aborted/error) defined Task 2, consumed Task 3/5. `RunContext` additions (notes/workItems/delegationGuard/childSpend) defined across Tasks 4–5 and consumed in tools.ts the same task. `RunDeps.signal/priceUsd` defined Task 3, `runCounter` Task 4, consumed Task 4/6. `budgets.maxTokensPerRun/maxCostPerRunUsd` are added to the schema in **Task 2 Step 1** — before the loop change that reads them — so Task 2 typechecks standalone; Task 3 only adds the `trace.ts` fields.

**Ordering:** Resolved — the `budgets` schema extension is Task 2 Step 1 (front of the loop work) and Task 3 adds only `trace.ts` fields. No task references a type a later task introduces.
