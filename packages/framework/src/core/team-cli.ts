/** `taicho team <list|add|remove|member>` — manage teams from the command line (no Ink, no model).
 *  A captain-owned front door onto the same service layer the wizard and the approval-gated tool use.
 *  It opens the DB and reindexes first so membership queries see the current agent.md files.
 *
 *   list
 *   add <id> [--charter "…"] [--lead <agent>] [--member <agent>]…
 *   remove <id>
 *   member add|remove <agent> <team>
 *
 *  The parser is pure and unit-tested (parseTeamCli); runTeamCli performs the store side effects. */
import type { Database } from "bun:sqlite";
import { openDb } from "../store/db";
import { reindex, loadIndex } from "../store/roster";
import {
  listTeams, membersOf, teamExists, seedDefaultTeam,
  createTeamWithMembers, deleteTeam, setTeamMembers,
} from "../store/teams";
import { DEFAULT_TEAM_ID } from "@taicho-ai/contracts/team";

export type TeamCliCommand =
  | { kind: "list" }
  | { kind: "add"; id: string; charter: string; lead?: string; members: string[] }
  | { kind: "remove"; id: string }
  | { kind: "member"; op: "add" | "remove"; agent: string; team: string }
  | { kind: "error"; message: string };

/** Parse the tokens after `team` into a command. Tokens are already shell-split (they arrive as argv). */
export function parseTeamCli(tokens: string[]): TeamCliCommand {
  const sub = (tokens[0] ?? "list").toLowerCase();
  if (sub === "list" || sub === "ls") return { kind: "list" };

  if (sub === "add") {
    const id = tokens[1];
    if (!id) return { kind: "error", message: "usage: team add <id> [--charter \"…\"] [--lead <agent>] [--member <agent>]…" };
    let charter = "";
    let lead: string | undefined;
    const members: string[] = [];
    const rest = tokens.slice(2);
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === "--charter") charter = rest[++i] ?? "";
      else if (t === "--lead") lead = rest[++i];
      else if (t === "--member") { const m = rest[++i]; if (m) members.push(m); }
      else return { kind: "error", message: `unknown flag "${t}" (use --charter, --lead, --member)` };
    }
    return { kind: "add", id, charter: charter || id, lead, members };
  }

  if (sub === "remove" || sub === "rm") {
    const id = tokens[1];
    if (!id) return { kind: "error", message: "usage: team remove <id>" };
    return { kind: "remove", id };
  }

  if (sub === "member") {
    const op = (tokens[1] ?? "").toLowerCase();
    if (op !== "add" && op !== "remove") return { kind: "error", message: "usage: team member add|remove <agent> <team>" };
    const agent = tokens[2];
    const team = tokens[3];
    if (!agent || !team) return { kind: "error", message: "usage: team member add|remove <agent> <team>" };
    return { kind: "member", op, agent, team };
  }

  return { kind: "error", message: `unknown team subcommand "${sub}" (try list, add, remove, member)` };
}

export interface TeamCliDeps { ws: string; out?: (line: string) => void; }

function listOut(ws: string, db: Database, out: (l: string) => void): void {
  const teams = listTeams(ws);
  if (!teams.length) { out("  (no teams)"); return; }
  for (const t of teams) {
    const members = membersOf(db, t.id);
    const how = t.lead ? `lead: ${t.lead}` : "routed by capability";
    out(`  ${t.id}: ${t.charter}  ·  ${how}  ·  ${members.length} member${members.length === 1 ? "" : "s"}`);
  }
}

/** Execute a `taicho team …` command against the workspace. Returns `{ ok }` for the exit code. */
export async function runTeamCli(deps: TeamCliDeps, tokens: string[]): Promise<{ ok: boolean }> {
  const out = deps.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const cmd = parseTeamCli(tokens);
  if (cmd.kind === "error") { out(`taicho: ${cmd.message}`); return { ok: false }; }

  const db = openDb(deps.ws);
  await reindex(deps.ws, db);   // membership queries read the derived index; keep it fresh
  seedDefaultTeam(deps.ws);

  try {
    if (cmd.kind === "list") { listOut(deps.ws, db, out); return { ok: true }; }

    if (cmd.kind === "add") {
      if (teamExists(deps.ws, cmd.id)) { out(`taicho: team "${cmd.id}" already exists`); return { ok: false }; }
      const team = await createTeamWithMembers(deps.ws, db, { id: cmd.id, charter: cmd.charter, lead: cmd.lead }, cmd.members);
      out(`  ✓ created team ${team.id}${team.lead ? ` (lead: ${team.lead})` : ""} with ${cmd.members.length} member${cmd.members.length === 1 ? "" : "s"}`);
      return { ok: true };
    }

    if (cmd.kind === "remove") {
      const detached = await deleteTeam(deps.ws, db, cmd.id);
      out(`  ✓ removed team ${cmd.id} — detached ${detached.length} member${detached.length === 1 ? "" : "s"}`);
      return { ok: true };
    }

    // member add|remove <agent> <team>
    if (cmd.team === DEFAULT_TEAM_ID) { out("taicho: every agent is always a member of the default team"); return { ok: false }; }
    if (!teamExists(deps.ws, cmd.team)) { out(`taicho: no team "${cmd.team}"`); return { ok: false }; }
    if (cmd.op === "add" && !loadIndex(db).some((r) => r.id === cmd.agent)) { out(`taicho: no agent "${cmd.agent}"`); return { ok: false }; }
    const current = new Set(membersOf(db, cmd.team).map((m) => m.id));
    if (cmd.op === "add") current.add(cmd.agent); else current.delete(cmd.agent);
    await setTeamMembers(deps.ws, db, cmd.team, [...current]);
    out(`  ✓ ${cmd.op === "add" ? "added" : "removed"} ${cmd.agent} ${cmd.op === "add" ? "to" : "from"} ${cmd.team}`);
    return { ok: true };
  } catch (e) {
    out(`taicho: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false };
  }
}
