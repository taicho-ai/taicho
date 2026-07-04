import { z } from "zod";

export const CoachingLedger = z.object({
  retrieved: z.array(z.string()),          // policy ids
  applied: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  knowledge: z.array(z.string()).default([]), // kb node ids injected into context (default keeps old traces parseable)
  skills: z.array(z.string()).default([]), // skill ids injected into context (default keeps old traces parseable)
});

/** An independent checker's judgement of a delegated output against its acceptance criteria. */
export const VerificationVerdict = z.object({
  pass: z.boolean(),
  reasons: z.array(z.string()).default([]),   // when pass=false, the unmet criteria; may be empty on pass
});
export type VerificationVerdict = z.infer<typeof VerificationVerdict>;

/** One criteria→verdict record for a delegation that carried acceptance criteria. A failed initial
 *  verdict followed by a retry yields two records (retried:false, then retried:true). */
export const VerificationRecord = z.object({
  criteria: z.string(),
  verdict: VerificationVerdict,
  runId: z.string(),                          // the child run whose output was checked
  retried: z.boolean().default(false),
  tokens: z.number().default(0),              // the checker call's own spend (advisory; not a hard budget)
  costUsd: z.number().nullable().default(0),
});
export type VerificationRecord = z.infer<typeof VerificationRecord>;

/** One file per run under runs/<agent>/. Written by agents, read by humans + coaching flow only. */
export const RunTrace = z.object({
  id: z.string(),                          // <agent>/<date>-run<n>
  agent: z.string(),
  task: z.string(),
  triggeredBy: z.string(),                 // "user" | run id of delegating run
  ledger: CoachingLedger,
  toolCalls: z.array(z.object({ tool: z.string(), count: z.number() })),
  artifacts: z.array(z.string()),
  delegatedOut: z.array(z.string()),       // run ids
  verification: z.array(VerificationRecord).default([]), // criteria→verdict records for this run's delegations (default keeps old traces parseable)
  outcome: z.enum(["completed", "blocked", "failed", "interrupted"]),
  tokens: z.number().default(0),
  costUsd: z.number().nullable().default(0),
  costNote: z.string().optional(),
  aggregate: z.object({ tokens: z.number(), costUsd: z.number().nullable() }).optional(),
  notes: z.array(z.string()).default([]),
  durationMs: z.number().default(0),
  started: z.string().datetime(),
});
export type RunTrace = z.infer<typeof RunTrace>;
