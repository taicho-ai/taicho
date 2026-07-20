import type { Database } from "bun:sqlite";
import { effectiveTeams, type AgentDef } from "@taicho-ai/contracts/agent";
import { parseTeamAcl } from "@taicho-ai/contracts/team";

/** Roster is human-controlled: creation flows through the root agent's proposal card,
 *  never autonomous. Discovery is filtered by the CALLER's visibility ACL.
 *
 *  Plan 22: membership is many-to-many. The `registry` row keeps a denormalized PRIMARY team (the
 *  agent's first explicit team, for cheap display/model resolution), while `agent_teams` is the real
 *  membership index — one row per (agent, team), including the implicit `default` via effectiveTeams,
 *  so "who is on team X" and "which teams is agent Y on" are both one indexed query. Per-agent rows are
 *  replaced wholesale (delete-then-insert) so an edit that drops a team leaves no ghost membership. */
export function syncRegistry(db: Database, agents: AgentDef[]) {
  const insR = db.query("INSERT OR REPLACE INTO registry (id, role, is_root, team) VALUES (?, ?, ?, ?)");
  const delAT = db.query("DELETE FROM agent_teams WHERE agent_id = ?");
  const insAT = db.query("INSERT OR IGNORE INTO agent_teams (agent_id, team_id, ord) VALUES (?, ?, ?)");
  for (const a of agents) {
    insR.run(a.id, a.role, a.isRoot ? 1 : 0, a.teams[0] ?? null);
    delAT.run(a.id);
    effectiveTeams(a).forEach((t, i) => insAT.run(a.id, t, i));
  }
}

/** The ACL grammar (Plan 19). An entry is `"*"` (everyone), an exact agent id, or `team:<id>` — which
 *  matches every member of that team. Purely additive: no agent id may contain a colon, so an entry
 *  written before Plan 19 keeps exactly the meaning it had. Plan 22: a target now carries its full
 *  membership list (`teams`, which includes the implicit `default`), so a `team:<id>` entry matches when
 *  that id is anywhere in the list — an agent on several teams is reachable through any of them.
 *
 *  Note this is the grammar for BOTH canSee and canDelegateTo, and that `team:<id>` in canDelegateTo
 *  grants both "address the team" and "address any of its members". A team is a legibility boundary,
 *  not a security one — encapsulation comes from what root's roster SHOWS it (teams, not members),
 *  not from what it is forbidden. Narrow the ACL by hand if you want the hard version. */
function aclMatches(entry: string, target: { id: string; teams?: string[] }): boolean {
  if (entry === "*") return true;
  if (entry === target.id) return true;
  const team = parseTeamAcl(entry);
  return team !== null && !!target.teams?.includes(team);
}

export function acl(entries: string[], target: { id: string; teams?: string[] }): boolean {
  return entries.some((e) => aclMatches(e, target));
}

export function visibleTo(caller: AgentDef, all: AgentDef[]): { id: string; role: string }[] {
  return all
    .filter((a) => a.id !== caller.id)
    .filter((a) => acl(caller.canSee, { id: a.id, teams: effectiveTeams(a) }))
    .map((a) => ({ id: a.id, role: a.role }));
}

/** Visibility from the registry INDEX (id/role/teams only) — never loads agent identities, so the
 *  per-run cost stays O(1) file reads regardless of roster size. The caller is already loaded. */
export function visibleToRows(
  caller: AgentDef,
  rows: { id: string; role: string; teams?: string[] }[],
): { id: string; role: string; teams?: string[] }[] {
  return rows.filter((r) => r.id !== caller.id).filter((r) => acl(caller.canSee, r));
}

/** May `from` delegate to this target? The target may be an agent (pass its registry row so a
 *  `team:<id>` grant can match against its membership) or a team (pass `{ id: teamId, isTeam: true }`,
 *  matched by a `team:<id>` entry or `*`). */
export function canDelegate(from: AgentDef, to: { id: string; teams?: string[]; isTeam?: boolean }): boolean {
  if (to.isTeam) return from.canDelegateTo.some((e) => e === "*" || parseTeamAcl(e) === to.id);
  return acl(from.canDelegateTo, to);
}
