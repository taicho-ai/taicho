import { z } from "zod";

export const CoachingLedger = z.object({
  retrieved: z.array(z.string()),          // policy ids
  applied: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  knowledge: z.array(z.string()).default([]), // kb node ids injected into context (default keeps old traces parseable)
  skills: z.array(z.string()).default([]), // skill ids injected into context (default keeps old traces parseable)
});

/** One file per run under runs/<agent>/. Written by agents, read by humans + coaching flow only. */
export const RunTrace = z.object({
  id: z.string(),                          // <agent>/<date>-run<n>
  agent: z.string(),
  task: z.string(),
  triggeredBy: z.string(),                 // "user" | run id of delegating run
  ledger: CoachingLedger,
  toolCalls: z.array(z.object({ tool: z.string(), count: z.number() })),
  artifacts: z.array(z.string()),          // artifact references (handles/paths) THIS run produced
  // Hand-off graph (parent-side, mirrors delegatedOut): what flowed across this run's delegation
  // edges. inputArtifacts = handles handed DOWN to children; outputArtifacts = handles received UP.
  // Defaults keep pre-Plan-01 traces parseable.
  inputArtifacts: z.array(z.string()).default([]),
  outputArtifacts: z.array(z.string()).default([]),
  delegatedOut: z.array(z.string()),       // run ids
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
