/** Durable conversation evidence lives separately from prompt context.
 *  ledger.jsonl is append-only audit history; context.json says which turns are safe to replay. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./files";
import { clearThread } from "./thread";

export type LedgerStatus = "submitted" | "completed" | "failed" | "blocked" | "interrupted";

export interface ConversationLedgerTurn {
  turnId: string;
  runId: string;
  timestamp: string;
  agent: string;
  role: "user" | "assistant" | "system";
  content: unknown;
  status: LedgerStatus;
  parentRunId?: string;
  /** Plan 01 Ph5: artifact HANDLES (id@vN) this turn produced. Carried by REFERENCE into replay —
   *  the replay cache resolves each to its summary (never the body); the ledger just records the ids. */
  artifacts?: string[];
}

export interface ContextDecision {
  turnId: string;
  runId: string;
  reason?: string;
}

export interface ConversationContext {
  agent: string;
  includedTurns: ContextDecision[];
  excludedTurns: ContextDecision[];
}

export function newTurnId(agent: string, runId: string, role: string): string {
  return `${agent}_${runId.slice(runId.indexOf("/") + 1)}_${role}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ledgerFile(ws: string, agent: string): string {
  return join(paths.conversationDir(ws, agent), "ledger.jsonl");
}

function contextFile(ws: string, agent: string): string {
  return join(paths.conversationDir(ws, agent), "context.json");
}

export function appendLedgerTurn(ws: string, agent: string, turn: ConversationLedgerTurn): void {
  mkdirSync(paths.conversationDir(ws, agent), { recursive: true });
  appendFileSync(ledgerFile(ws, agent), JSON.stringify(turn) + "\n");
}

export function loadLedger(ws: string, agent: string): ConversationLedgerTurn[] {
  const f = ledgerFile(ws, agent);
  if (!existsSync(f)) return [];
  const out: ConversationLedgerTurn[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as ConversationLedgerTurn); } catch { /* ignore corrupt audit line */ }
  }
  return out;
}

export function loadContext(ws: string, agent: string): ConversationContext {
  const f = contextFile(ws, agent);
  if (!existsSync(f)) return { agent, includedTurns: [], excludedTurns: [] };
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8")) as ConversationContext;
    return { agent, includedTurns: parsed.includedTurns ?? [], excludedTurns: parsed.excludedTurns ?? [] };
  } catch {
    return { agent, includedTurns: [], excludedTurns: [] };
  }
}

export function recordContextDecision(
  ws: string,
  agent: string,
  decision: { include: boolean; turnId: string; runId: string; reason?: string },
): void {
  mkdirSync(paths.conversationDir(ws, agent), { recursive: true });
  const ctx = loadContext(ws, agent);
  const entry = { turnId: decision.turnId, runId: decision.runId, reason: decision.reason };
  const same = (x: ContextDecision) => x.turnId === decision.turnId;
  ctx.includedTurns = ctx.includedTurns.filter((x) => !same(x));
  ctx.excludedTurns = ctx.excludedTurns.filter((x) => !same(x));
  if (decision.include) ctx.includedTurns.push(entry);
  else ctx.excludedTurns.push(entry);
  writeFileSync(contextFile(ws, agent), JSON.stringify(ctx, null, 2));
}

/** Durably reset an agent's conversation (a user-invoked `/clear`). The append-only ledger + context are
 *  TRUTH, so they are ARCHIVED — moved to conversations/.archive/<agent>-<ts>/ — never deleted. The
 *  derived replay cache (agents/<id>/thread.jsonl) is wiped too. A subsequent turn recreates a fresh
 *  ledger and a subsequent boot loads an empty thread, so the old conversation never rehydrates. Returns
 *  the archive path (or null if there was nothing to archive). */
export function clearConversation(ws: string, agent: string, now: number = Date.now()): string | null {
  const dir = paths.conversationDir(ws, agent);
  let archived: string | null = null;
  if (existsSync(dir)) {
    const archiveRoot = join(ws, "conversations", ".archive");
    mkdirSync(archiveRoot, { recursive: true });
    archived = join(archiveRoot, `${agent}-${now}`);
    renameSync(dir, archived);
  }
  clearThread(ws, agent); // the derived replay cache lives under agents/<id>/, outside the conversation dir
  return archived;
}
