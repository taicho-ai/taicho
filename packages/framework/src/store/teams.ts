/** Plan 19: team store. teams/<id>/team.md is canon — YAML frontmatter + a markdown charter body,
 *  exactly like agents/<id>/agent.md.
 *
 *  There is NO teams table. A squad has a handful of teams, so a directory scan IS the whole query
 *  surface (the same call made for schedules.ts). Membership lives on the AGENT — `team: <id>` in
 *  agent.md — and is queried through the registry's `team` column, which is where the index earns its
 *  keep. Nothing about a team is stored in two places.
 *
 *  Teams are captain-owned: created by `taicho team add` / `/teams`, never by a model. A team grants
 *  capability to its members (TeamTools.grant), so a model that could mint teams could escalate its own
 *  privileges. This is why there is no create_team tool, and why grant may name privileged tools. */
import { YAML } from "bun";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { TeamDef, DEFAULT_TEAM_ID } from "@taicho-ai/contracts/team";
import { paths } from "./files";
import { DEFAULT_WORKER_TOOLS, loadAgent, setAgentTeams } from "./roster";
import { log } from "../core/logger";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function serializeTeam(t: TeamDef): string {
  const { charterBody, ...meta } = t;
  return `---\n${YAML.stringify(meta, null, 2)}\n---\n${charterBody}\n`;
}

export function parseTeam(text: string): TeamDef {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("team.md is missing YAML frontmatter");
  const meta = YAML.parse(m[1]) as Record<string, unknown>;
  const team = TeamDef.parse({ ...meta, charterBody: m[2].trim() });
  assertPolicyRespectsFloor(team);
  return team;
}

/** Plan 14's floor is not a team's to punch through. A worker must ALWAYS be able to produce an artifact
 *  and hand it off by reference; a team that denies `write_artifact` would mint exactly the toolless
 *  worker `reconcileWorkerTools` exists to rescue. Reject at LOAD, naming the offending tool — a silent
 *  drop here would be invisible until a member failed to save its work. */
export function assertPolicyRespectsFloor(team: TeamDef): void {
  const punched = team.tools.deny.filter((t) => DEFAULT_WORKER_TOOLS.includes(t));
  if (punched.length)
    throw new Error(
      `team "${team.id}" denies ${punched.join(", ")}, which every worker must keep ` +
        `(the artifact baseline: ${DEFAULT_WORKER_TOOLS.join(", ")}). Remove it from tools.deny.`,
    );
}

export function teamExists(ws: string, id: string): boolean {
  return existsSync(paths.teamFile(ws, id));
}

export function loadTeam(ws: string, id: string): TeamDef | null {
  const file = paths.teamFile(ws, id);
  if (!existsSync(file)) return null;
  return parseTeam(readFileSync(file, "utf8"));
}

/** Every team on the squad. A bad team.md is SKIPPED with a warning rather than killing boot — one
 *  malformed file must not take the whole squad down. */
export function listTeams(ws: string): TeamDef[] {
  const dir = paths.teamsDir(ws);
  if (!existsSync(dir)) return [];
  const out: TeamDef[] = [];
  for (const id of readdirSync(dir)) {
    const file = paths.teamFile(ws, id);
    if (!existsSync(file)) continue;
    try { out.push(parseTeam(readFileSync(file, "utf8"))); }
    catch (e) { log.warn(`skipping team ${id}`, e); }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function writeTeam(ws: string, team: TeamDef): void {
  assertPolicyRespectsFloor(team);
  mkdirSync(paths.teamDir(ws, team.id), { recursive: true });
  writeFileSync(paths.teamFile(ws, team.id), serializeTeam(team));
}

export interface NewTeamDraft {
  id: string;
  charter: string;
  lead?: string;
  tools?: { grant?: string[]; deny?: string[] };
  charterBody?: string;
}

/** Agent ids and team ids share ONE namespace, so `delegate_task(to: "news")` is never ambiguous and
 *  needs no prefix at the call site. The mirror-image guard lives in roster.createAgent, which checks
 *  paths.teamFile directly rather than importing this module — teams.ts already depends on roster.ts
 *  for DEFAULT_WORKER_TOOLS, and a cycle here would be gratuitous. */
export function assertTeamIdFree(ws: string, id: string): void {
  if (existsSync(paths.agentFile(ws, id)))
    throw new Error(`cannot create team "${id}": an agent already has that id (ids are one namespace)`);
}

export function createTeam(ws: string, draft: NewTeamDraft): TeamDef {
  if (teamExists(ws, draft.id)) throw new Error(`team "${draft.id}" already exists`);
  assertTeamIdFree(ws, draft.id);
  const team = TeamDef.parse({
    id: draft.id,
    charter: draft.charter,
    lead: draft.lead,
    tools: draft.tools ?? {},
    charterBody: draft.charterBody ?? "",
    created: new Date().toISOString(),
  });
  writeTeam(ws, team);
  return team;
}

/** Plan 22: seed the universal `default` team if it does not exist. Every agent belongs to it (the
 *  membership is implicit — effectiveTeams adds it — so no agent.md is touched), root leads it, and it
 *  cannot be deleted (deleteTeam guards the id). Idempotent: a squad that already has the file, or one a
 *  captain has customised, is left alone. Runs on boot next to seedRoot. */
export function seedDefaultTeam(ws: string): void {
  if (teamExists(ws, DEFAULT_TEAM_ID)) return;
  const team = TeamDef.parse({
    id: DEFAULT_TEAM_ID,
    charter: "Everyone on the squad.",
    lead: "root",
    tools: {},
    charterBody:
      "The whole squad. Every agent belongs to this team and it cannot be deleted. " +
      "Form a focused team to address a subset of the squad by capability.",
    created: new Date().toISOString(),
  });
  writeTeam(ws, team);
}

export interface TeamPatch { charter?: string; lead?: string | null; tools?: { grant?: string[]; deny?: string[] }; charterBody?: string; }

/** Edit an existing team's charter, lead, tool policy, or body (the captain's `e`/`l`/`p` verbs, the
 *  CLI, the approval-gated tool). Re-parses through TeamDef and re-asserts the DEFAULT_WORKER_TOOLS
 *  floor on write. `lead: null` clears the lead (back to leadless routing). The id is immutable. */
export function updateTeam(ws: string, id: string, patch: TeamPatch): TeamDef {
  const cur = loadTeam(ws, id);
  if (!cur) throw new Error(`no team "${id}"`);
  const next = TeamDef.parse({
    ...cur,
    charter: patch.charter ?? cur.charter,
    lead: patch.lead === null ? undefined : (patch.lead ?? cur.lead),
    tools: patch.tools ?? cur.tools,
    charterBody: patch.charterBody ?? cur.charterBody,
  });
  writeTeam(ws, next);
  return next;
}

/** Delete a team (the `d` verb / CLI). The default team is protected — every agent belongs to it. Strips
 *  the team from every member's own `teams:` frontmatter (membership is canon on the agent), then removes
 *  the team files. Returns the members it detached, for a confirmation line. */
export async function deleteTeam(ws: string, db: Database, id: string): Promise<string[]> {
  if (id === DEFAULT_TEAM_ID) throw new Error("the default team cannot be deleted — every agent belongs to it");
  if (!teamExists(ws, id)) throw new Error(`no team "${id}"`);
  const members = membersOf(db, id).map((m) => m.id);
  for (const m of members) {
    const agent = await loadAgent(ws, m);
    if (agent.teams.includes(id)) await setAgentTeams(ws, db, m, agent.teams.filter((t) => t !== id));
  }
  rmSync(paths.teamDir(ws, id), { recursive: true, force: true });
  return members;
}

/** Make a team's membership EXACTLY `memberIds` (the wizard's member picker and the `m` verb). Adds the
 *  team to newly-selected agents and removes it from de-selected ones — membership is edited on each
 *  AGENT, the one source of truth. The default team is not settable: everyone is always a member. */
export async function setTeamMembers(ws: string, db: Database, teamId: string, memberIds: string[]): Promise<void> {
  if (teamId === DEFAULT_TEAM_ID) throw new Error("every agent is always a member of the default team");
  if (!teamExists(ws, teamId)) throw new Error(`no team "${teamId}"`);
  const current = new Set(membersOf(db, teamId).map((m) => m.id));
  const desired = new Set(memberIds);
  for (const m of desired)
    if (!current.has(m)) {
      const agent = await loadAgent(ws, m); // throws if the id is not an agent
      if (!agent.teams.includes(teamId)) await setAgentTeams(ws, db, m, [...agent.teams, teamId]);
    }
  for (const m of current)
    if (!desired.has(m)) {
      const agent = await loadAgent(ws, m);
      await setAgentTeams(ws, db, m, agent.teams.filter((t) => t !== teamId));
    }
}

/** Create a team AND staff it in one call (the Add wizard, the CLI, the approval-gated tool). The team
 *  file is written first so setTeamMembers' existence check passes. */
export async function createTeamWithMembers(ws: string, db: Database, draft: NewTeamDraft, memberIds: string[]): Promise<TeamDef> {
  const team = createTeam(ws, draft);
  await setTeamMembers(ws, db, team.id, memberIds);
  return team;
}

export interface TeamMember { id: string; role: string }

/** A team's roster, derived from the `agent_teams` join (Plan 22) — the many-to-many membership index,
 *  itself derived from each agent's own `teams:` frontmatter. Ordered by id so routing and rendering are
 *  deterministic. membersOf(DEFAULT_TEAM_ID) returns the whole squad, since every agent carries the
 *  implicit default membership. */
export function membersOf(db: Database, teamId: string): TeamMember[] {
  return db
    .query<TeamMember, [string]>(
      "SELECT r.id, r.role FROM agent_teams at JOIN registry r ON r.id = at.agent_id WHERE at.team_id = ? ORDER BY r.id",
    )
    .all(teamId);
}

export interface TeamProblem { team: string; problem: string }

/** Boot validation. A `lead` that is not an agent, or is an agent sitting on a DIFFERENT team, is an
 *  inconsistency the captain must see — a lead who isn't on the team it leads would route work out of
 *  the team silently. Report rather than throw: one bad team must not block boot, and the captain can
 *  fix the file and restart. Returns the problems found (for a boot notice). */
export function validateTeams(ws: string, db: Database): TeamProblem[] {
  const problems: TeamProblem[] = [];
  const isAgent = db.query<{ id: string }, [string]>("SELECT id FROM registry WHERE id = ?");
  const isMember = db.query<{ agent_id: string }, [string, string]>("SELECT agent_id FROM agent_teams WHERE agent_id = ? AND team_id = ?");
  for (const team of listTeams(ws)) {
    if (!team.lead) continue;
    // Plan 22: a lead must be an agent AND a member of the team it leads (membership is many-to-many, so
    // "is a member" is a join lookup, not a single-column compare). A lead who isn't on the team routes
    // its work out of the team — the inconsistency this reports so the captain can fix the file.
    if (!isAgent.get(team.lead)) problems.push({ team: team.id, problem: `lead "${team.lead}" is not an agent` });
    else if (!isMember.get(team.lead, team.id))
      problems.push({ team: team.id, problem: `lead "${team.lead}" is not a member of the team it leads — add "${team.id}" to its teams` });
  }
  return problems;
}
