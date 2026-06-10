import type { Database } from "bun:sqlite";
import type { AgentDef } from "../schemas/agent";

/** Roster is human-controlled: creation flows through the root agent's proposal card,
 *  never autonomous. Discovery is filtered by the CALLER's visibility ACL. */
export function syncRegistry(db: Database, agents: AgentDef[]) {
  const ins = db.query("INSERT OR REPLACE INTO registry (id, role, is_root) VALUES (?, ?, ?)");
  for (const a of agents) ins.run(a.id, a.role, a.isRoot ? 1 : 0);
}

export function visibleTo(caller: AgentDef, all: AgentDef[]): { id: string; role: string }[] {
  return all
    .filter((a) => a.id !== caller.id)
    .filter((a) => caller.canSee.includes("*") || caller.canSee.includes(a.id))
    .map((a) => ({ id: a.id, role: a.role }));
}

/** Visibility from the registry INDEX (id/role only) — never loads agent identities, so the
 *  per-run cost stays O(1) file reads regardless of roster size. The caller is already loaded. */
export function visibleToRows(
  caller: AgentDef,
  rows: { id: string; role: string }[],
): { id: string; role: string }[] {
  return rows
    .filter((r) => r.id !== caller.id)
    .filter((r) => caller.canSee.includes("*") || caller.canSee.includes(r.id))
    .map((r) => ({ id: r.id, role: r.role }));
}

export function canDelegate(from: AgentDef, toId: string): boolean {
  return from.canDelegateTo.includes("*") || from.canDelegateTo.includes(toId);
}
