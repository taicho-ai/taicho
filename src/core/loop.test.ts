import { test, expect } from "bun:test";
import { MockLanguageModelV3, mockValues } from "ai/test";
import { tool, simulateReadableStream, type ToolSet } from "ai";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { z } from "zod";
import { runLoop } from "./loop";
import type { AgentDef } from "../schemas/agent";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;
const toolCallResp = {
  content: [{ type: "tool-call", toolCallId: "c1", toolName: "noop", input: JSON.stringify({}) }],
  finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
} as unknown as LanguageModelV3GenerateResult;
const finalResp = {
  content: [{ type: "text", text: "all done" }],
  finishReason: { unified: "stop", raw: "stop" }, usage,
} as unknown as LanguageModelV3GenerateResult;

const agent: AgentDef = {
  id: "a", role: "r", identity: "i", tools: ["noop"], canSee: ["*"], canDelegateTo: [],
  budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 }, isRoot: false,
  created: "2026-06-11T00:00:00.000Z",
};
const tools: ToolSet = {
  noop: tool({ description: "no-op", inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
};

test("loop returns final text after a tool-call round", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(toolCallResp, finalResp) as any });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools });
  expect(res.text).toBe("all done");
  expect(res.toolCalls.noop).toBe(1);
});

test("loop falls through to budget-exhausted when the model always tool-calls", async () => {
  const budgetAgent: AgentDef = { ...agent, budgets: { ...agent.budgets, maxIterationsPerRun: 2 } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: (async () => toolCallResp) as any });
  const res = await runLoop({ model, agent: budgetAgent, system: "S", messages: [{ role: "user", content: "go" }], tools });
  expect(res.text).toBe("[budget exhausted]");
  expect(res.exhausted).toBe(true);
  expect(res.iterations).toBe(2);
});

test("a queued steer is injected as a marked user message before the next call", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(toolCallResp, finalResp) as any });
  let fired = false;
  const pollSteer = () => { if (!fired) { fired = true; return null; } return "actually, stop after this"; };
  await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, pollSteer });
  // second model call's prompt must contain the steer marker
  const secondPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
  expect(secondPrompt).toContain("OUT-OF-BAND USER MESSAGE");
  expect(secondPrompt).toContain("actually, stop after this");
});

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

test("captureProviderCost: uses providerMetadata.openrouter.usage.cost, overriding the token pricer", async () => {
  const withCost = {
    ...(finalResp as object),
    providerMetadata: { openrouter: { usage: { cost: 0.0042 } } },
  } as unknown as LanguageModelV3GenerateResult;
  const model = new MockLanguageModelV3({ doGenerate: mockValues(withCost) as any });
  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    captureProviderCost: true,
    priceUsd: () => 999, // would be used if the provider cost were missing — proves the override
  });
  expect(res.costUsd).toBe(0.0042);
});

test("captureProviderCost: falls back to the token pricer when no provider cost is reported", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(finalResp) as any });
  const res = await runLoop({
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools,
    captureProviderCost: true,
    priceUsd: ({ inputTokens, outputTokens }) => inputTokens * 2 + outputTokens * 3,
  });
  expect(res.costUsd).toBe(5); // usage fixture 1/1 → 1*2 + 1*3
});

test("stops with exhausted when the token cap is reached", async () => {
  const capped = { ...agent, budgets: { ...agent.budgets, maxIterationsPerRun: 30, maxTokensPerRun: 1 } };
  const model = new MockLanguageModelV3({ doGenerate: (async () => toolCallResp) as any });
  const res = await runLoop({ model, agent: capped, system: "S", messages: [{ role: "user", content: "go" }], tools });
  expect(res.exhausted).toBe(true);
  // proves the TOKEN cap (not the 30-iteration cap) stopped it: exactly one model call happened
  expect((model as any).doGenerateCalls.length).toBe(1);
});

test("stops with exhausted when the cost cap is reached (not the iteration cap)", async () => {
  const capped = { ...agent, budgets: { ...agent.budgets, maxIterationsPerRun: 30, maxCostPerRunUsd: 0.001 } };
  const model = new MockLanguageModelV3({ doGenerate: (async () => toolCallResp) as any });
  const res = await runLoop({ model, agent: capped, system: "S", messages: [{ role: "user", content: "go" }], tools, priceUsd: () => 1 });
  expect(res.exhausted).toBe(true);
  expect((model as any).doGenerateCalls.length).toBe(1); // one $1 call exceeds the $0.001 cap
});

test("aborts when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = new MockLanguageModelV3({ doGenerate: (async () => finalResp) as any });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, signal: controller.signal });
  expect(res.aborted).toBe(true);
});

test("codexBackend streams (doStream) and routes system -> providerOptions.openai.instructions (+ store:false), not as a system message", async () => {
  // The ChatGPT/Codex backend requires SSE streaming ("Stream must be set to true"), so the codex
  // path must use streamText (doStream), not generateText (doGenerate).
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
    })) as any,
  });
  const res = await runLoop({ model, agent, system: "SYS", messages: [{ role: "user", content: "go" }], tools, codexBackend: true });
  expect(res.text).toBe("all done"); // proves the streamed text was aggregated
  const call = (model as any).doStreamCalls[0];
  // rejected as "Instructions are required" unless `system` arrives here:
  expect(call.providerOptions?.openai?.instructions).toBe("SYS");
  expect(call.providerOptions?.openai?.store).toBe(false);
  // ...and NOT duplicated as a system message in the input prompt
  expect(JSON.stringify(call.prompt)).not.toContain("SYS");
});

test("env path (no codexBackend) keeps system as a normal system prompt, no instructions override", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(finalResp) as any });
  await runLoop({ model, agent, system: "SYS", messages: [{ role: "user", content: "go" }], tools });
  const call = (model as any).doGenerateCalls[0];
  expect(call.providerOptions?.openai?.instructions).toBeUndefined();
  expect(JSON.stringify(call.prompt)).toContain("SYS"); // system delivered the normal way
});

test("returns a structured error (does not throw) when the model call fails", async () => {
  const model = new MockLanguageModelV3({ doGenerate: (() => { throw new Error("boom"); }) as any });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools });
  expect(res.error).toContain("boom");
  expect(res.aborted).toBe(false);
  expect(res.exhausted).toBe(false);
});

// A model whose call never settles: simulates the bun fetch stream that wedges on a dropped
// connection (never errors, never closes, never honors abort), which used to hang the loop forever.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wedgedStream = () => new MockLanguageModelV3({ doStream: (() => new Promise(() => {})) as any });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wedgedGen = () => new MockLanguageModelV3({ doGenerate: (() => new Promise(() => {})) as any });

test("cancels a wedged streaming model call when the signal aborts (does not hang)", async () => {
  const controller = new AbortController();
  const p = runLoop({ model: wedgedStream(), agent, system: "S", messages: [{ role: "user", content: "go" }], tools, codexBackend: true, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const res = await p;
  expect(res.aborted).toBe(true);
  expect(res.text).toBe("[cancelled]");
}, 3000);

test("times out a wedged streaming model call instead of hanging", async () => {
  const res = await runLoop({ model: wedgedStream(), agent, system: "S", messages: [{ role: "user", content: "go" }], tools, codexBackend: true, modelCallTimeoutMs: 150 });
  expect(res.error).toBeDefined();
  expect(res.text).toBe("[timed out]");
  expect(res.aborted).toBe(false);
}, 3000);

test("times out a wedged non-streaming model call instead of hanging", async () => {
  const res = await runLoop({ model: wedgedGen(), agent, system: "S", messages: [{ role: "user", content: "go" }], tools, modelCallTimeoutMs: 150 });
  expect(res.text).toBe("[timed out]");
  expect(res.error).toBeDefined();
}, 3000);

test("codexBackend forwards streamed text deltas via onStep (so the UI can render live)", async () => {
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
    model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, codexBackend: true,
    onStep: (i) => { if (i.delta) deltas.push(i.delta); },
  });
  expect(deltas).toEqual(["Hel", "lo, ", "world"]); // each chunk surfaced incrementally, in order
  expect(deltas.join("")).toBe(res.text);            // and they reconstruct the final text
});

test("does NOT time out a streaming call that keeps making progress (idle timer resets per chunk)", async () => {
  // ~8 chunks at 20ms each ≈ 160ms total > the 100ms idle window, but each text-delta resets the
  // idle timer, so a steadily-progressing response is never falsely killed.
  const model = new MockLanguageModelV3({
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0, chunkDelayInMs: 20,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "a" },
          { type: "text-delta", id: "1", delta: "b" },
          { type: "text-delta", id: "1", delta: "c" },
          { type: "text-delta", id: "1", delta: "d" },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ],
      }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any,
  });
  const res = await runLoop({ model, agent, system: "S", messages: [{ role: "user", content: "go" }], tools, codexBackend: true, modelCallTimeoutMs: 100 });
  expect(res.text).toBe("abcd");
}, 3000);
