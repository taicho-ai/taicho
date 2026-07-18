/** Test-only helper. Plan 07 unified the loop on `streamText`, so the AI SDK now drives every model
 *  via `doStream` (not `doGenerate`). Tests still script models as text / tool-call GENERATE results,
 *  so this `MockLanguageModelV3` subclass auto-derives a streaming `doStream` from a `doGenerate`
 *  script — converting each result into the equivalent LanguageModelV3 stream parts, which streamText
 *  drains back to the same aggregated fields (text, usage, toolCalls, providerMetadata). It still runs
 *  the script through the recording `doGenerate` wrapper, so `.doGenerateCalls[i].prompt` / `.length`
 *  assertions keep working unchanged. A test that passes `doStream` directly (the subscription/Codex
 *  shape) is left exactly as the real mock handles it.
 *
 *  Usage: swap `from "ai/test"` for `from "./mock-model"` in a test's imports — nothing else changes.
 *  `mockValues` and `simulateReadableStream` are re-exported so that single path move is enough. */
import { MockLanguageModelV3 as RealMockLanguageModelV3, mockValues, simulateReadableStream } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

export { mockValues, simulateReadableStream };

const DEFAULT_USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };

/** One generate result (content + finishReason + usage [+ providerMetadata]) → the stream parts a
 *  doStream emits. Text becomes start/delta/end; a tool call becomes a single `tool-call` part; the
 *  finish part carries usage + finishReason + any providerMetadata (e.g. OpenRouter's real cost). */
export function streamParts(r: LanguageModelV3GenerateResult): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = r as any;
  const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = Array.isArray(res.content) ? res.content : [];
  content.forEach((part, i) => {
    if (part.type === "text") {
      const id = `t${i}`;
      parts.push({ type: "text-start", id }, { type: "text-delta", id, delta: part.text }, { type: "text-end", id });
    } else if (part.type === "tool-call") {
      parts.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
    } else if (part.type === "reasoning") {
      const id = `g${i}`;
      parts.push({ type: "reasoning-start", id }, { type: "reasoning-delta", id, delta: part.text ?? "" }, { type: "reasoning-end", id });
    }
  });
  parts.push({
    type: "finish",
    finishReason: res.finishReason ?? { unified: "stop", raw: "stop" },
    usage: res.usage ?? DEFAULT_USAGE,
    providerMetadata: res.providerMetadata,
  });
  return parts;
}

type MockOpts = ConstructorParameters<typeof RealMockLanguageModelV3>[0];

export class MockLanguageModelV3 extends RealMockLanguageModelV3 {
  constructor(opts: MockOpts = {}) {
    const o = opts ?? {};
    if (o.doGenerate && !o.doStream) {
      super({ provider: o.provider, modelId: o.modelId, supportedUrls: o.supportedUrls, doGenerate: o.doGenerate });
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.doStream = (async (options: any) => {
        // Run the SAME script through the recording doGenerate wrapper (records doGenerateCalls +
        // advances mockValues), then stream the result it returns.
        const r = (await self.doGenerate(options)) as LanguageModelV3GenerateResult;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks: streamParts(r) as any }) };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
    } else {
      super(o);
    }
  }
}
