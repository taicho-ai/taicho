# Plan 20 — Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement the seven fixes in `docs/superpowers/specs/2026-07-13-plan-20-hardening-design.md` — no new features, make existing claims true.

**Architecture:** Three independent PRs off `main`, each a worktree branch: PR 1 `plan-20-engine` (idle timer + checker honesty, Tasks 1–3), PR 2 `plan-20-repl` (settle wiring + focus ring + roster reindex + SIGTERM, Tasks 4–8), PR 3 `plan-20-cleanup` (dead scenarios + phantom entry + atomic task writes, Tasks 9–11). PRs touch disjoint line regions; any order merges cleanly.

**Tech Stack:** Bun + TypeScript ESM, `bun:test`, ink-testing-library (Layer 1), `src/core/mock-model.ts` for model mocks (auto-streams a `doGenerate` script).

## Global Constraints

- The repo root is the captain's LIVE workspace — implement in a worktree (`git worktree add ../taicho-plan-20 -b <branch> main && cd ../taicho-plan-20 && bun install`), never in the root.
- Gate per PR: `bun run typecheck` AND `bun test` green, plus `bun run build` (engine/provider imports).
- No network in tests; model calls use `MockLanguageModelV3` (import from `src/core/mock-model.ts`, NOT `ai/test` — the loop streams everything since Plan 07).
- Never `console.*` from engine/store code (Plan 03) — use `log` from `core/logger.ts`.
- Schema changes must be additive (`.optional()` / `.default()`) so old on-disk records keep parsing.

---

## PR 1 — engine (`plan-20-engine`)

### Task 1: Idle-timer counter + error-path cleanup (`loop.ts`)

**Files:**
- Modify: `src/core/loop.ts:19-25` (header comment), `src/core/loop.ts:215-251` (timer state), `src/core/loop.ts:288-298` (onChunk), `src/core/loop.ts:301-308` (race + cleanup)
- Test: `src/core/loop.test.ts`

**Interfaces:** none exported — behavior-only.

- [x] **Step 1: Write the failing test** (in `loop.test.ts`, after the existing idle-timer tests; reuse the file's `streamSeq` helper and chunk-builder style — copy the shape of the existing single-tool idle test):

```ts
test("parallel tool calls: the idle timer stays disarmed until the LAST tool finishes (counter, not boolean)", async () => {
  // Two tool-calls in ONE assistant turn. Tool A resolves fast (its tool-result chunk re-armed the
  // OLD boolean timer); tool B keeps executing past timeoutMs with no chunks — the old code killed
  // it with "model stream idle", the counter keeps the timer disarmed until B's result.
  const toolCallChunks = [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r1", modelId: "m", timestamp: new Date(0) },
    { type: "tool-call", toolCallId: "a", toolName: "fast_tool", input: "{}" },
    { type: "tool-call", toolCallId: "b", toolName: "slow_tool", input: "{}" },
    { type: "finish", finishReason: "tool-calls", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
  const finalChunks = [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r2", modelId: "m", timestamp: new Date(0) },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "both tools done" },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
  ];
  const model = new MockLanguageModelV3({ doStream: streamSeq(toolCallChunks, finalChunks) });
  const ran: string[] = [];
  const res = await runLoop({
    model, agent: AGENT, system: "s",
    messages: [{ role: "user", content: "go" }],
    modelRequestTimeoutMs: 150, // idle deadline far below slow_tool's 400ms execution
    tools: {
      fast_tool: tool({ description: "f", inputSchema: z.object({}), execute: async () => { ran.push("fast"); return "ok"; } }),
      slow_tool: tool({ description: "s", inputSchema: z.object({}), execute: async () => { await sleep(400); ran.push("slow"); return "ok"; } }),
    },
  });
  expect(ran.sort()).toEqual(["fast", "slow"]);
  expect(res.error).toBeUndefined();          // OLD code: "model stream idle for 150ms…"
  expect(res.text).toContain("both tools done");
});
```

(`AGENT`, `sleep`, `tool`, `z` all already exist in `loop.test.ts` — reuse them.)

- [x] **Step 2: Run it, verify it fails for the right reason**

Run: `bun test src/core/loop.test.ts -t "parallel tool calls"`
Expected: FAIL — `res.error` is `"model stream idle for 150ms (no chunks, no tool execution)"`.

- [x] **Step 3: Implement.** In `loop.ts` replace the timer state block (lines 223-246):

```ts
      let streamErr: unknown;
      // Plan 20: a COUNTER, not a boolean — two parallel tool calls in one turn mean the first
      // tool-result must NOT re-arm the timer while the second tool is still executing (the false-kill
      // class Plan 12 was written to remove). Re-arm only when the last executing tool finishes.
      let toolsExecuting = 0;
      const timeoutMs = opts.modelRequestTimeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
      // Timer state — per-run, not global (concurrency-safe)
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let rejectIdle: ((err: Error) => void) | null = null;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (toolsExecuting > 0) return; // disarmed while ANY tool executes
        idleTimer = setTimeout(() => {
          const err = new Error(`model stream idle for ${timeoutMs}ms (no chunks, no tool execution)`);
          (err as Error & { code?: string }).code = "ETIMEDOUT";
          rejectIdle?.(err);
        }, timeoutMs);
      };
      const onToolStart = () => {
        toolsExecuting += 1;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      };
      const onToolEnd = () => {
        toolsExecuting = Math.max(0, toolsExecuting - 1);
        if (toolsExecuting === 0) resetIdleTimer();
      };
```

In `onChunk` (lines 292-298) replace the two `setToolExecuting(...)` calls with `onToolStart()` / `onToolEnd()`. Wrap the race so the timer ALWAYS clears (replace lines 304-308):

```ts
      try {
        await (chatSpan
          ? otelContext.with(otelTrace.setSpan(otelContext.active(), chatSpan), consume)
          : consume());
      } finally {
        // Plan 20: clear on EVERY path — a throw used to leak the armed setTimeout per failed iteration.
        if (idleTimer) clearTimeout(idleTimer);
      }
```

- [x] **Step 4: Fix the lying header** (lines 19-25) — replace with:

```ts
// Plan 12 (+ reopened): a hung model call is bounded TWICE. (1) A transport deadline on the provider
// fetch (providers/request-timeout.ts) — sees one HTTP exchange, aborts the real connection, surfaces
// a retryable ETIMEDOUT through the AI SDK's own maxRetries. (2) A chunk-idle timer below, raced
// against consumeStream, for streams that hang AND ignore the fetch abort: it resets per chunk and is
// disarmed while tools execute (a COUNTER — parallel tools re-arm only when the last one finishes),
// so unlike the deleted guardModelCall watchdog it structurally cannot time our own tool execution.
// Its rejection fires mid-consumption, where an SDK retry would mean double-generation — deliberate.
```

Also update the stale in-block comment at 215-222 (`- The timer is DISARMED when a tool-start chunk arrives` block) to mention the counter.

- [x] **Step 5: Run the test + full file**

Run: `bun test src/core/loop.test.ts`
Expected: ALL PASS (the new test + the 29 existing).

- [x] **Step 6: Commit** — `git add src/core/loop.ts src/core/loop.test.ts && git commit -m "Plan 20: idle timer counts executing tools; timer cleared on error path"`

### Task 2: A checker that never ran must not pass

**Files:**
- Modify: `src/schemas/trace.ts:20-28` (VerificationRecord), `src/core/verification.ts:58-89` (runChecker), `src/core/run.ts:149` (checkCriteria type), `src/core/tools.ts:465-505` (delegate handler)
- Test: `src/core/run.test.ts`

**Interfaces:**
- Produces: `runChecker` return gains `checkerError?: boolean`; `VerificationRecord` gains optional `checkerError`; `ctx.checkCriteria` return type mirrors it.

- [x] **Step 1: Failing unit test** (in `run.test.ts` next to the existing `runChecker` tests at ~:898):

```ts
test("a checker that never RAN (model error) is not a pass: checkerError verdict, pass=false", async () => {
  const model = new MockLanguageModelV3({
    doStream: () => { throw Object.assign(new Error("provider down"), { code: "ECONNREFUSED" }); },
  });
  const r = await runChecker({
    model, agent: mkAgent("root"), subscription: false,
    goal: "g", criteria: "c", output: "o",
  });
  expect(r.checkerError).toBe(true);
  expect(r.verdict.pass).toBe(false);
  expect(r.verdict.reasons.join(" ")).toContain("checker unavailable");
});
```

(`mkAgent` — use whatever agent-builder the neighboring `runChecker` tests at run.test.ts:898-915 use; copy their exact call shape.)

- [x] **Step 2: Run to verify failure** — `bun test src/core/run.test.ts -t "never RAN"`
Expected: FAIL — today `r.checkerError` is undefined and `r.verdict.pass` is true (unparseable → advisory pass).

- [x] **Step 3: Implement `verification.ts`.** Change the return type and add the detection (replace lines 58 and 77-88):

```ts
}): Promise<{ verdict: VerificationVerdict; tokens: number; costUsd: number | null; costNote?: string; checkerError?: boolean }> {
```

```ts
  // Plan 20: a checker that NEVER RAN (transport error / cancel) must not pass. It used to parse
  // "[error]"/"[cancelled]" into the advisory PASS — a squad relying on criteria got silent passes
  // during a provider outage. Now it surfaces pass=false + checkerError, and tools.ts skips the
  // retry (re-running the CHILD is pointless when the judge is down) and the annotation/coaching
  // side effects (the verdict says nothing about the artifact).
  if (result.error || result.aborted) {
    return {
      verdict: { pass: false, reasons: [`checker unavailable: ${result.error ?? "cancelled"}`] },
      checkerError: true,
      tokens: result.tokens,
      costUsd: params.subscription ? null : result.costUsd,
      costNote: params.subscription ? "subscription" : undefined,
    };
  }
  // Cost honesty (mirrors run.ts/loop.ts): a subscription checker has NO measurable USD, so costUsd is
  // null + costNote:"subscription" — never a fabricated 0 that claims an unmeasured price. Tokens always meter.
  return {
    verdict: parseVerdict(result.text),
    tokens: result.tokens,
    costUsd: params.subscription ? null : result.costUsd,
    costNote: params.subscription ? "subscription" : undefined,
  };
```

- [x] **Step 4: Schema + seam types.** `schemas/trace.ts` — inside `VerificationRecord`, after `costNote`:

```ts
  checkerError: z.boolean().optional(),       // Plan 20: the checker itself never ran (outage/cancel) — verdict is "unverified", not a judged fail
```

`run.ts:149` — the `checkCriteria` type gains the flag:

```ts
  checkCriteria: (p: { goal: string; criteria: string; output: string }) => Promise<{ verdict: VerificationVerdict; tokens: number; costUsd: number | null; costNote?: string; checkerError?: boolean }>;
```

- [x] **Step 5: Failing integration test** (in `run.test.ts`, next to the Plan 06 delegate tests). Model branches: the checker's prompt is recognizable (`VERIFIER_SYSTEM` / user text starting `GOAL:`), so throw ONLY there:

```ts
test("delegate with criteria: checker outage ⇒ no retry, no annotation, item/record marked checkerError", async () => {
  const { ws, db, roster } = setup();                     // ← copy the file's standard harness names
  const model = new MockLanguageModelV3({
    doGenerate: async (opts: any) => {
      const prompt = JSON.stringify(opts.prompt);
      if (prompt.includes("ACCEPTANCE CRITERIA:")) throw Object.assign(new Error("provider down"), { code: "ECONNREFUSED" });
      if (prompt.includes("You are worker")) return text("worker output");        // the child's turn
      if (prompt.includes("delegated")) return text("done");                      // parent's final after the tool result
      return toolCall("delegate_task", { to: "worker", goal: "g", criteria: "must contain X" });
    },
  });
  const res = await executeRun(mkDeps({ ws, db, model }), { agent: roster.root, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.verification.length).toBe(1);          // ONE record — no retry consumed
  expect(res.trace.verification[0].checkerError).toBe(true);
  expect(res.trace.verification[0].verdict.pass).toBe(false);
  expect(res.trace.delegatedOut.length).toBe(1);          // the child ran ONCE (no retry spawn)
});
```

(Adapt `setup`/`mkDeps`/`text`/`toolCall` to the file's actual helper names — run.test.ts already has all four shapes; the branching-doGenerate pattern is the one App.test.tsx's dispatch test documents.)

- [x] **Step 6: Implement the tools.ts policy.** In the delegate handler, line 470 currently pushes the first verification record — add the flag, then insert the early return between line 470 and `let verdict = first.verdict;`:

```ts
          ctx.verifications.push({ criteria, verdict: first.verdict, runId: child.runId, retried: false, tokens: first.tokens, costUsd: first.costUsd, costNote: first.costNote, checkerError: first.checkerError });
          // Plan 20: the judge never ran — this verdict says nothing about the OUTPUT. Skip the retry
          // (pointless), skip annotation + coaching (they'd blame the artifact for an outage), settle
          // the item from the child's REAL outcome like the no-criteria path, and surface UNVERIFIED.
          if (first.checkerError) {
            ctx.emit?.({ note: `⚠ verification checker unavailable — surfacing ${target} result UNVERIFIED (${first.verdict.reasons.join("; ")})` });
            bind(child.trace.outcome === "completed" ? "done" : child.trace.outcome === "blocked" ? "blocked" : "failed",
                 "verification checker unavailable — settled from run outcome", child.runId);
            return { to: target, team: guard.team, runId: child.runId, outputArtifacts: child.trace.artifacts, summary: child.text, verification: first.verdict };
          }
          let verdict = first.verdict;
```

And mirror it for the RETRY's check — after line 496's `ctx.verifications.push({ ...second... })` (add `checkerError: second.checkerError` there too), insert before `child = retry;`:

```ts
            if (second.checkerError) {
              ctx.emit?.({ note: `⚠ verification checker unavailable on the retry — surfacing ${target} result UNVERIFIED` });
              bind(retry.trace.outcome === "completed" ? "done" : retry.trace.outcome === "blocked" ? "blocked" : "failed",
                   "verification checker unavailable — settled from run outcome", retry.runId);
              return { to: target, team: guard.team, runId: retry.runId, outputArtifacts: retry.trace.artifacts, summary: retry.text, verification: second.verdict };
            }
```

- [x] **Step 7: Run** — `bun test src/core/run.test.ts` → ALL PASS; `bun test src/core/tools.test.ts` (guards against handler regressions) → PASS.
- [x] **Step 8: Commit** — `git commit -am "Plan 20: checker outage surfaces UNVERIFIED (pass=false, checkerError) — no retry, no annotation, item settles from outcome"`

### Task 3: Fix the remaining lying comments (engine files)

**Files:** Modify `src/core/otel.ts:1-13`, `src/core/compaction.ts:15-17`. (loop.ts's were fixed in Task 1.)

- [x] **Step 1:** `otel.ts` header — replace the two stale claims: `(via the AI SDK's experimental_telemetry)` → `(taicho-native "chat <model> · iter N" spans opened in loop.ts — NOT the AI SDK's experimental_telemetry, which is unused)`; delete the final paragraph sentence `This is Plan 16 Phase 1 ("emit alongside") … are follow-ups.` and replace with `Since Plan 17 this export is the ONLY trace-visualization path (the internal /trace waterfall is retired).` Also fix the `Telemetry.captureContent` doc at otel.ts:51 to say "ON by default; opt out via OTEL_TAICHO_CAPTURE_CONTENT=0|false|no|off".
- [x] **Step 2:** `compaction.ts:15-17` — replace `Cross-turn (boot-replay) compaction is Phase 3 and is deferred — it depends on … not yet built. See plans/tasks.md ## Plan 05.` with `Cross-turn (boot-replay) compaction is core/conversation-replay.ts (Plan 05 Ph3), hooked into the turn-audit seam by run.ts.`
- [x] **Step 3:** `bun run typecheck` → clean (comment-only). Commit: `git commit -am "Plan 20: engine comments match the code (otel header, compaction Ph3)"`

**PR 1 gate:** `bun run typecheck && bun test && bun run build` → open PR `plan-20-engine`.

---

## PR 2 — REPL (`plan-20-repl`)

### Task 4: Wire the background plan-item settle (the Plan 18 bug)

**Files:**
- Modify: `src/ui/App.tsx:472-487` (settleTask/failTask), `src/ui/App.tsx:21` (import)
- Test: `src/ui/App.test.tsx`

**Interfaces:**
- Consumes: `settlePlanItemForTask(ws, db, taskId, status, note?)` from `../store/plans` (exists, zero callers today); `foldPlan(ws, planId)` (already imported at App.tsx:21).

- [x] **Step 1: Failing Layer-1 test** (App.test.tsx; follow the existing `dispatch_task runs in the BACKGROUND` branching-mock test — same setup, same waitFor idiom):

```ts
test("a background task settle TICKS the plan item it was bound to (Plan 18 settle half)", async () => {
  // Root: write_plan → dispatch_task(itemId) → final. Worker: settles after the foreground turn.
  const { ws, db, ...harness } = setup();
  const model = new MockLanguageModelV3({
    doGenerate: async (opts: any) => {
      const prompt = JSON.stringify(opts.prompt);
      if (prompt.includes("You are worker")) { await sleep(150); return text("bg done"); }
      if (prompt.includes("task_bg_")) return text("dispatched, moving on");
      if (prompt.includes("PLAN OK")) return toolCall("dispatch_task", { to: "worker", goal: "bg goal", itemId: "it_bg" });
      return toolCall("write_plan", { goal: "test plan", items: [{ id: "it_bg", text: "background item" }] });
    },
  });
  // …render <App> with the harness + model (copy the dispatch test's props verbatim)…
  await send(stdin, "go", "\r");
  await waitFor(frame, "background task");                       // the settle notification printed
  const planId = currentPlanId(db, "root")!;
  const st = foldPlan(ws, planId)!;
  expect(st.items.find((i) => i.id === "it_bg")!.status).toBe("done");   // ← the unwired seam, now wired
});
```

(Note: after `write_plan` returns, the next root turn's prompt contains the tool RESULT — key the second branch on a distinctive substring of write_plan's result (inspect it in the failing run's logged prompt; adjust `"PLAN OK"` to the real marker). This branching-on-prior-tool-result pattern is exactly the dispatch test's.)

- [x] **Step 2: Run to verify failure** — `bun test src/ui/App.test.tsx -t "TICKS the plan item"`
Expected: FAIL — item status stays `"in_progress"`.

- [x] **Step 3: Implement.** App.tsx:21 — extend the import: `import { currentPlanId, foldPlan, settlePlanItemForTask } from "../store/plans";`. In `settleTask` (after the `setTaskFields` line, before `say`):

```ts
    // Plan 20 (Plan 18's settle half): tick whatever plan item this task was bound to, from the
    // task's REAL outcome — completed→done, blocked→blocked, else failed. Cancelled counts as failed
    // (the work did not happen). Then refresh the pinned plan panel from disk.
    const itemStatus = wasCancelled ? "failed"
      : res.trace.outcome === "completed" ? "done"
      : res.trace.outcome === "blocked" ? "blocked" : "failed";
    const settled = settlePlanItemForTask(props.ws, props.db, taskId, itemStatus,
      wasCancelled ? "task cancelled" : `task ${taskId} ${res.trace.outcome}`);
    if (settled) { const st = foldPlan(props.ws, settled.planId); if (st) setPlan(st); }
```

In `failTask` (after its `setTaskFields`):

```ts
    const settled = settlePlanItemForTask(props.ws, props.db, taskId, "failed",
      e instanceof Error ? e.message : String(e));
    if (settled) { const st = foldPlan(props.ws, settled.planId); if (st) setPlan(st); }
```

- [x] **Step 4: Run** — the new test PASSES; whole `bun test src/ui/App.test.tsx` PASSES.
- [x] **Step 5: Commit** — `git commit -am "Plan 20: background task settle ticks its bound plan item (settlePlanItemForTask wired)"`

### Task 5: Honest `dispatch_task` criteria description

**Files:** Modify `src/core/tools.ts:524-537` (description + criteria describe).

- [x] **Step 1:** In the `dispatch_task` description, replace `Hand inputs over with \`inputArtifacts\` and set \`criteria\` exactly as for delegate_task.` with `Hand inputs over with \`inputArtifacts\`. Unlike delegate_task, \`criteria\` here rides into the worker's brief but is NOT independently verified at settle (no checker, no retry on the background path).` And the `criteria` field describe → `"acceptance criteria, passed to the worker in its brief; NOT independently checked on the background path (unlike delegate_task)"`.
- [x] **Step 2:** `bun test src/core/tools.test.ts` (description strings can be asserted somewhere) → PASS. Commit: `git commit -am "Plan 20: dispatch_task stops claiming a checker it doesn't run"`

### Task 6: Focus-ring / Enter desync

**Files:**
- Modify: `src/ui/App.tsx:342-347` (focus-mode keys)
- Test: `src/ui/App.test.tsx`

- [x] **Step 1: Failing test** — root streams text BEFORE delegating (so `blockFeed` gains root first), child block renders, focus mode + Enter must open the CHILD:

```ts
test("focus mode: Enter opens the run the ring HIGHLIGHTS (not blockFeed insertion order)", async () => {
  // Mock: root streams a delta, then delegate_task; child (slow, ~300ms) streams its own delta so a
  // block renders while root's runId also sits in blockFeed. allBlocks excludes root ⇒ index 0 is the
  // child; the OLD Enter path opened blockFeed order ⇒ root's run. Assert the operation view header
  // names the CHILD agent.
  // …branching doGenerate like the Task 4 test: root delta("thinking…") + delegate_task; child delta + slow final…
  await send(stdin, "go", "\r");
  await waitFor(frame, "proof-agent");           // the child's block is on screen
  await send(stdin, "[Z");                 // shift+tab enters focus mode
  await send(stdin, "\r");                       // Enter on the highlighted (only) block
  await waitFor(frame, "OPERATION");             // OperationView header
  expect(lastFrame()).toContain("proof-agent");  // the CHILD's view — old code showed root's run
});
```

(Check OperationView's actual header text once in the failing run and pin the waitFor to it; `[Z` is shift+tab in ink.)

- [x] **Step 2: Run to verify failure** — the view opens root's run (or nothing), assertion fails.
- [x] **Step 3: Implement** — App.tsx focus-mode branch (lines 342-347) becomes ONE collection (`allBlocks`, already in scope from line 314):

```ts
      if (key.downArrow) { setFocusIndex((i) => Math.min((allBlocks.length || 1) - 1, i + 1)); return; }
      if (key.return) {
        // Plan 20: ring and target read the SAME collection — allBlocks is what renders (root
        // excluded, settling-first); blockFeed insertion order included root and opened the wrong run.
        const target = allBlocks[focusIndex];
        if (target) setOperationRunId(target.runId);
        return;
      }
```

- [x] **Step 4: Run** — new test + whole App.test.tsx PASS.
- [x] **Step 5: Commit** — `git commit -am "Plan 20: focus ring and Enter target read the same block collection"`

### Task 7: Roster reindex — boot unconditional + `/agents reindex`

**Files:**
- Modify: `src/index.tsx:66-67`, `src/ui/slash.ts:16` (usage), `src/ui/App.tsx` `runSlash` (new `agents` branch before the pure fallback), imports (`reindex` from `../store/roster`)
- Test: `src/ui/App.test.tsx`

- [x] **Step 1:** `index.tsx:66-67` — replace both lines with:

```ts
// Plan 20: files are canon, the registry is derived — rebuild EVERY boot (a scan of agents/*/agent.md,
// trivially cheap) so hand-edits like `team: news` take effect on restart instead of never.
await reindex(ws, db);
```

(`loadIndex` stays imported — line 104 still uses it. Delete the now-unused `idx` binding.)

- [x] **Step 2:** `slash.ts:16` — `{ name: "agents", summary: "list the squad", usage: "[reindex]" },`
- [x] **Step 3:** App.tsx `runSlash` — add before the pure fallback (pattern of the `kb` branch):

```ts
    if (cmd === "agents" && arg.trim() === "reindex") {
      await reindex(props.ws, props.db);
      say({ kind: "system", text: "  roster reindexed from agents/*/agent.md" });
      return;
    }
```

with `import { reindex } from "../store/roster";` added to App.tsx's roster import line.

- [x] **Step 4: Test** (App.test.tsx): create the workspace, append `team: news` to a worker's `agent.md` frontmatter on disk, `/agents reindex`, assert `loadIndex(db)` now carries `team: "news"` for it AND the frame shows `roster reindexed`.
- [x] **Step 5:** `bun test src/ui/App.test.tsx` + `bun test src/store/roster.test.ts` PASS. Commit: `git commit -am "Plan 20: registry rebuilds every boot; /agents reindex for mid-session hand-edits"`

### Task 8: One composed SIGTERM handler

**Files:** Modify `src/index.tsx:130-133` and `:149`.

- [x] **Step 1:** Delete line 133 (`if (mcp) process.on("SIGTERM", …)`) and line 149 (`if (telemetry) process.on("SIGTERM", …)`). After the `initTelemetry` line insert:

```ts
// Plan 20: ONE composed SIGTERM handler — reap MCP children, flush buffered spans, then EXIT.
// Previously two independent handlers raced (MCP's exit(0) could beat the un-awaited telemetry
// flush) and with MCP disabled the telemetry-only handler swallowed the signal without exiting.
process.on("SIGTERM", () => {
  void (async () => {
    try { await mcp?.closeAll(); } catch { /* best-effort on the way down */ }
    try { await telemetry?.shutdown(); } catch { /* best-effort */ }
    process.exit(0);
  })();
});
```

Update the comment block at 130-132 to say SIGTERM is handled by the composed handler below.

- [x] **Step 2:** `bun run typecheck && bun run build` → clean (index.tsx has no unit harness; the build is the gate). Manual verify: `TAICHO_E2E_MODEL=agent-flow ./dist/taicho` in a scratch workspace, `kill -TERM <pid>`, process exits 0.
- [x] **Step 3: Commit** — `git commit -am "Plan 20: composed SIGTERM — close MCP, flush OTel, exit"`

**PR 2 gate:** `bun run typecheck && bun test && bun run build` → open PR `plan-20-repl`.

---

## PR 3 — cleanup (`plan-20-cleanup`)

### Task 9: Delete the dead e2e scenarios

- [x] `git rm e2e/scenarios/trace-inspector.ts e2e/scenarios/live-waterfall.ts` (they import the Plan-17-deleted `core/trace-tree` and fail at dynamic import; TESTING.md already flags them dead — remove that parenthetical note in TESTING.md:25-27 in the same commit). Commit: `git commit -m "Plan 20: delete the two dead waterfall e2e scenarios (Plan 17 leftovers)"`

### Task 10: Phantom `search_knowledge` + SquadPanes comment

- [x] `src/core/tools.ts:875` — remove `"search_knowledge",` from the `untrustedSources` list (no tool by that name exists; `recall` is listed and arms the guard). Run `bun test src/core/tools.test.ts` → PASS.
- [x] `src/ui/SquadPanes.tsx:41` — comment `Panes hide in \`bar\`/\`waterfall\` mode` → `Panes hide in \`bar\` mode`. Commit both: `git commit -am "Plan 20: drop phantom untrustedSources entry; fix stale SquadPanes comment"`

### Task 11: Atomic task-file writes

**Files:** Modify `src/store/task-state.ts:72-76` (+ `renameSync` import). Test: `src/store/task-state.test.ts`.

- [x] **Step 1: Failing-ish test** (behavioral, not crash-simulating): assert no `.tmp` residue and round-trip integrity:

```ts
test("writeTask is atomic: temp+rename, no .tmp residue, record round-trips", () => {
  const ws = mkWs();                                        // the file's temp-workspace helper
  createBackgroundTask(ws, undefined as any, { taskId: "task_bg_x", agent: "a", goal: "g" });
  const dir = paths.taskDir(ws);
  expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  expect(readTaskState(ws, "task_bg_x")!.goal).toBe("g");
});
```

- [x] **Step 2: Implement** — mirror `schedules.ts:29-35` exactly:

```ts
function writeTask(ws: string, task: TaskState, db?: Database): void {
  mkdirSync(paths.taskDir(ws), { recursive: true });
  // Plan 20: temp + rename (atomic on POSIX) — a crash mid-write used to truncate the .json, which
  // reindexTasks then silently skipped (the record vanished from the index). The temp suffix isn't
  // .json, so a leftover from a crashed write is ignored by the readdir filters.
  const dest = taskFile(ws, task.taskId);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(task, null, 2));
  renameSync(tmp, dest);
  if (db) indexTask(db, task);
}
```

Add `renameSync` to the `node:fs` import at task-state.ts:7.

- [x] **Step 3:** `bun test src/store/task-state.test.ts` → ALL PASS. Commit: `git commit -am "Plan 20: atomic temp+rename task-file writes (matches schedules.ts)"`

**PR 3 gate:** `bun run typecheck && bun test && bun run build` → open PR `plan-20-cleanup`.

---

## After all three PRs

- [x] Flip this plan's checkboxes + the `plans/tasks.md` Plan 20 entry in the final PR touched.
- [x] Adversarial review pass over all three diffs (review-the-fix discipline: exception wraps, guard placement, counter arithmetic are second-order-bug territory) before handing to the captain to merge.
