import { test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { tool, simulateReadableStream, type ToolSet } from "ai";
import { z } from "zod";
import { runLoop } from "./loop";
import type { AgentDef } from "../schemas/agent";
import { SQUAD_SCOPE, type SpendLedger, type SpendTotals, type SpendCeilings } from "../store/spend-ledger";

// Plan 07: the loop unifies on streamText, so EVERY model is driven via doStream (not doGenerate).
// These are the LanguageModelV3 stream parts a mock emits for a tool-call turn and a final-text turn.
// Raw provider usage shape (`inputTokens.total`) — the SDK normalizes it to `{ inputTokens: number }`.
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;
const toolCallChunks = [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: "c1", toolName: "noop", input: "{}" },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const finalChunks = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", delta: "all done" },
  { type: "text-end", id: "1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];

// A doStream that emits `chunks` on EVERY call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function streamOf(chunks: unknown[]): any {
  return async () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks: chunks as any }),
  });
}
// A doStream that emits the next chunk-set per call (repeats the last once exhausted).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function streamSeq(...sets: unknown[][]): any {
  let i = 0;
  return async () => {
    const chunks = sets[Math.min(i, sets.length - 1)];
    i += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks: chunks as any }) };
  };
}

const agent: AgentDef = {
  id: "a", role: "r", identity: "i", tools: ["noop"], canSee: ["*"], canDelegateTo: [],
  budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 }, isRoot: false,
  created: "2026-06-11T00:00:00.000Z",
};
const tools: ToolSet = {
  noop: tool({ description: "no-op", inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
};

test("loop returns final text after a tool-call round", async () => {
  const model = new MockLanguageModelV3({ doStream: streamSeq(toolCallChunks, finalChunks) });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools });
  expect(res.text).toBe("all done");
  expect(res.toolCalls.noop).toBe(1);
});

test("loop falls through to budget-exhausted when the model always tool-calls", async () => {
  const budgetAgent: AgentDef = { ...agent, budgets: { ...agent.budgets, maxIterationsPerRun: 2 } };
  const model = new MockLanguageModelV3({ doStream: streamOf(toolCallChunks) });
  const res = await runLoop({ model, agent: budgetAgent, system: "S", messages: [{ role: "user", content: "go" }], tools });
  expect(res.text).toBe("[budget exhausted]");
  expect(res.exhausted).toBe(true);
  expect(res.iterations).toBe(2);
});

test("a queued steer is injected as a marked user message before the next call", async () => {
  const model = new MockLanguageModelV3({ doStream: streamSeq(toolCallChunks, finalChunks) });
  let fired = false;
  const pollSteer = () => { if (!fired) { fired = true; return null; } return "actually, stop after this"; };
  await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, pollSteer });
  // second model call's prompt must contain the steer marker
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const secondPrompt = JSON.stringify((model as any).doStreamCalls[1].prompt);
  expect(secondPrompt).toContain("OUT-OF-BAND USER MESSAGE");
  expect(secondPrompt).toContain("actually, stop after this");
});

test("meters input/output/total tokens and cost via the injected pricer", async () => {
  const model = new MockLanguageModelV3({ doStream: streamOf(finalChunks) });
  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    priceUsd: ({ inputTokens, outputTokens }) => inputTokens * 2 + outputTokens * 3,
  });
  // usage fixture is inputTokens.total=1, outputTokens.total=1 -> cost = 1*2 + 1*3 = 5
  expect(res.inputTokens).toBe(1);
  expect(res.outputTokens).toBe(1);
  expect(res.costUsd).toBe(5);
});

test("captureProviderCost: uses providerMetadata.openrouter.usage.cost on the streamed path, overriding the token pricer", async () => {
  // OpenRouter reports the authoritative per-call cost in the finish part's providerMetadata; the
  // streamed path must surface it (s.providerMetadata) exactly as the generateText path once did.
  const withCostChunks = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: "all done" },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage, providerMetadata: { openrouter: { usage: { cost: 0.0042 } } } },
  ];
  const model = new MockLanguageModelV3({ doStream: streamOf(withCostChunks) });
  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    captureProviderCost: true,
    priceUsd: () => 999, // would be used if the provider cost were missing — proves the override
  });
  expect(res.costUsd).toBe(0.0042);
});

test("captureProviderCost: falls back to the token pricer when no provider cost is reported", async () => {
  const model = new MockLanguageModelV3({ doStream: streamOf(finalChunks) });
  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    captureProviderCost: true,
    priceUsd: ({ inputTokens, outputTokens }) => inputTokens * 2 + outputTokens * 3,
  });
  expect(res.costUsd).toBe(5); // usage fixture 1/1 → 1*2 + 1*3
});

test("stops with exhausted when the token cap is reached", async () => {
  const capped = { ...agent, budgets: { ...agent.budgets, maxIterationsPerRun: 30, maxTokensPerRun: 1 } };
  const model = new MockLanguageModelV3({ doStream: streamOf(toolCallChunks) });
  const res = await runLoop({ model, agent: capped, system: "S", messages: [{ role: "user", content: "go" }], tools });
  expect(res.exhausted).toBe(true);
  // proves the TOKEN cap (not the 30-iteration cap) stopped it: exactly one model call happened
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((model as any).doStreamCalls.length).toBe(1);
});

test("stops with exhausted when the cost cap is reached (not the iteration cap)", async () => {
  const capped = { ...agent, budgets: { ...agent.budgets, maxIterationsPerRun: 30, maxCostPerRunUsd: 0.001 } };
  const model = new MockLanguageModelV3({ doStream: streamOf(toolCallChunks) });
  const res = await runLoop({ model, agent: capped, system: "S", messages: [{ role: "user", content: "go" }], tools, priceUsd: () => 1 });
  expect(res.exhausted).toBe(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((model as any).doStreamCalls.length).toBe(1); // one $1 call exceeds the $0.001 cap
});

// --- Plan 09: squad-wide ceilings, enforced in the loop (the one meter) -----------------------------
// A fake ledger stands in for the DB-backed one: current() is the running cross-session total; add()
// accumulates the way the real rolling counter does, so a test can watch spend cross a ceiling.
function fakeLedger(init: Partial<SpendTotals>, ceilings: SpendCeilings, teams: Record<string, SpendCeilings> = {}) {
  // one running total per scope, exactly like the DB-backed counter
  const totals = new Map<string, SpendTotals>();
  const of = (scope: string): SpendTotals => {
    if (!totals.has(scope)) totals.set(scope, { dayTokens: 0, weekTokens: 0, dayCostUsd: 0, weekCostUsd: 0 });
    return totals.get(scope)!;
  };
  Object.assign(of(SQUAD_SCOPE), init);
  const adds: { scopes: string[]; tokens: number; costUsd: number }[] = [];
  const ledger: SpendLedger = {
    ceilings: (scope) => (scope === SQUAD_SCOPE ? ceilings : teams[scope.slice("team:".length)]),
    current: (scope) => ({ ...of(scope) }),
    add: (scopes, d) => {
      adds.push({ scopes: [...scopes], ...d });
      for (const scope of scopes) {
        const t = of(scope);
        t.dayTokens += d.tokens; t.weekTokens += d.tokens; t.dayCostUsd += d.costUsd; t.weekCostUsd += d.costUsd;
      }
    },
  };
  return { ledger, adds };
}

test("squad ceiling ALREADY crossed refuses the run before any model call", async () => {
  // Plan 07: the loop drives streamText (doStream); a ceiling ALREADY crossed refuses before any call.
  const model = new MockLanguageModelV3({ doStream: streamOf(finalChunks) });
  const { ledger } = fakeLedger({ dayTokens: 1000 }, { dailyTokens: 1000 });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, spendLedger: ledger });
  expect(res.exhausted).toBe(true);
  expect(res.text).toContain("squad budget exhausted");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((model as any).doStreamCalls.length).toBe(0); // refused at the top of the loop, before spending
});

test("squad ceiling stops the run once ACCUMULATED spend crosses it (not the iteration cap)", async () => {
  // Always tool-calls, so only a budget stops it. usage fixture = 2 tok/call; dailyTokens:5 is crossed
  // after the 3rd call (2→4→6), so the 4th iteration's top-of-loop check refuses.
  const model = new MockLanguageModelV3({ doStream: streamOf(toolCallChunks) });
  const roomy = { ...agent, budgets: { ...agent.budgets, maxIterationsPerRun: 50 } };
  const { ledger, adds } = fakeLedger({}, { dailyTokens: 5 });
  const res = await runLoop({ model, agent: roomy, system: "S", messages: [{ role: "user", content: "go" }], tools, spendLedger: ledger });
  expect(res.exhausted).toBe(true);
  expect(res.text).toContain("squad budget exhausted");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((model as any).doStreamCalls.length).toBe(3); // 3 calls committed 6 tok, then refused
  expect(adds.length).toBe(3);
});

test("a subscription (codexBackend) call commits TOKENS but 0 USD to the squad ledger", async () => {
  const model = new MockLanguageModelV3({
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0, chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "done" },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ],
      }),
    })) as any,
  });
  const { ledger, adds } = fakeLedger({}, { weeklyTokens: 1_000_000 });
  await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    codexBackend: true, priceUsd: () => 999, spendLedger: ledger, // priceUsd would be $999 — must be ignored
  });
  expect(adds.length).toBe(1);
  expect(adds[0].tokens).toBeGreaterThan(0); // tokens ALWAYS metered
  expect(adds[0].costUsd).toBe(0);           // USD unmeasurable for a subscription → never fabricated
});

test("aborts when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = new MockLanguageModelV3({ doStream: streamOf(finalChunks) });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, signal: controller.signal });
  expect(res.aborted).toBe(true);
});

test("codexBackend streams (doStream) and routes system -> providerOptions.openai.instructions (+ store:false), not as a system message", async () => {
  // The ChatGPT/Codex backend requires the system prompt in the top-level `instructions` field.
  const model = new MockLanguageModelV3({
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0, chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "all done" },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ],
      }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any,
  });
  const res = await runLoop({ model, agent, system: "SYS", messages: [{ role: "user", content: "go" }], tools, codexBackend: true });
  expect(res.text).toBe("all done"); // proves the streamed text was aggregated
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (model as any).doStreamCalls[0];
  // rejected as "Instructions are required" unless `system` arrives here:
  expect(call.providerOptions?.openai?.instructions).toBe("SYS");
  expect(call.providerOptions?.openai?.store).toBe(false);
  // ...and NOT duplicated as a system message in the input prompt
  expect(JSON.stringify(call.prompt)).not.toContain("SYS");
});

test("env path (no codexBackend) streams too, keeping system as a normal system prompt with no instructions override", async () => {
  const model = new MockLanguageModelV3({ doStream: streamOf(finalChunks) });
  await runLoop({ model, agent, system: "SYS", messages: [{ role: "user", content: "go" }], tools });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (model as any).doStreamCalls[0];
  expect(call.providerOptions?.openai?.instructions).toBeUndefined();
  expect(JSON.stringify(call.prompt)).toContain("SYS"); // system delivered the normal way
});

test("env path (unified streaming): usage, cost, toolCalls and live deltas all come through", async () => {
  // Parity proof for a NON-codex provider under the unified streamText path: everything the
  // generateText path used to return (final text, counted tool calls, metered usage, priced cost)
  // still arrives — AND text deltas now stream live (previously codex-only).
  const model = new MockLanguageModelV3({ doStream: streamSeq(toolCallChunks, finalChunks) });
  const deltas: string[] = [];
  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    priceUsd: ({ inputTokens, outputTokens }) => inputTokens * 2 + outputTokens * 3,
    onStep: (i) => { if (i.delta) deltas.push(i.delta); },
  });
  expect(res.text).toBe("all done");        // final text aggregated from the stream
  expect(res.toolCalls.noop).toBe(1);        // tool call surfaced + counted on the streamed path
  expect(res.inputTokens).toBe(2);           // usage metered across BOTH streamed calls (1 + 1)
  expect(res.outputTokens).toBe(2);
  expect(res.costUsd).toBe(10);              // priced from streamed usage: 2 × (1*2 + 1*3) = 10
  expect(deltas.join("")).toBe("all done");  // deltas forwarded live on the env path
});

test("returns a structured error (does not throw) when the model call fails", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doStream: (async () => { throw new Error("boom"); }) as any });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools });
  expect(res.error).toContain("boom");
  expect(res.aborted).toBe(false);
  expect(res.exhausted).toBe(false);
});

// Plan 12: a wedged stream is now torn down at the TRANSPORT layer (a real provider fetch honors the
// abort signal), not by a loop-level watchdog. This mock simulates a real provider whose in-flight
// request rejects the instant its abortSignal fires (exactly what fetch does) — the loop can only
// cancel a stuck call if the underlying transport honors abort, and every real provider does.
const abortHonoringStream = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new MockLanguageModelV3({ doStream: (async ({ abortSignal }: any) => {
    return await new Promise((_resolve, reject) => {
      if (abortSignal?.aborted) return reject(abortSignal.reason ?? new Error("aborted"));
      abortSignal?.addEventListener("abort", () => reject(abortSignal.reason ?? new Error("aborted")), { once: true });
    });
  }) as any });

test("cancels a stuck streaming model call when the signal aborts (real transport honors abort)", async () => {
  // The old guardModelCall watchdog is gone: cancellation now rides the abortSignal streamText passes
  // to the provider. A real fetch honors it; this mock does too. No loop-level timer involved.
  const controller = new AbortController();
  const p = runLoop({ model: abortHonoringStream(), agent, system: "S", messages: [{ role: "user", content: "go" }], tools, codexBackend: true, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const res = await p;
  expect(res.aborted).toBe(true);
  expect(res.text).toBe("[cancelled]");
}, 3000);

test("forwards streamed text deltas via onStep (so the UI can render live)", async () => {
  const model = new MockLanguageModelV3({
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0, chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "Hel" },
          { type: "text-delta", id: "1", delta: "lo, " },
          { type: "text-delta", id: "1", delta: "world" },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ],
      }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any,
  });
  const deltas: string[] = [];
  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    onStep: (i) => { if (i.delta) deltas.push(i.delta); },
  });
  expect(deltas).toEqual(["Hel", "lo, ", "world"]); // each chunk surfaced incrementally, in order
  expect(deltas.join("")).toBe(res.text);            // and they reconstruct the final text
});

test("onEvent flushes each transcript event live (incremental evidence, not buffered to run end)", async () => {
  const model = new MockLanguageModelV3({ doStream: streamSeq(toolCallChunks, finalChunks) });
  const kinds: string[] = [];
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, onEvent: (e) => kinds.push(e.kind) });
  expect(kinds).toContain("model_request");
  expect(kinds).toContain("model_response");
  expect(kinds).toContain("tool_call");
  // every returned transcript event was also flushed live (same set, in order)
  expect(kinds).toEqual(res.transcript.map((e) => e.kind));
});

test("checkpoint is called once per iteration with the loop's message array (the resume point)", async () => {
  const model = new MockLanguageModelV3({ doStream: streamSeq(toolCallChunks, finalChunks) });
  const snaps: Array<{ iteration: number; msgCount: number }> = [];
  await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    checkpoint: ({ iteration, messages }) => snaps.push({ iteration, msgCount: messages.length }),
  });
  expect(snaps.map((s) => s.iteration)).toEqual([1, 2]);        // two iterations (tool round, then final)
  expect(snaps[1].msgCount).toBeGreaterThan(snaps[0].msgCount); // the message array grew across the round-trip
});

// ── Plan 05: in-run compaction ──────────────────────────────────────────────────────────────────
test("measures contextTokens every run even when compaction is off (no threshold passed)", async () => {
  const model = new MockLanguageModelV3({ doStream: streamOf(finalChunks) });
  const res = await runLoop({ model, agent, system: "SYSTEM", messages: [{ role: "user", content: "go" }], tools });
  expect(res.contextTokens).toBeGreaterThan(0); // Phase 1 measure is unconditional
  expect(res.compactions).toBe(0);              // no threshold ⇒ never folds
});

test("folds oldest round-trips into a compaction summary once the estimate crosses the threshold", async () => {
  // A tool that returns a chunky result so the message array grows fast; a tiny threshold so a couple
  // round-trips trigger the fold. The model tool-calls five times, then returns final text.
  const bigTool: ToolSet = {
    noop: tool({ description: "n", inputSchema: z.object({}), execute: async () => ({ blob: "X".repeat(600) }) }),
  };
  const longAgent: AgentDef = { ...agent, budgets: { ...agent.budgets, maxIterationsPerRun: 12 } };
  const model = new MockLanguageModelV3({
    // Plan 07: the loop streams for every provider, so drive the mock via doStream. Five tool-call
    // turns (message array grows past the tiny threshold) then a final-text turn.
    doStream: streamSeq(toolCallChunks, toolCallChunks, toolCallChunks, toolCallChunks, toolCallChunks, finalChunks),
  });
  const events: { kind: string; data?: unknown }[] = [];
  const res = await runLoop({
    model, agent: longAgent, system: "S", messages: [{ role: "user", content: "ORIGINAL_BRIEF go" }], tools: bigTool,
    compactThresholdTokens: 60, compactKeepRecent: 2,
    onEvent: (e) => events.push({ kind: e.kind, data: e.data }),
  });

  expect(res.text).toBe("all done");                       // the run completes instead of exhausting
  expect(res.compactions).toBeGreaterThan(0);
  expect(res.contextTokens).toBeGreaterThan(0);

  // the fold is VISIBLE in the transcript (never invisible)
  const comp = events.find((e) => e.kind === "compaction");
  expect(comp).toBeDefined();
  const cd = comp!.data as { foldedRoundTrips: number; before: number; after: number };
  expect(cd.foldedRoundTrips).toBeGreaterThan(0);
  expect(cd.after).toBeLessThan(cd.before);                // folding shrank the estimate

  // a later model call carries the summary AND still the original brief (head kept verbatim)
  const laterPrompt = JSON.stringify((model as any).doStreamCalls.at(-1).prompt);
  expect(laterPrompt).toContain("[CONTEXT COMPACTION]");
  expect(laterPrompt).toContain("ORIGINAL_BRIEF");
});

// ── Plan 12: no loop-level model-call watchdog ────────────────────────────────────────────────────
test("a slow tool round-trip completes — tool execution is never subject to a loop deadline (shot-planner regression)", async () => {
  // The bug: the old idle watchdog wrapped consumeStream, and the AI SDK executes tools INSIDE
  // consumeStream. A long delegation (156s of tool execution, zero stream chunks) tripped the timer at
  // tool_start + 120000ms, failing a run whose child had actually succeeded. Now there is NO loop
  // timer, so tool execution of ANY duration completes and the parent surfaces the result. We stand in
  // for the 156s delegation with a tool whose execute() takes a beat while the stream is silent — the
  // load-bearing property is that this silence trips nothing. Pre-fix, a watchdog armed anywhere below
  // the tool's duration would fire mid-execution and fail this assertion.
  let toolRan = false;
  const slowTools: ToolSet = {
    slow: tool({
      description: "a tool whose execution takes a while (stands in for a long delegation)",
      inputSchema: z.object({}),
      execute: async () => { await new Promise((r) => setTimeout(r, 300)); toolRan = true; return { done: true }; },
    }),
  };
  const slowCallChunks = [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "s1", toolName: "slow", input: "{}" },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
  ];
  const model = new MockLanguageModelV3({ doStream: streamSeq(slowCallChunks, finalChunks) });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools: slowTools });
  expect(toolRan).toBe(true);            // the slow tool actually ran to completion
  expect(res.toolCalls.slow).toBe(1);
  expect(res.text).toBe("all done");     // and the parent surfaced the post-tool final result
}, 5000);

// Plan 12 (reopened): a stream that hangs forever (no chunks, no tool execution) is caught by the
// idle timer. The timer resets on each chunk and is disarmed during tool execution, so it only fires
// when there's genuine inactivity (no chunks, no tool execution).
test("Plan 12 (reopened): a hung stream with no chunks is caught by the idle timer", async () => {
  // A doStream that returns a ReadableStream that NEVER emits any chunks (simulates a hung stream).
  const hangingStream = new ReadableStream({
    pull(controller) {
      // Never call controller.enqueue() or controller.close() — the stream hangs forever
      return new Promise(() => {}); // hang forever
    },
  });
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: hangingStream as any }),
  });
  // Use a short timeout (200ms) so the test completes quickly
  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools: {},
    modelRequestTimeoutMs: 200,
  });
  // The loop should have rejected with a timeout error
  expect(res.error).toBeDefined();
  expect(res.error).toContain("idle");
  expect(res.text).toBe("[error]");
}, 5000);

// Plan 12 (reopened): a tool slower than the deadline still completes. The idle timer is disarmed
// during tool execution, so a long tool (like the 156s shot-planner delegation) is not killed.
test("Plan 12 (reopened): a tool slower than the deadline still completes (shot-planner regression)", async () => {
  // A tool that takes 400ms to execute
  let toolRan = false;
  const slowTools: ToolSet = {
    slow: tool({
      description: "a tool whose execution takes longer than the deadline",
      inputSchema: z.object({}),
      execute: async () => { await new Promise((r) => setTimeout(r, 400)); toolRan = true; return { done: true }; },
    }),
  };
  // A stream that emits a tool-call chunk, then waits for the tool to execute, then emits the final chunks
  const slowCallChunks = [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "s1", toolName: "slow", input: "{}" },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
  ];
  const model = new MockLanguageModelV3({ doStream: streamSeq(slowCallChunks, finalChunks) });
  // Use a 200ms deadline — the tool takes 400ms, so it would be killed by a naive Promise.race
  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools: slowTools,
    modelRequestTimeoutMs: 200,
  });
  // The tool should have completed despite being slower than the deadline
  expect(toolRan).toBe(true);
  expect(res.toolCalls.slow).toBe(1);
  expect(res.error).toBeUndefined();
}, 5000);

// Plan 12 (reopened): two CONCURRENT runs must not interfere with each other's idle timers.
// The timer state must be per-run, not global.
test("Plan 12 (reopened): two concurrent runs with long tools both complete (no timer cross-wiring)", async () => {
  // Two tools that each take 400ms to execute
  let toolARan = false;
  let toolBRan = false;
  const slowToolsA: ToolSet = {
    slowA: tool({
      description: "tool A",
      inputSchema: z.object({}),
      execute: async () => { await new Promise((r) => setTimeout(r, 400)); toolARan = true; return { done: true }; },
    }),
  };
  const slowToolsB: ToolSet = {
    slowB: tool({
      description: "tool B",
      inputSchema: z.object({}),
      execute: async () => { await new Promise((r) => setTimeout(r, 400)); toolBRan = true; return { done: true }; },
    }),
  };
  // Streams that emit tool-call chunks, then wait for tools to execute, then emit final chunks
  const slowCallChunksA = [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "a1", toolName: "slowA", input: "{}" },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
  ];
  const slowCallChunksB = [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "b1", toolName: "slowB", input: "{}" },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
  ];
  const modelA = new MockLanguageModelV3({ doStream: streamSeq(slowCallChunksA, finalChunks) });
  const modelB = new MockLanguageModelV3({ doStream: streamSeq(slowCallChunksB, finalChunks) });
  // Use a 200ms deadline — both tools take 400ms, so they would be killed by a naive Promise.race
  // or if the timers cross-wired (one run's chunks reset the other run's timer)
  const [resA, resB] = await Promise.all([
    runLoop({
      model: modelA, agent, system: "S", messages: [{ role: "user", content: "go" }], tools: slowToolsA,
      modelRequestTimeoutMs: 200,
    }),
    runLoop({
      model: modelB, agent, system: "S", messages: [{ role: "user", content: "go" }], tools: slowToolsB,
      modelRequestTimeoutMs: 200,
    }),
  ]);
  // Both tools should have completed despite being slower than the deadline
  expect(toolARan).toBe(true);
  expect(toolBRan).toBe(true);
  expect(resA.toolCalls.slowA).toBe(1);
  expect(resB.toolCalls.slowB).toBe(1);
  expect(resA.error).toBeUndefined();
  expect(resB.error).toBeUndefined();
}, 5000);

test("Plan 19: a TEAM ceiling stops a run the squad ceiling would have allowed", async () => {
  const model = new MockLanguageModelV3({ doStream: streamOf(finalChunks) });
  const { ledger } = fakeLedger({}, { dailyTokens: 1_000_000 }, { trading: { dailyTokens: 10 } });
  // the team is already over its own (much tighter) ceiling
  ledger.add(["team:trading"], { tokens: 10, costUsd: 0 });

  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    spendLedger: ledger, spendScopes: ["team:trading", SQUAD_SCOPE],
  });
  expect(res.exhausted).toBe(true);
  expect(res.text).toBe("[team budget exhausted: trading, daily token ceiling reached (10/10 tok)]");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((model as any).doStreamCalls.length).toBe(0); // refused before spending anything
});

test("Plan 19: a team run commits its spend to BOTH scopes in one add()", async () => {
  const model = new MockLanguageModelV3({ doStream: streamOf(finalChunks) });
  const { ledger, adds } = fakeLedger({}, {}, { trading: { dailyTokens: 1_000_000 } });
  await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    spendLedger: ledger, spendScopes: ["team:trading", SQUAD_SCOPE],
  });
  expect(adds).toHaveLength(1);
  expect(adds[0]!.scopes).toEqual(["team:trading", "squad"]);
  expect(ledger.current("team:trading").dayTokens).toBe(ledger.current(SQUAD_SCOPE).dayTokens);
});

test("Plan 19: an unaffiliated agent meters against the squad alone (default scopes)", async () => {
  const model = new MockLanguageModelV3({ doStream: streamOf(finalChunks) });
  const { ledger, adds } = fakeLedger({}, { dailyTokens: 1_000_000 });
  await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, spendLedger: ledger });
  expect(adds[0]!.scopes).toEqual(["squad"]);
});
