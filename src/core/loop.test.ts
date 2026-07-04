import { test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { tool, simulateReadableStream, type ToolSet } from "ai";
import { z } from "zod";
import { runLoop } from "./loop";
import type { AgentDef } from "../schemas/agent";
import type { DeckLedger, DeckSpend, DeckCeilings } from "../store/deck-budget";

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

// --- Plan 09: deck-wide ceilings, enforced in the loop (the one meter) -----------------------------
// A fake ledger stands in for the DB-backed one: current() is the running cross-session total; add()
// accumulates the way the real rolling counter does, so a test can watch spend cross a ceiling.
function fakeLedger(init: Partial<DeckSpend>, ceilings: DeckCeilings) {
  const s: DeckSpend = { dayTokens: 0, weekTokens: 0, dayCostUsd: 0, weekCostUsd: 0, ...init };
  const adds: { tokens: number; costUsd: number }[] = [];
  const ledger: DeckLedger = {
    ceilings,
    current: () => ({ ...s }),
    add: (d) => { adds.push(d); s.dayTokens += d.tokens; s.weekTokens += d.tokens; s.dayCostUsd += d.costUsd; s.weekCostUsd += d.costUsd; },
  };
  return { ledger, adds };
}

test("deck ceiling ALREADY crossed refuses the run before any model call", async () => {
  // Plan 07: the loop drives streamText (doStream); a ceiling ALREADY crossed refuses before any call.
  const model = new MockLanguageModelV3({ doStream: streamOf(finalChunks) });
  const { ledger } = fakeLedger({ dayTokens: 1000 }, { dailyTokens: 1000 });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, deckLedger: ledger });
  expect(res.exhausted).toBe(true);
  expect(res.text).toContain("deck budget exhausted");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((model as any).doStreamCalls.length).toBe(0); // refused at the top of the loop, before spending
});

test("deck ceiling stops the run once ACCUMULATED spend crosses it (not the iteration cap)", async () => {
  // Always tool-calls, so only a budget stops it. usage fixture = 2 tok/call; dailyTokens:5 is crossed
  // after the 3rd call (2→4→6), so the 4th iteration's top-of-loop check refuses.
  const model = new MockLanguageModelV3({ doStream: streamOf(toolCallChunks) });
  const roomy = { ...agent, budgets: { ...agent.budgets, maxIterationsPerRun: 50 } };
  const { ledger, adds } = fakeLedger({}, { dailyTokens: 5 });
  const res = await runLoop({ model, agent: roomy, system: "S", messages: [{ role: "user", content: "go" }], tools, deckLedger: ledger });
  expect(res.exhausted).toBe(true);
  expect(res.text).toContain("deck budget exhausted");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((model as any).doStreamCalls.length).toBe(3); // 3 calls committed 6 tok, then refused
  expect(adds.length).toBe(3);
});

test("a subscription (codexBackend) call commits TOKENS but 0 USD to the deck ledger", async () => {
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
    codexBackend: true, priceUsd: () => 999, deckLedger: ledger, // priceUsd would be $999 — must be ignored
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

// A model whose call never settles: simulates the bun fetch stream that wedges on a dropped
// connection (never errors, never closes, never honors abort), which used to hang the loop forever.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wedgedStream = () => new MockLanguageModelV3({ doStream: (() => new Promise(() => {})) as any });

test("cancels a wedged streaming model call when the signal aborts (does not hang)", async () => {
  const controller = new AbortController();
  const p = runLoop({ model: wedgedStream(), agent, system: "S", messages: [{ role: "user", content: "go" }], tools, codexBackend: true, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const res = await p;
  expect(res.aborted).toBe(true);
  expect(res.text).toBe("[cancelled]");
}, 3000);

test("times out a wedged streaming model call instead of hanging (codex path)", async () => {
  const res = await runLoop({ model: wedgedStream(), agent, system: "S", messages: [{ role: "user", content: "go" }], tools, codexBackend: true, modelCallTimeoutMs: 150 });
  expect(res.error).toBeDefined();
  expect(res.text).toBe("[timed out]");
  expect(res.aborted).toBe(false);
}, 3000);

test("times out a wedged streaming model call on the env path too (idle watchdog everywhere, not just codex)", async () => {
  // Plan 07: the idle watchdog must guard the env (non-codex) path as well — the unified streaming
  // path means a wedged Anthropic/OpenAI/OpenRouter stream can no longer hang the loop.
  const res = await runLoop({ model: wedgedStream(), agent, system: "S", messages: [{ role: "user", content: "go" }], tools, modelCallTimeoutMs: 150 });
  expect(res.text).toBe("[timed out]");
  expect(res.error).toBeDefined();
  expect(res.aborted).toBe(false);
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

test("does NOT time out a streaming call that keeps making progress (idle timer resets per chunk)", async () => {
  // What this asserts: each chunk resets the idle window, so a steadily-progressing response is never
  // falsely killed. For that to be a *real* test, the WHOLE stream must outlast the idle window — a
  // watchdog that did NOT reset would fire at the window and truncate this healthy stream, failing the
  // assertion below. So we keep total-time > window while making each gap tiny relative to the window:
  //   20 chunks × 50ms ≈ 950ms total  >  500ms idle window   (a non-resetting watchdog fires at ~500ms)
  //   per-chunk gap 50ms  ≪  500ms window                      (~450ms cushion per gap)
  // That ~450ms absolute cushion (vs the old 20ms-gap / 100ms-window's ~80ms) means ordinary GC/CPU
  // jitter under load can't make a single scheduled gap slip past the window and falsely fire.
  const text = "abcdefghijklmnop"; // 16 progress deltas
  const model = new MockLanguageModelV3({
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0, chunkDelayInMs: 50,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          ...[...text].map((delta) => ({ type: "text-delta", id: "1", delta })),
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ],
      }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any,
  });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, modelCallTimeoutMs: 500 });
  expect(res.text).toBe(text);
}, 5000);
