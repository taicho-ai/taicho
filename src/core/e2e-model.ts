/** Deterministic model used only by real-binary e2e tests.
 *  It lets tui-test drive the compiled CLI through multi-agent flows without external network.
 *
 *  Plan 07: the loop now unifies on `streamText` for EVERY provider, so the AI SDK calls a model's
 *  `doStream` (not `doGenerate`). This model therefore implements `doStream` — emitting the same
 *  text / tool-call it used to return from `doGenerate`, drained to completion by the loop. */
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { Model } from "./model";

// Raw provider-level usage (LanguageModelV3Usage: `{ inputTokens: { total }, outputTokens: { total } }`);
// the SDK normalizes it to the user-facing `{ inputTokens, outputTokens }` the loop meters.
const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } } as const;

// A doStream result: the given LanguageModelV3 stream parts, emitted with no artificial delay.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stream(chunks: unknown[]): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks: chunks as any }) };
}

// Streamed text response: start → one delta carrying the whole text → end → finish(stop).
function text(t: string) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: t },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ]);
}

// Streamed tool call: a single tool-call part → finish(tool-calls). The loop drains it, counts the
// call, executes the tool, and loops.
function call(name: string, input: object) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
  ]);
}

/** agent-flow: create_agent → approve → delegate_task → roll the child's proof back up. */
function agentFlowModel(): Model {
  let n = 0;
  return new MockLanguageModelV3({
    provider: "taicho-e2e",
    modelId: "agent-flow",
    doStream: async () => {
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
 *  `interrupted` (not a race with an instant return). On abort we error the stream with the signal's
 *  reason (a real AbortError), which the loop treats as a clean cancellation — the same
 *  interrupted-turn path the tui-test drives, but deterministic under vhs.
 *
 *  Under the unified streaming path (Plan 07) the model implements `doStream`: the hang is a
 *  ReadableStream that emits nothing and only errors when the abort fires (immediate, not on the
 *  idle-timeout grace), so the interrupt stays deterministic.
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
    doStream: async (options: { abortSignal?: AbortSignal }) => {
      n += 1;
      if (n === 1) return call("find_skills", { query: "delegate work to a worker agent" });
      const signal = options.abortSignal;
      // A stream that emits nothing and errors only when the run aborts. consumeStream then settles,
      // the loop surfaces the abort, and the top-of-iteration abort check marks the turn interrupted.
      const hanging = new ReadableStream({
        start(controller) {
          const onAbort = () =>
            controller.error(signal?.reason ?? new Error("aborted by e2e conversation-audit model"));
          if (signal?.aborted) { onAbort(); return; }
          signal?.addEventListener("abort", onAbort, { once: true });
        },
      });
      return { stream: hanging };
    },
  }) as unknown as Model;
}

export function createE2eModel(mode: string | undefined): Model | null {
  if (mode === "agent-flow") return agentFlowModel();
  if (mode === "conversation-audit") return conversationAuditModel();
  return null;
}
