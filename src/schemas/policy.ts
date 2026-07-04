import { z } from "zod";

/** A coaching note — one file per note under agents/<id>/policies/. */
export const PolicyNote = z.object({
  id: z.string(),                          // pol_xxxx
  agent: z.string(),
  when: z.string(),                        // condition, enforced at retrieval
  do: z.string(),                          // instruction
  scope: z.enum(["agent", "global"]).default("agent"),
  status: z.enum(["proposed", "approved", "rejected", "superseded"]),
  supersedes: z.string().optional(),       // id of the note this replaces
  taughtBy: z.string(),
  fromRun: z.string().optional(),          // run id the coaching came from
  created: z.string().datetime(),
  expanded: z.array(z.string()).default([]), // write-time paraphrases for recall
});
export type PolicyNote = z.infer<typeof PolicyNote>;

/** Approved output bound to a request pattern. */
export const Exemplar = z.object({
  id: z.string(),                          // ex_xxxx
  agent: z.string(),
  pattern: z.string(),                     // request pattern this answers
  artifact: z.string(),                    // artifact HANDLE ("id" ⇒ latest, or "id@vN") — resolves via the
                                           // artifact store (store/artifacts.ts), NOT a raw filesystem path.
                                           // Plan 01 Ph4c: keying on the stable, versioned, relocatable id
                                           // (never an absolute path) is what lets an exemplar survive a
                                           // revision/workspace move — same addressing as delegate hand-off.
  mode: z.enum(["serve", "imitate"]).default("imitate"),
  status: z.enum(["proposed", "approved", "rejected", "superseded"]),
  taughtBy: z.string(),
  created: z.string().datetime(),
});
export type Exemplar = z.infer<typeof Exemplar>;
