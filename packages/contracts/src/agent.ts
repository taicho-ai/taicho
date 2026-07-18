import { z } from "zod";
import { DEFAULT_TEAM_ID } from "./team";

/** Agent identity — canonical form lives in agents/<id>/agent.md frontmatter. */
const AgentObject = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  role: z.string(),                       // one-line capability description (shown in discovery)
  identity: z.string(),                   // body of agent.md — the SOUL
  // Capability allowlist. Built-in tool names (e.g. "delegate_task", "run_command") grant those
  // tools. MCP capabilities are opt-in the SAME way (Plan 08 security hardening): "mcp:<server>"
  // grants every tool that connected server exposes; "mcp:<server>/<tool>" grants exactly one.
  // Anything NOT listed is not exposed to the agent — MCP tools included (no blanket grant).
  tools: z.array(z.string()).default([]),
  // Plan 22: the teams this agent sits on (was a single `team`). An agent may belong to MANY teams and
  // declares them HERE — its own frontmatter is the single source of truth for membership, so
  // teams/<id>/team.md deliberately carries no member list. This holds only EXPLICIT memberships: the
  // universal `default` team is implicit (every agent belongs; the derived index adds it), so an empty
  // list ⇒ default-only. A pre-Plan-22 `team: news` is migrated to `teams: [news]` at parse (below).
  teams: z.array(z.string()).default([]),
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

/** Parse an agent, migrating the legacy single `team: <id>` into `teams: [<id>]` so a pre-Plan-22
 *  agent.md still loads (files are canon; boot reindex then re-serializes it in the new shape). */
export const AgentDef = z.preprocess((raw) => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (o.teams === undefined && "team" in o)
      o.teams = o.team == null || o.team === "" ? [] : [o.team];
    if ("team" in o) delete o.team;
  }
  return raw;
}, AgentObject);
export type AgentDef = z.infer<typeof AgentDef>;

/** An agent's EFFECTIVE membership: the universal `default` team plus its explicit teams, deduped, with
 *  default FIRST. This is what the ACL matches against and what the derived agent_teams index stores, so
 *  `team:default` matches everyone and membersOf("default") is the whole squad. Kept out of the file —
 *  agent.md lists only explicit teams — so a squad with no explicit teams looks byte-identical to before. */
export function effectiveTeams(agent: { teams: string[] }): string[] {
  const out = [DEFAULT_TEAM_ID];
  for (const t of agent.teams) if (t !== DEFAULT_TEAM_ID && !out.includes(t)) out.push(t);
  return out;
}
