/** Per-agent conversation thread, append-only JSONL at agents/<id>/thread.jsonl.
 *  Used to persist + resume the root conversation across launches. Tolerant of corrupt lines. */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { paths } from "./files";

function threadFile(ws: string, agentId: string): string {
  return join(paths.agentDir(ws, agentId), "thread.jsonl");
}

// Must match SUMMARY_MARKER in core/conversation-replay.ts — the first line of a COMPACTED replay cache
// is a pinned `[CONVERSATION COMPACTION]` summary of the folded (older) turns (Plan 05 Ph3). Defined
// locally (not imported) to avoid a thread ⇄ conversation-replay import cycle.
const COMPACTION_HEAD_MARKER = "[CONVERSATION COMPACTION]";

/** Is this raw JSONL line the pinned compaction-summary head? (a `user` message whose text opens with
 *  the marker) — used so truncation never drops the folded-history summary. */
function isCompactionHead(line: string): boolean {
  try {
    const m = JSON.parse(line) as ModelMessage;
    return m.role === "user" && typeof m.content === "string" && m.content.startsWith(COMPACTION_HEAD_MARKER);
  } catch { return false; }
}

export function loadThread(ws: string, agentId: string, maxTurns = 40): ModelMessage[] {
  const f = threadFile(ws, agentId);
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "");
  // The DERIVED replay cache leads with a pinned `[CONVERSATION COMPACTION]` summary head (Plan 05 Ph3)
  // whenever older turns were folded. A naive tail-slice (`slice(-maxTurns)`) would DROP that head for a
  // large replayKeepTurns — silently losing the entire folded-history summary and defeating cross-turn
  // compaction. PIN the head and truncate from the tail's older end instead.
  let head: string[] = [];
  let rest = lines;
  if (lines.length && isCompactionHead(lines[0])) { head = [lines[0]!]; rest = lines.slice(1); }
  const budget = Math.max(0, maxTurns - head.length);
  const kept = budget === 0 ? [] : rest.slice(-budget); // guard: slice(-0) would return the WHOLE array
  const out: ModelMessage[] = [];
  for (const l of [...head, ...kept]) {
    try { out.push(JSON.parse(l) as ModelMessage); } catch { /* skip corrupt line */ }
  }
  return out;
}

/** Overwrite thread.jsonl with an exact message list. thread.jsonl is a DERIVED boot-replay cache
 *  (the ledger is the append-only truth), so it is REBUILT — not appended — each time a completed
 *  turn is recorded through the audit seam. Plan 05 Ph3 writes the compacted replay (rolling summary
 *  + recent-K tail) here, so this replaces the old completed-only append. */
export function writeThread(ws: string, agentId: string, messages: ModelMessage[]): void {
  mkdirSync(paths.agentDir(ws, agentId), { recursive: true });
  const body = messages.map((m) => JSON.stringify(m)).join("\n");
  writeFileSync(threadFile(ws, agentId), body ? body + "\n" : "");
}

export function clearThread(ws: string, agentId: string): void {
  const f = threadFile(ws, agentId);
  if (existsSync(f)) writeFileSync(f, "");
}
