/** Deterministic model used only by real-binary e2e tests.
 *  It lets tui-test drive the compiled CLI through multi-agent flows without external network. */
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { Model } from "./model";

const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } } as const;

function text(t: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text: t }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
  } as unknown as LanguageModelV3GenerateResult;
}

function call(name: string, input: object): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" },
    usage,
  } as unknown as LanguageModelV3GenerateResult;
}

export function createE2eModel(mode: string | undefined): Model | null {
  if (mode !== "agent-flow") return null;
  let n = 0;
  return new MockLanguageModelV3({
    provider: "taicho-e2e",
    modelId: "agent-flow",
    doGenerate: async () => {
      n += 1;
      if (n === 1) return call("create_agent", {
        id: "proof-agent",
        role: "Proof worker",
        identity: "You are proof-agent. Complete delegated work with a concise proof message.",
      });
      if (n === 2) return text("Created proof-agent.");
      if (n === 3) return call("delegate_task", {
        to: "proof-agent",
        goal: "Produce proof that the created agent was used.",
      });
      if (n === 4) return text("proof-agent completed delegated work");
      return text("Root used proof-agent: proof-agent completed delegated work");
    },
  }) as unknown as Model;
}
