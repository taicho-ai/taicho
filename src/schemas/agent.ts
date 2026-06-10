import { z } from "zod";

/** Agent identity — canonical form lives in agents/<id>/agent.md frontmatter. */
export const AgentDef = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  role: z.string(),                       // one-line capability description (shown in discovery)
  identity: z.string(),                   // body of agent.md — the SOUL
  tools: z.array(z.string()).default([]),
  canSee: z.array(z.string()).default(["*"]),        // org visibility ACL
  canDelegateTo: z.array(z.string()).default(["*"]),
  budgets: z.object({
    maxIterationsPerRun: z.number().int().positive().default(30),
    maxWorkItemsPerRequest: z.number().int().positive().default(20),
  }).prefault({}),
  isRoot: z.boolean().default(false),
  created: z.string().datetime(),
});
export type AgentDef = z.infer<typeof AgentDef>;
