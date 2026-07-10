import { z } from "zod";

/** Agent identity — canonical form lives in agents/<id>/agent.md frontmatter. */
export const AgentDef = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  role: z.string(),                       // one-line capability description (shown in discovery)
  identity: z.string(),                   // body of agent.md — the SOUL
  // Capability allowlist. Built-in tool names (e.g. "delegate_task", "run_command") grant those
  // tools. MCP capabilities are opt-in the SAME way (Plan 08 security hardening): "mcp:<server>"
  // grants every tool that connected server exposes; "mcp:<server>/<tool>" grants exactly one.
  // Anything NOT listed is not exposed to the agent — MCP tools included (no blanket grant).
  tools: z.array(z.string()).default([]),
  // Plan 19: the team this agent sits on. An agent sits on ONE team, and declares it HERE — this is the
  // single source of truth for membership, so teams/<id>/team.md deliberately carries no member list.
  // Absent ⇒ unaffiliated (root, librarian, a floating specialist addressed by id).
  team: z.string().optional(),
  // Visibility + delegation ACLs. Each entry is "*", an exact agent id, or (Plan 19) "team:<id>",
  // which matches every member of that team. Additive: no existing agent id contains a colon.
  canSee: z.array(z.string()).default(["*"]),        // org visibility ACL
  canDelegateTo: z.array(z.string()).default(["*"]),
  budgets: z.object({
    maxIterationsPerRun: z.number().int().positive().default(30),
    maxWorkItemsPerRequest: z.number().int().positive().default(20),
    maxTokensPerRun: z.number().int().positive().optional(),
    maxCostPerRunUsd: z.number().positive().optional(),
    // Plan 04 Phase 3: how many background tasks this agent may have RUNNING at once (config
    // disposes the concurrency the model proposes via dispatch_task). Undefined ⇒ unbounded;
    // extra dispatches sit in the persistent queue (status "queued") until a slot frees.
    maxConcurrentRuns: z.number().int().positive().optional(),
  }).prefault({}),
  isRoot: z.boolean().default(false),
  created: z.string().datetime(),
});
export type AgentDef = z.infer<typeof AgentDef>;
