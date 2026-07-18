/** Write-time contradiction check: new coaching that conflicts with an existing note
 *  sets `supersedes` — an explicit replacement record, never a silent overwrite. */
import type { PolicyNote } from "@taicho/contracts/policy";

export async function findContradiction(
  draft: { when: string; do: string },
  existing: PolicyNote[],
  judge: (a: string, b: string) => Promise<boolean>,  // one LLM call: do these conflict?
): Promise<PolicyNote | undefined> {
  for (const note of existing.filter((n) => n.status === "approved")) {
    if (await judge(`WHEN ${draft.when}: ${draft.do}`, `WHEN ${note.when}: ${note.do}`)) return note;
  }
  return undefined;
}
