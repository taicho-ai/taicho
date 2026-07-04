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

/** agent-flow: create_agent → approve → delegate_task → roll the child's proof back up. */
function agentFlowModel(): Model {
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

/** conversation-audit: the run gets one quick, offline tool cycle, then the NEXT model call HANGS
 *  until the run's abort signal fires — so the run is genuinely in-flight and an Esc mid-run marks it
 *  `interrupted` (not a race with an instant return). On abort we reject with the signal's reason (a
 *  real AbortError), which the loop treats as a clean cancellation — the same interrupted-turn path
 *  the tui-test drives, but deterministic under vhs.
 *
 *  Why the first call is a `find_skills` tool call (not an immediate hang): it makes the loop finish
 *  one full model→tool cycle BEFORE hanging, which (a) writes model_request/model_response/tool_call
 *  to `transcript.jsonl` so the interrupted turn still has a transcript (the tui-test asserts this),
 *  and (b) emits a "↳ root → find_skills()" breadcrumb the tape gates the Esc on — a deterministic
 *  screen signal that the run has moved past first-turn workspace setup into a hanging model call, so
 *  no load-bearing fixed Sleep is needed. `find_skills` is granted to every agent and runs offline
 *  (keyword ranking over the seeded skills — no network, no approval, no side effects). */
function conversationAuditModel(): Model {
  let n = 0;
  return new MockLanguageModelV3({
    provider: "taicho-e2e",
    modelId: "conversation-audit",
    doGenerate: async (options: { abortSignal?: AbortSignal }) => {
      n += 1;
      if (n === 1) return call("find_skills", { query: "delegate work to a worker agent" });
      const signal = options.abortSignal;
      return await new Promise<LanguageModelV3GenerateResult>((_resolve, reject) => {
        const onAbort = () => reject(signal?.reason ?? new Error("aborted by e2e conversation-audit model"));
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  }) as unknown as Model;
}

export function createE2eModel(mode: string | undefined): Model | null {
  if (mode === "agent-flow") return agentFlowModel();
  if (mode === "conversation-audit") return conversationAuditModel();
  return null;
}
