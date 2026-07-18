/** Plan 19: resolving `delegate_task(to: "news")` to the agent that will actually run.
 *
 *  A PURE function — no DB, no files, no model. The caller supplies the team, its members, and the
 *  chain of agents already above this delegation. Two shapes:
 *
 *    · a team with a LEAD routes to the lead, an ordinary agent that then delegates within its team.
 *      Costs one delegation level and one model call.
 *    · a team WITHOUT a lead is routed by the engine: the best-ranked member takes the goal directly.
 *      Costs neither. Leadless is the right default; a team that needs editorial judgment has a lead.
 *
 *  The routing decision is never silent. `why` is surfaced to the captain as a note breadcrumb and
 *  recorded on the trace, because rankAgents is a keyword match and will sometimes pick badly — a bad
 *  pick you can see is a bug report, a bad pick you can't is a mystery. */
import type { TeamDef } from "@taicho/contracts/team";
import { rankAgents } from "./discovery";

export interface RouteCandidate { id: string; role: string }
export interface TeamRouteOk { ok: true; agentId: string; why: string }
export interface TeamRouteErr { ok: false; error: string }
export type TeamRoute = TeamRouteOk | TeamRouteErr;

/** @param exclude agent ids already in this delegation chain (the caller and its ancestors). Routing
 *  to any of them would close a cycle, so they are never candidates. */
export function routeToTeam(team: TeamDef, members: RouteCandidate[], goal: string, exclude: string[]): TeamRoute {
  const blocked = new Set(exclude);

  if (team.lead) {
    // A lead may not address its own team: it would resolve straight back to itself. This is the one
    // self-loop the resolution creates that the generic cycle guard would report confusingly.
    if (blocked.has(team.lead))
      return {
        ok: false,
        error: `team "${team.id}" routes to its lead "${team.lead}", which is already in this delegation chain — a lead cannot address its own team`,
      };
    if (!members.some((m) => m.id === team.lead))
      return { ok: false, error: `team "${team.id}" names lead "${team.lead}", which is not a member of it` };
    return { ok: true, agentId: team.lead, why: "lead" };
  }

  const candidates = members.filter((m) => !blocked.has(m.id));
  if (!candidates.length)
    return {
      ok: false,
      error: members.length
        ? `team "${team.id}" has no member outside this delegation chain`
        : `team "${team.id}" has no members`,
    };

  // rankAgents skips is_root rows; a team member is never root, so 0 is the honest value here.
  const [best] = rankAgents(candidates.map((c) => ({ ...c, is_root: 0 })), goal, 1);
  // rankAgents returns nothing when no term overlaps. Fall back to the first candidate by id rather
  // than failing: an unranked pick is still a working delegation, and `why` says exactly what happened.
  if (!best) {
    const first = [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    return { ok: true, agentId: first.id, why: "no capability match; first member by id" };
  }
  return { ok: true, agentId: best.id, why: `ranked ${best.score} on capability` };
}
