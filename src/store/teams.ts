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
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { TeamDef } from "../schemas/team";
import { paths } from "./files";
import { DEFAULT_WORKER_TOOLS } from "./roster";
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

export interface TeamMember { id: string; role: string }

/** A team's roster, derived from the registry's `team` column — the single source of truth for
 *  membership. Ordered by id so routing and rendering are deterministic. */
export function membersOf(db: Database, teamId: string): TeamMember[] {
  return db
    .query<TeamMember, [string]>("SELECT id, role FROM registry WHERE team = ? ORDER BY id")
    .all(teamId);
}

export interface TeamProblem { team: string; problem: string }

/** Boot validation. A `lead` that is not an agent, or is an agent sitting on a DIFFERENT team, is an
 *  inconsistency the captain must see — a lead who isn't on the team it leads would route work out of
 *  the team silently. Report rather than throw: one bad team must not block boot, and the captain can
 *  fix the file and restart. Returns the problems found (for a boot notice). */
export function validateTeams(ws: string, db: Database): TeamProblem[] {
  const problems: TeamProblem[] = [];
  for (const team of listTeams(ws)) {
    if (!team.lead) continue;
    const row = db.query<{ team: string | null }, [string]>("SELECT team FROM registry WHERE id = ?").get(team.lead);
    if (!row) problems.push({ team: team.id, problem: `lead "${team.lead}" is not an agent` });
    else if (row.team !== team.id)
      problems.push({
        team: team.id,
        problem: `lead "${team.lead}" declares team ${row.team ? `"${row.team}"` : "(none)"} — it must declare "${team.id}"`,
      });
  }
  return problems;
}
