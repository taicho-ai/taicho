/** Every correction forces a proposal — writes are never left to the agent's discretion.
 *  A silently dropped instruction is the worst failure in a managerial trust model. */
import { z } from "zod";
import type { PolicyNote } from "../schemas/policy";

export const ProposalDraft = z.object({
  when: z.string().describe("condition under which this instruction applies"),
  do: z.string().describe("the instruction itself, imperative"),
  scope: z.enum(["agent", "team", "global"]).default("agent"),
});
export type ProposalDraft = z.infer<typeof ProposalDraft>;

export function toPolicy(d: ProposalDraft, meta: {
  agent: string; taughtBy: string; fromRun?: string; supersedes?: string;
}): PolicyNote {
  return {
    id: `pol_${crypto.randomUUID().slice(0, 8)}`,
    agent: meta.agent,
    when: d.when,
    do: d.do,
    scope: d.scope,
    status: "proposed",
    supersedes: meta.supersedes,
    taughtBy: meta.taughtBy,
    fromRun: meta.fromRun,
    created: new Date().toISOString(),
    expanded: [],
  };
}
