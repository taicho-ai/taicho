/** The agent loop. Model proposes (what); config disposes (how much):
 *  budgets come from AgentDef/config — model-supplied budget params are ignored by design. */
import { generateText, type ModelMessage, type ToolSet } from "ai";
import type { AgentDef } from "../schemas/agent";
import { steerMarker } from "./prompt";

export interface LoopResult {
  text: string;
  toolCalls: Record<string, number>;
  tokens: number;
  iterations: number;
}

export async function runLoop(opts: {
  model: Parameters<typeof generateText>[0]["model"];
  agent: AgentDef;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  onStep?: (info: { text?: string; tool?: string }) => void;
  pollSteer?: () => string | null;
}): Promise<LoopResult> {
  const counts: Record<string, number> = {};
  let tokens = 0;
  let iterations = 0;
  const messages = [...opts.messages];

  for (; iterations < opts.agent.budgets.maxIterationsPerRun; iterations++) {
    const steer = opts.pollSteer?.();
    if (steer) messages.push({ role: "user", content: steerMarker(steer) });

    const res = await generateText({
      model: opts.model,
      system: opts.system,
      messages,
      tools: opts.tools,
    });
    tokens += res.usage?.totalTokens ?? 0;

    if (res.toolCalls.length === 0) {
      opts.onStep?.({ text: res.text });
      return { text: res.text, toolCalls: counts, tokens, iterations: iterations + 1 };
    }
    for (const tc of res.toolCalls) {
      counts[tc.toolName] = (counts[tc.toolName] ?? 0) + 1;
      opts.onStep?.({ tool: tc.toolName });
    }
    messages.push(...res.response.messages);
  }
  return { text: "[budget exhausted]", toolCalls: counts, tokens, iterations };
}
