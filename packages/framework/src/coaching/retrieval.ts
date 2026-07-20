/** Policy recall: embed task context -> vector candidates -> condition filter -> top-k.
 *  Everything retrieved/applied/skipped is recorded in the run trace ledger. */
import type { Database } from "bun:sqlite";
import type { PolicyNote } from "@taicho-ai/contracts/policy";
import { topK } from "../store/vectors";

export interface RecallResult { applied: PolicyNote[]; skipped: { id: string; reason: string }[]; retrieved: string[]; }

export async function recallPolicies(opts: {
  db: Database;
  taskContext: string;
  candidates: Map<string, PolicyNote>;   // approved notes for this agent (+team/global)
  embed: (text: string) => Promise<Float32Array>;
  conditionCheck: (note: PolicyNote, taskContext: string) => Promise<boolean>;
  k?: number;
}): Promise<RecallResult> {
  const q = await opts.embed(opts.taskContext);
  const hits = topK(opts.db, "policy", q, opts.k ?? 8).filter((h) => opts.candidates.has(h.ref));
  const applied: PolicyNote[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const h of hits) {
    const note = opts.candidates.get(h.ref)!;
    if (await opts.conditionCheck(note, opts.taskContext)) applied.push(note);
    else skipped.push({ id: note.id, reason: "condition no-match" });
  }
  return { applied, skipped, retrieved: hits.map((h) => h.ref) };
}
