import { test, expect } from "bun:test";
import { MockLanguageModelV3, mockValues } from "ai/test";
import { tool, type ToolSet } from "ai";
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
