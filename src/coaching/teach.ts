/** Turn a captain's free-text correction into a policy draft (one LLM call), and persist an
 *  approved note. The draft→approve UI lives in the REPL; this is the testable core. */
import { generateText, streamText } from "ai";
import { ProposalDraft, toPolicy } from "./proposal";
import { writePolicy } from "../store/policy";
import type { PolicyNote } from "../schemas/policy";
import { SQUAD_SCOPE, type SpendLedger } from "../store/spend-ledger";

type Model = Parameters<typeof generateText>[0]["model"];
type Usage = Awaited<ReturnType<typeof generateText>>["usage"];

/** Options for the coaching distiller's one model call.
 *  - codexBackend (Plan 07): the ChatGPT/Codex subscription backend REJECTS non-streaming requests and
 *    requires the system prompt in providerOptions.openai.instructions with store:false — a bare
 *    generateText 400s ("Stream must be set to true" / "Instructions are required") for a signed-in
 *    subscription user. So on that backend the call routes through streamText (drained to completion),
 *    exactly like the agent loop (see loop.ts). The env path (api key) uses plain generateText.
 *  - spendLedger/priceUsd (Plan 09): the distiller is a real model call the squad caused, so it's metered
 *    against the squad ceiling. It runs OUTSIDE any run (no trace) ⇒ NOT surfaced in /costs (see costs.ts).
 *    Subscription/unpriced ⇒ 0 USD (honest: tokens still count; the USD ceiling never fabricates spend). */
export interface DraftOptions {
  codexBackend?: boolean;
  spendLedger?: SpendLedger;
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
}

export async function draftPolicy(model: Model, agentId: string, correction: string, opts?: DraftOptions): Promise<ProposalDraft> {
  const system = `You convert a captain's correction for agent "${agentId}" into a standing instruction. Respond with ONLY a JSON object: {"when":"<condition it applies under>","do":"<imperative instruction>","scope":"agent" or "global"}. No prose, no code fence.`;
  const messages = [{ role: "user" as const, content: correction }];

  // Route the SAME way the agent loop does (Plan 07): Codex subscription ⇒ streamText with the system
  // prompt in `instructions` + store:false (the backend rejects non-streaming / a top-level system);
  // env (api key) ⇒ plain generateText. Either way we read back text + usage identically.
  let text: string;
  let usage: Usage | undefined;
  if (opts?.codexBackend) {
    let streamErr: unknown;
    const s = streamText({
      model, messages,
      providerOptions: { openai: { instructions: system, store: false } },
      onError: ({ error }) => { streamErr = error; },
    });
    await s.consumeStream();
    if (streamErr) throw streamErr;
    text = await s.text;
    usage = await s.usage;
  } else {
    const res = await generateText({ model, system, messages });
    text = res.text;
    usage = res.usage;
  }

  // Commit the distiller's spend to the squad ceiling (Plan 09) BEFORE parsing — the tokens were spent
  // regardless of whether the JSON parses. No priceUsd (subscription/unpriced) ⇒ 0 USD; tokens always count.
  if (opts?.spendLedger) {
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const tokens = usage?.totalTokens ?? inputTokens + outputTokens;
    // Outside any run (no agent, no team) — the squad scope is the only honest one.
    opts.spendLedger.add([SQUAD_SCOPE], { tokens, costUsd: opts.priceUsd?.({ inputTokens, outputTokens }) ?? 0 });
  }

  const trimmed = text.trim();
  const json = trimmed.startsWith("{") ? trimmed : (trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed);
  return ProposalDraft.parse(JSON.parse(json));
}

/** Persist an APPROVED policy note (coaching is approval-gated, so status is forced approved). */
export function persistApprovedPolicy(ws: string, draft: ProposalDraft, agentId: string, fromRun?: string): PolicyNote {
  const valid = ProposalDraft.parse(draft);
  const note: PolicyNote = { ...toPolicy(valid, { agent: agentId, taughtBy: "user", fromRun }), status: "approved" };
  writePolicy(ws, note);
  return note;
}
