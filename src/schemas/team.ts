import { z } from "zod";

/** A team's tool policy, applied in toolsForAgent to every member.
 *  `grant` ADDS to a member's own toolset; `deny` REMOVES from it and wins over the member's own grant.
 *  A `deny` list that intersects DEFAULT_WORKER_TOOLS is rejected when the team loads (store/teams.ts):
 *  Plan 14's capability FLOOR — a worker can always produce and hand off an artifact — is not a team's
 *  to punch through. `grant` may name privileged tools; that is safe precisely because teams are
 *  captain-authored files and there is deliberately no create_team tool. */
export const TeamTools = z
  .object({
    grant: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  })
  .prefault({});
export type TeamTools = z.infer<typeof TeamTools>;

/** Plan 19: a team is a functional group within the squad — news, trading, programming.
 *
 *  Canonical form is teams/<id>/team.md: YAML frontmatter (this schema minus `charterBody`) plus a
 *  markdown body that becomes the team's standing instruction, injected into every member's system
 *  prompt as a context-tier section. Mirrors agents/<id>/agent.md exactly.
 *
 *  MEMBERSHIP IS NOT HERE. An agent declares `team: <id>` in its own frontmatter — one source of truth —
 *  and a team's roster is derived by grouping the registry. Listing members here too would let the two
 *  drift. `lead` names an agent that must itself declare this team; a mismatch is a boot error. */
export const TeamDef = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** One line, shown in root's roster in place of the members it stands for. */
  charter: z.string(),
  /** Optional. Present ⇒ delegate_task(to:"<id>") routes to this agent, which then delegates within
   *  its team; it costs one delegation level and one model call. Absent ⇒ the engine routes to the
   *  best-ranked member directly, for free. Leadless is the right default. */
  lead: z.string().optional(),
  tools: TeamTools,
  /** Body of team.md — the team's standing instruction. Culture is configuration. */
  charterBody: z.string().default(""),
  created: z.string().datetime(),
});
export type TeamDef = z.infer<typeof TeamDef>;

/** The ACL grammar's team production (core/registry.ts). An entry in canSee/canDelegateTo is `"*"`,
 *  an exact agent id, or `team:<id>`. No existing id contains a colon, so this is purely additive. */
export const TEAM_ACL_PREFIX = "team:";

export const teamAclEntry = (teamId: string): string => `${TEAM_ACL_PREFIX}${teamId}`;

/** The team named by an ACL entry, or null when the entry is `"*"` or an exact agent id. */
export function parseTeamAcl(entry: string): string | null {
  return entry.startsWith(TEAM_ACL_PREFIX) ? entry.slice(TEAM_ACL_PREFIX.length) : null;
}
