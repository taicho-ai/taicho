/** Plan 24: session message history + a ↑/↓ navigator. `idx` is an offset from the NEWEST entry: -1 means
 *  "on the live draft" (not in history yet), 0 = newest, list.length-1 = oldest. Stepping up the first
 *  time stashes the current draft so stepping all the way back down restores it (shell-style). Pure +
 *  deterministic. loadHistory/appendHistory persist across sessions in a per-workspace dot-file. */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { paths } from "../store/files";

export const HISTORY_CAP = 500;

export function pushHistory(list: string[], entry: string, cap = HISTORY_CAP): string[] {
  const e = entry.trim();
  if (!e) return list;
  if (list.length && list[list.length - 1] === e) return list; // ignore consecutive dupes
  const next = [...list, e];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export interface HistNav { idx: number; draft: string }
export const histStart = (): HistNav => ({ idx: -1, draft: "" });

/** Step to an OLDER entry. `current` is the buffer's current text (stashed as the draft on the first step). */
export function histPrev(nav: HistNav, list: string[], current: string): { nav: HistNav; value: string } | null {
  if (!list.length) return null;
  const draft = nav.idx === -1 ? current : nav.draft;
  const idx = Math.min(nav.idx + 1, list.length - 1);
  if (idx === nav.idx) return null; // already at the oldest
  return { nav: { idx, draft }, value: list[list.length - 1 - idx]! };
}

/** Step to a NEWER entry, or back to the stashed draft when leaving history. */
export function histNext(nav: HistNav, list: string[]): { nav: HistNav; value: string } | null {
  if (nav.idx === -1) return null; // already on the draft
  const idx = nav.idx - 1;
  if (idx === -1) return { nav: { idx: -1, draft: "" }, value: nav.draft };
  return { nav: { idx, draft: nav.draft }, value: list[list.length - 1 - idx]! };
}

// ── persistence (per-workspace dot-file; gitignored) ─────────────────────────────────────────────

export function loadHistory(ws: string): string[] {
  const f = paths.inputHistoryFile(ws);
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  for (const l of lines) if (out[out.length - 1] !== l) out.push(l); // collapse consecutive dupes
  return out.length > HISTORY_CAP ? out.slice(out.length - HISTORY_CAP) : out;
}

export function appendHistory(ws: string, entry: string): void {
  const e = entry.trim();
  if (!e) return;
  const cur = loadHistory(ws);
  if (cur[cur.length - 1] === e) return;
  appendFileSync(paths.inputHistoryFile(ws), e + "\n");
}
