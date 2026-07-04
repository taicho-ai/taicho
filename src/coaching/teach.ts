/** Turn a captain's free-text correction into a policy draft (one LLM call), and persist an
 *  approved note. The draft→approve UI lives in the REPL; this is the testable core. */
import { generateText } from "ai";
import { ProposalDraft, toPolicy } from "./proposal";
import { writePolicy } from "../store/policy";
import type { PolicyNote } from "../schemas/policy";
import type { DeckLedger } from "../store/deck-budget";

type Model = Parameters<typeof generateText>[0]["model"];

/** Plan 09: the coaching distiller is a real model call the deck caused, so it must count against the
 *  deck ceiling. It runs OUTSIDE any run (no trace), so it is metered into the deck ledger here but is
 *  NOT surfaced in /costs (which itemizes run traces — see costs.ts). Subscription/unpriced ⇒ 0 USD
 *  (honest: tokens still count, the USD ceiling never sees a fabricated figure). */
interface DraftMeter {
  deckLedger?: DeckLedger;
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
}

export async function draftPolicy(model: Model, agentId: string, correction: string, meter?: DraftMeter): Promise<ProposalDraft> {
  const res = await generateText({
    model,
    system: `You convert a captain's correction for agent "${agentId}" into a standing instruction. Respond with ONLY a JSON object: {"when":"<condition it applies under>","do":"<imperative instruction>","scope":"agent" or "global"}. No prose, no code fence.`,
    messages: [{ role: "user", content: correction }],
  });
  // Commit the distiller's spend to the deck ceiling BEFORE parsing — the tokens were spent regardless
  // of whether the JSON parses. No priceUsd (subscription/unpriced) ⇒ 0 USD; tokens always count.
  if (meter?.deckLedger) {
    const inputTokens = res.usage?.inputTokens ?? 0;
    const outputTokens = res.usage?.outputTokens ?? 0;
    const tokens = res.usage?.totalTokens ?? inputTokens + outputTokens;
    meter.deckLedger.add({ tokens, costUsd: meter.priceUsd?.({ inputTokens, outputTokens }) ?? 0 });
  }
  const text = res.text.trim();
  const json = text.startsWith("{") ? text : (text.match(/\{[\s\S]*\}/)?.[0] ?? text);
  return ProposalDraft.parse(JSON.parse(json));
}

/** Persist an APPROVED policy note (coaching is approval-gated, so status is forced approved). */
export function persistApprovedPolicy(ws: string, draft: ProposalDraft, agentId: string, fromRun?: string): PolicyNote {
  const valid = ProposalDraft.parse(draft);
  const note: PolicyNote = { ...toPolicy(valid, { agent: agentId, taughtBy: "user", fromRun }), status: "approved" };
  writePolicy(ws, note);
  return note;
}
