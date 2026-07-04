/** Per-agent conversation thread, append-only JSONL at agents/<id>/thread.jsonl.
 *  Used to persist + resume the root conversation across launches. Tolerant of corrupt lines. */
import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { paths } from "./files";

function threadFile(ws: string, agentId: string): string {
  return join(paths.agentDir(ws, agentId), "thread.jsonl");
}

export function appendTurn(ws: string, agentId: string, msg: ModelMessage): void {
  mkdirSync(paths.agentDir(ws, agentId), { recursive: true });
  appendFileSync(threadFile(ws, agentId), JSON.stringify(msg) + "\n");
}

export function loadThread(ws: string, agentId: string, maxTurns = 40): ModelMessage[] {
  const f = threadFile(ws, agentId);
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "");
  const out: ModelMessage[] = [];
  for (const l of lines.slice(-maxTurns)) {
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

export const shouldPersistTurn = (outcome: string): boolean => outcome === "completed";
