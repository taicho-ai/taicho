/** Plan 06 Phase 3 — repeated verification failures feed coaching.
 *
 *  A single failed acceptance check is noise; the SAME agent failing the SAME criteria across
 *  MULTIPLE delegations is a standing gap the captain may want to codify. When that repeat crosses a
 *  threshold we PROPOSE a coaching note — status "proposed", exactly like a /teach proposal before the
 *  captain approves it. A proposed note is INERT (run.ts only applies status:"approved" notes), so this
 *  is a suggestion awaiting the captain, never an auto-applied policy. This mirrors coaching's
 *  correction→policy proposal path (teach.ts), minus the LLM distiller: the failure reasons are already
 *  structured, so the draft is deterministic (and the pattern detection stays testable, no network). */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { toPolicy } from "./proposal";
import { writePolicy } from "../store/policy";
import type { PolicyNote } from "@taicho-ai/contracts/policy";

/** How many delegations of the SAME (agent, criteria) must FAIL before coaching is proposed. The
 *  2nd failure is the first REPEAT — a one-off never proposes. Kept intentionally low + defensible. */
export const REPEAT_FAILURE_THRESHOLD = 2;

/** One terminal verification failure — the child run is the dedupe key (one record per delegation). */
const FailureRecord = z.object({
  targetAgent: z.string(),                 // the child agent whose output failed the check
  criteria: z.string(),                    // the acceptance criteria it failed (raw, for display + normalized match)
  runId: z.string(),                       // the failing child run — dedupe key
  reasons: z.array(z.string()).default([]),// the unmet-criteria reasons from the verdict
  at: z.string(),
});
type FailureRecord = z.infer<typeof FailureRecord>;

/** Squad-level append-only ledger of verification failures (one JSON object per line). */
function ledgerFile(ws: string): string {
  return join(ws, "verification-failures.jsonl");
}

/** Collapse trivial variation so "must mention Y" and "  Must  mention  Y " count as one pattern. */
function normalize(criteria: string): string {
  return criteria.trim().replace(/\s+/g, " ").toLowerCase();
}

function readLedger(ws: string): FailureRecord[] {
  const f = ledgerFile(ws);
  if (!existsSync(f)) return [];
  const out: FailureRecord[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(FailureRecord.parse(JSON.parse(line))); } catch { /* skip a corrupt audit line */ }
  }
  return out;
}

export interface RecordFailureInput {
  targetAgent: string;
  criteria: string;
  runId: string;
  reasons?: string[];
}

/** Record one delegation's terminal verification FAILURE. If this failure makes the (agent, criteria)
 *  repeat count reach REPEAT_FAILURE_THRESHOLD for the FIRST time, PROPOSE a coaching note (status
 *  "proposed") scoped to the target agent and return it. Fires at most once per pattern (exactly when a
 *  NEW distinct child run brings the count to the threshold); further failures do not re-nag, and a
 *  duplicate runId can neither double-count nor re-propose. Never throws on a bad ws. */
export function recordVerificationFailure(ws: string, input: RecordFailureInput): { proposed?: PolicyNote } {
  const key = normalize(input.criteria);
  // Read BEFORE appending so we can tell a genuinely-new failing run from a duplicate re-record.
  const prior = readLedger(ws).filter((r) => r.targetAgent === input.targetAgent && normalize(r.criteria) === key);
  const priorRunIds = new Set(prior.map((r) => r.runId));
  const isNew = !priorRunIds.has(input.runId);

  const rec: FailureRecord = {
    targetAgent: input.targetAgent,
    criteria: input.criteria,
    runId: input.runId,
    reasons: input.reasons ?? [],
    at: new Date().toISOString(),
  };
  const f = ledgerFile(ws);
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, JSON.stringify(rec) + "\n");

  // Fire ONLY when a new distinct failing run first pushes the pattern to the threshold. A duplicate
  // re-record (isNew=false) or a later failure (count already past the threshold) proposes nothing.
  const distinctAfter = priorRunIds.size + (isNew ? 1 : 0);
  if (!isNew || distinctAfter !== REPEAT_FAILURE_THRESHOLD) return {};

  // Deterministic proposal from the accumulated reasons — coaching's correction→policy shape, but the
  // reasons are already structured so no distiller (LLM) call is needed.
  const reasons = [...new Set([...prior, rec].flatMap((r) => r.reasons).filter(Boolean))];
  const draft = {
    when: `producing output as "${input.targetAgent}" for a delegated task that carries acceptance criteria`,
    do:
      `Your output has repeatedly failed acceptance verification (${distinctAfter} delegations for a similar contract). ` +
      `Before returning, make sure it satisfies the stated criteria` +
      (reasons.length ? ` — recurring gaps: ${reasons.join("; ")}.` : "."),
    scope: "agent" as const,
  };
  // toPolicy defaults status to "proposed" — leave it (coaching is approval-gated; run.ts applies only
  // APPROVED notes), so this is a captain-gated suggestion, never an active policy.
  const note: PolicyNote = toPolicy(draft, { agent: input.targetAgent, taughtBy: "verification", fromRun: input.runId });
  writePolicy(ws, note);
  return { proposed: note };
}
