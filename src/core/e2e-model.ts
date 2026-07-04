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

// A doStream result: the given LanguageModelV3 stream parts. `initialDelayInMs` holds the FIRST
// chunk back (the whole call stays in-flight that long) — used by the slow-mode scenarios below to
// keep an agent visibly live long enough for VHS to freeze-frame its pane + bar segment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stream(chunks: unknown[], initialDelayInMs = 0): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { stream: simulateReadableStream({ initialDelayInMs, chunkDelayInMs: 0, chunks: chunks as any }) };
}

// Streamed text response: start → one delta carrying the whole text → end → finish(stop).
// `delayMs` (default 0) holds the model call in-flight before ANY output — the loop has already
// emitted `model_start` (→ live "thinking" status) by then, so the agent renders as a live pane +
// bar segment for the whole delay. Plan 12: there is no loop-level watchdog; the only deadline is the
// provider fetch's transport timeout (120s default), which this mock never touches. Deterministic
// (fixed delay, no network).
function text(t: string, delayMs = 0) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: t },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ], delayMs);
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

/** artifact-handoff (Plan 01): prove the hand-off store end-to-end through the real binary.
 *  root creates a researcher (agent A) and a writer (agent B), then wires A→B BY REFERENCE:
 *    - A (researcher) save_artifacts a dossier whose body carries a distinctive payload marker.
 *    - root delegates to B (writer) with inputArtifacts:[dossier@v1] — a HANDLE, not the body.
 *    - B read_artifacts the dossier (the consumer legitimately pulls it) and save_artifacts a brief
 *      linked back via parents:[dossier@v1].
 *    - root's own context only ever sees handles + thin summaries — the dossier BODY payload never
 *      enters root's transcript. The scenario asserts exactly that (parent context stays thin).
 *  One shared counter drives the interleaved root/child turns in execution order (delegate BLOCKS, so
 *  the child's turns run inline between the two root delegations — a deterministic linear script). */
export const DOSSIER_PAYLOAD = "DOSSIER_PAYLOAD_XYZZY_do_not_inline_into_the_parent_context";
function artifactHandoffModel(): Model {
  let n = 0;
  return new MockLanguageModelV3({
    provider: "taicho-e2e",
    modelId: "artifact-handoff",
    doStream: async () => {
      n += 1;
      // root run 1 — create agent A (researcher)
      if (n === 1) return call("create_agent", {
        id: "researcher", role: "Researches topics and writes dossiers",
        identity: "You are researcher. Produce a dossier artifact and hand it off by reference.",
      });
      if (n === 2) return text("Created researcher.");
      // root run 2 — create agent B (writer)
      if (n === 3) return call("create_agent", {
        id: "writer", role: "Turns dossiers into briefs",
        identity: "You are writer. Read the input dossier by reference and produce a brief.",
      });
      if (n === 4) return text("Created writer.");
      // root run 3 — A produces, root wires A→B by reference, B consumes + derives
      if (n === 5) return call("delegate_task", { to: "researcher", goal: "Produce a research dossier on foo." });
      if (n === 6) return call("save_artifact", {
        id: "dossier", title: "Foo dossier", type: "dossier",
        summary: "a short summary of foo (safe to carry in context)",
        body: `# Foo dossier\n\n${DOSSIER_PAYLOAD}\n\n(...the heavy body that must NOT pollute the parent...)`,
      });
      if (n === 7) return text("Saved dossier@v1.");
      if (n === 8) return call("delegate_task", { to: "writer", goal: "Turn the dossier into a one-paragraph brief.", inputArtifacts: ["dossier@v1"] });
      if (n === 9) return call("read_artifact", { id: "dossier@v1", includeBody: true });
      if (n === 10) return call("save_artifact", { id: "brief", title: "Foo brief", type: "brief", summary: "the brief derived from the dossier", body: "Foo, briefly: it is what the dossier says.", parents: ["dossier@v1"] });
      if (n === 11) return text("Wrote brief@v1 from dossier@v1.");
      return text("Root wired researcher to writer by reference: brief@v1 from dossier@v1.");
    },
  }) as unknown as Model;
}

/** How long (ms) the squad-panes child holds its model call in-flight so its live pane + bar segment
 *  are on screen long enough for VHS to `Wait+Screen` + screenshot. Fixed default, overridable via
 *  TAICHO_E2E_SLOW_MS (deterministic — a duration, never a race). ~4s dwarfs VHS's poll interval and
 *  sits far under the provider fetch's 120s transport deadline (Plan 12; no loop-level watchdog). */
const SQUAD_PANES_SLOW_MS = Number(process.env.TAICHO_E2E_SLOW_MS ?? 4000);

/** squad-panes (Plan 10 Phase 5): the SLOW-MODE delegation that makes the split-pane view provable.
 *  Same shape as agent-flow (create proof-agent → approve → delegate → roll the proof up), but the
 *  child's single model call is HELD in-flight for SQUAD_PANES_SLOW_MS. During that window two agents
 *  are live at once — root `delegating` (its delegate_task tool is blocked on the child) and
 *  proof-agent `thinking` (its model call is running) — so taicho renders a pane + bar segment for
 *  each, long enough for VHS to freeze-frame the two-agents-in-panes+bar state before it completes.
 *  Without the hold the child returns sub-second and the pane flashes faster than a recorded frame. */
function squadPanesModel(): Model {
  let n = 0;
  return new MockLanguageModelV3({
    provider: "taicho-e2e",
    modelId: "squad-panes",
    doStream: async () => {
      n += 1;
      // root run 1 — create proof-agent
      if (n === 1) return call("create_agent", {
        id: "proof-agent",
        role: "Proof worker",
        identity: "You are proof-agent. Complete delegated work with a concise proof message.",
      });
      if (n === 2) return text("Created proof-agent.");
      // root run 2 — delegate (root stays `delegating`, blocked on the child below)
      if (n === 3) return call("delegate_task", {
        to: "proof-agent",
        goal: "Produce proof that the created agent was used.",
      });
      // the child's only model call — SLOW: proof-agent stays visibly `thinking` while root delegates
      if (n === 4) return text("proof-agent completed delegated work", SQUAD_PANES_SLOW_MS);
      // root rolls the child's proof back up
      return text("Root used proof-agent: proof-agent completed delegated work");
    },
  }) as unknown as Model;
}

export function createE2eModel(mode: string | undefined): Model | null {
  if (mode === "agent-flow") return agentFlowModel();
  if (mode === "conversation-audit") return conversationAuditModel();
  if (mode === "artifact-handoff") return artifactHandoffModel();
  if (mode === "squad-panes") return squadPanesModel();
  return null;
}
