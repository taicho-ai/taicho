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
