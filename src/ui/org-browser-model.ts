/** Plan 22 — the Org browser's PURE model: the rows each scope renders, and the small guards the UI
 *  needs. No Ink, no state — everything here reads the store (like browser-model.ts) and is unit-testable
 *  with a seeded workspace. OrgBrowser.tsx renders what this returns. */
import type { Database } from "bun:sqlite";
import { listTeams, membersOf } from "../store/teams";
import { loadIndex } from "../store/roster";
import { DEFAULT_TEAM_ID } from "../schemas/team";

export type OrgScope = "teams" | "agents";

export interface TeamRow { id: string; charter: string; lead?: string; members: string[]; }
export interface AgentRow { id: string; role: string; isRoot: boolean; teams: string[]; }

/** Every team, with its members resolved from the join. The default team is included — it IS the squad,
 *  and the Org browser is where the captain sees the whole org (unlike the terse /agents list). */
export function teamRows(ws: string, db: Database): TeamRow[] {
  return listTeams(ws).map((t) => ({ id: t.id, charter: t.charter, lead: t.lead, members: membersOf(db, t.id).map((m) => m.id) }));
}

/** Every agent, with its EXPLICIT teams (default dropped — every agent is on it, so it carries no signal
 *  in a per-row list). Sorted by id, root first is NOT forced — id order keeps navigation deterministic. */
export function agentRows(db: Database): AgentRow[] {
  return loadIndex(db)
    .map((r) => ({ id: r.id, role: r.role, isRoot: !!r.is_root, teams: (r.teams ?? []).filter((t) => t !== DEFAULT_TEAM_ID) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Root and the librarian are the squad's fixtures — they cannot be retired (deleteAgent enforces it too;
 *  this is the UI-side guard that greys the verb). */
export function isProtectedAgent(id: string): boolean {
  return id === "root" || id === "librarian";
}

/** The default team cannot be deleted or have its membership set — everyone belongs to it. */
export function isProtectedTeam(id: string): boolean {
  return id === DEFAULT_TEAM_ID;
}

/** Wrap a selection index into [0, len) — shared by every list/cursor in the browser. */
export function clampSel(sel: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(sel, len - 1));
}
