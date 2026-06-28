/** The agent loop. Model proposes (what); config disposes (how much): budgets + caps come from
 *  AgentDef/config — model-supplied budget params are ignored. The loop is the single meter for
 *  spend (tokens + advisory USD) and the single place caps + cancellation are enforced. */
import { generateText, streamText, type ModelMessage, type ToolSet } from "ai";
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
  /** ChatGPT/Codex-backend shape: the subscription endpoint rejects requests whose system prompt
   *  is sent as an `input` message ("Instructions are required") — it must arrive in the top-level
   *  `instructions` field, with store:false. The env (api.openai.com / Anthropic) path uses `system`. */
  codexBackend?: boolean;
  /** OpenRouter (usage:{include:true}) returns the authoritative per-call cost in
   *  providerMetadata.openrouter.usage.cost — prefer it over the static token pricer when set. */
  captureProviderCost?: boolean;
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

    type GenResult = Awaited<ReturnType<typeof generateText>>;
    let text: string;
    let usage: GenResult["usage"];
    let toolCalls: GenResult["toolCalls"];
    let responseMessages: GenResult["response"]["messages"];
    let providerMetadata: GenResult["providerMetadata"];
    try {
      if (opts.codexBackend) {
        // The ChatGPT/Codex backend requires SSE streaming ("Stream must be set to true") plus the
        // system prompt in the top-level `instructions` field with store:false ("Instructions are
        // required"). streamText sends stream:true; we drain it to completion and read the same
        // aggregated fields generateText would return, so the rest of the loop is identical.
        let streamErr: unknown;
        const s = streamText({
          model: opts.model, messages, tools: opts.tools, abortSignal: opts.signal,
          providerOptions: { openai: { instructions: opts.system, store: false } },
          onError: ({ error }) => { streamErr = error; },
        });
        await s.consumeStream();
        if (streamErr) throw streamErr;
        text = await s.text;
        usage = await s.usage;
        toolCalls = await s.toolCalls;
        responseMessages = (await s.response).messages;
      } else {
        const r = await generateText({ model: opts.model, system: opts.system, messages, tools: opts.tools, abortSignal: opts.signal });
        text = r.text; usage = r.usage; toolCalls = r.toolCalls; responseMessages = r.response.messages;
        providerMetadata = r.providerMetadata;
      }
    } catch (e) {
      if (opts.signal?.aborted) return done({ text: "[cancelled]", aborted: true });
      return done({ text: "[error]", error: e instanceof Error ? e.message : String(e) });
    }

    const inTok = usage?.inputTokens ?? 0, outTok = usage?.outputTokens ?? 0;
    inputTokens += inTok;
    outputTokens += outTok;
    tokens += usage?.totalTokens ?? inTok + outTok;
    // Prefer a provider-reported cost (OpenRouter) when available; else the static token pricer.
    const provCost = opts.captureProviderCost ? openrouterCostUsd(providerMetadata) : undefined;
    costUsd += provCost ?? opts.priceUsd?.({ inputTokens: inTok, outputTokens: outTok }) ?? 0;

    if (toolCalls.length === 0) {
      opts.onStep?.({ text });
      return done({ text, iterations: iterations + 1 });
    }
    for (const tc of toolCalls) {
      counts[tc.toolName] = (counts[tc.toolName] ?? 0) + 1;
      opts.onStep?.({ tool: tc.toolName });
    }
    messages.push(...responseMessages);
  }
  return done({ text: "[budget exhausted]", exhausted: true });
}

/** Read the authoritative USD cost OpenRouter returns under providerMetadata.openrouter.usage.cost.
 *  Returns undefined when absent/non-finite so the caller can fall back to the token pricer. */
function openrouterCostUsd(meta: unknown): number | undefined {
  const cost = (meta as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}
