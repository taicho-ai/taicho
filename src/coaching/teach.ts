/** Turn a captain's free-text correction into a policy draft (one LLM call), and persist an
 *  approved note. The draft→approve UI lives in the REPL; this is the testable core. */
import { generateText } from "ai";
import { ProposalDraft, toPolicy } from "./proposal";
import { writePolicy } from "../store/policy";
import type { PolicyNote } from "../schemas/policy";

type Model = Parameters<typeof generateText>[0]["model"];

export async function draftPolicy(model: Model, agentId: string, correction: string): Promise<ProposalDraft> {
  const res = await generateText({
    model,
    system: `You convert a captain's correction for agent "${agentId}" into a standing instruction. Respond with ONLY a JSON object: {"when":"<condition it applies under>","do":"<imperative instruction>","scope":"agent" or "global"}. No prose, no code fence.`,
    messages: [{ role: "user", content: correction }],
  });
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
