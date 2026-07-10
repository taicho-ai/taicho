import type { Database } from "bun:sqlite";
import type { AgentDef } from "../schemas/agent";
import { parseTeamAcl } from "../schemas/team";

/** Roster is human-controlled: creation flows through the root agent's proposal card,
 *  never autonomous. Discovery is filtered by the CALLER's visibility ACL. */
export function syncRegistry(db: Database, agents: AgentDef[]) {
  const ins = db.query("INSERT OR REPLACE INTO registry (id, role, is_root, team) VALUES (?, ?, ?, ?)");
  for (const a of agents) ins.run(a.id, a.role, a.isRoot ? 1 : 0, a.team ?? null);
}

/** The ACL grammar (Plan 19). An entry is `"*"` (everyone), an exact agent id, or `team:<id>` — which
 *  matches every member of that team. Purely additive: no agent id may contain a colon, so an entry
 *  written before Plan 19 keeps exactly the meaning it had.
 *
 *  Note this is the grammar for BOTH canSee and canDelegateTo, and that `team:<id>` in canDelegateTo
 *  grants both "address the team" and "address any of its members". A team is a legibility boundary,
 *  not a security one — encapsulation comes from what root's roster SHOWS it (teams, not members),
 *  not from what it is forbidden. Narrow the ACL by hand if you want the hard version. */
function aclMatches(entry: string, target: { id: string; team?: string | null }): boolean {
  if (entry === "*") return true;
  if (entry === target.id) return true;
  const team = parseTeamAcl(entry);
  return team !== null && !!target.team && target.team === team;
}

export function acl(entries: string[], target: { id: string; team?: string | null }): boolean {
  return entries.some((e) => aclMatches(e, target));
}

export function visibleTo(caller: AgentDef, all: AgentDef[]): { id: string; role: string }[] {
  return all
    .filter((a) => a.id !== caller.id)
    .filter((a) => acl(caller.canSee, a))
    .map((a) => ({ id: a.id, role: a.role }));
}

/** Visibility from the registry INDEX (id/role/team only) — never loads agent identities, so the
 *  per-run cost stays O(1) file reads regardless of roster size. The caller is already loaded. */
export function visibleToRows(
  caller: AgentDef,
  rows: { id: string; role: string; team?: string | null }[],
): { id: string; role: string; team?: string | null }[] {
  return rows.filter((r) => r.id !== caller.id).filter((r) => acl(caller.canSee, r));
}

/** May `from` delegate to this target? The target may be an agent (pass its registry row so a
 *  `team:<id>` grant can match) or a team (pass `{ id: teamId, isTeam: true }`, matched by a
 *  `team:<id>` entry or `*`). */
export function canDelegate(from: AgentDef, to: { id: string; team?: string | null; isTeam?: boolean }): boolean {
  if (to.isTeam) return from.canDelegateTo.some((e) => e === "*" || parseTeamAcl(e) === to.id);
  return acl(from.canDelegateTo, to);
}
