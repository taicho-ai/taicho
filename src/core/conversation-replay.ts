/** Plan 05 Phase 3 — cross-turn (boot-replay) compaction, unblocked by Plan 01 Phase 5's seam.
 *
 *  Plan 05 Phase 2 bounds context growth WITHIN a run; this bounds it ACROSS turns. `thread.jsonl`
 *  replayed EVERY completed turn at boot, forever — a long-lived deck accumulated conversation
 *  history until the assembled prompt no longer fit. Boot replay now becomes a rolling conversation
 *  SUMMARY (older turns, folded deterministically) + the recent-K turns kept VERBATIM.
 *
 *  Two invariants, both load-bearing:
 *   1. The LEDGER (`conversations/<agent>/ledger.jsonl`) is append-only TRUTH — compaction changes
 *      what REPLAYS, never what is RECORDED. `thread.jsonl` is a DERIVED cache, REBUILT from the
 *      ledger's INCLUDED turns each time a completed turn is recorded through the seam (so it is
 *      deterministic — the same ledger always yields the same replay; no drift).
 *   2. Replay carries artifact HANDLES + summaries, never inlined BODIES (Plan 01 Phase 5) — each
 *      produced handle is resolved to `[id@vN] title — summary` via `readArtifact` (envelope only;
 *      `readArtifactBody` is never called on the replay path), so payloads can't re-enter context.
 *
 *  Reuses the Plan 05 in-run machinery where it fits: the `estimateTokens` estimator and the
 *  marker-led summary shape mirror `core/compaction.ts` (a `[…COMPACTION]` marker keeps the fold
 *  VISIBLE in the replayed prompt). The FOLD itself is turn-aware (a conversation is user/assistant
 *  pairs, not tool round-trips), so it does not reuse `compactMessages`' round-trip grouping. */
import type { ModelMessage } from "ai";
import { loadContext, loadLedger } from "../store/conversation";
import { writeThread } from "../store/thread";
import { readArtifact } from "../store/artifacts";
import { artifactHandle } from "../schemas/artifact";
import { estimateTokens } from "./compaction";
import { log } from "./logger";

/** How many recent conversation turns (a turn = one user message) replay VERBATIM; older ones fold
 *  into the rolling summary. Config disposes via `defaults.replayKeepTurns`; model never supplies it. */
export const DEFAULT_REPLAY_KEEP_TURNS = 6;

const SUMMARY_MARKER = "[CONVERSATION COMPACTION]";
const MAX_SUMMARY_CHARS = 2000;
const TURN_GIST_CHARS = 220;
// Headroom reserved (chars) for the header + a possible one-line elision note, so the character budget
// below never truncates either of them mid-string.
const SUMMARY_RESERVE_CHARS = 140;

export interface ReplayCompaction {
  messages: ModelMessage[];   // [summary message?] + recent-K turns VERBATIM
  summaryText?: string;       // the rolling summary body (also the head message content); undefined ⇒ nothing folded
  foldedTurns: number;        // how many user-turns collapsed into the summary
}

function contentToText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

/** A one-line, deterministic gist of a message's text (whitespace-collapsed, capped). */
function gist(content: unknown): string {
  return contentToText(content).replace(/\s+/g, " ").trim().slice(0, TURN_GIST_CHARS);
}

/** Build the visible, deterministic rolling-summary body from the folded (older) messages. No model
 *  call — pure extraction, mirroring core/compaction.ts's marker-led shape. Pairs each folded user
 *  message with the assistant reply that follows it.
 *
 *  Bounded by CHARACTERS (not a fixed line count), filling from the MOST RECENT folded turns — the ones
 *  closest to the kept verbatim tail, so most relevant for continuity. Any older overflow is NOTED with
 *  an explicit elision line, never silently dropped. (Plan 05 Ph3 follow-up: the old code capped at the
 *  OLDEST ~39 gists and lost every folded turn after them — the more-recent, more-relevant folded turns
 *  vanished without a trace. Now every folded turn is either gisted or accounted for in the count.) */
function buildReplaySummary(folded: ModelMessage[], foldedTurns: number): string {
  const header =
    `${SUMMARY_MARKER} Folded ${foldedTurns} earlier turn${foldedTurns === 1 ? "" : "s"} of this ` +
    `conversation. The recent turns replay verbatim below; the ledger keeps the full record. ` +
    `Any artifacts are referenced by handle (read_artifact for the body).`;
  // One gist line per folded USER turn (paired with the assistant reply that followed it), oldest→newest.
  const gists: string[] = [];
  for (let i = 0; i < folded.length; i++) {
    const m = folded[i];
    if (m.role !== "user") continue;
    const you = gist(m.content);
    const next = folded[i + 1];
    const reply = next && next.role === "assistant" ? gist(next.content) : "";
    gists.push(reply ? `· you: ${you}  →  ${reply}` : `· you: ${you}`);
  }
  // Fill from the newest folded gist backwards while the character budget (minus header/elision reserve)
  // holds; whatever doesn't fit is the OLDEST overflow and is reported, not lost.
  const kept: string[] = [];
  let used = header.length + SUMMARY_RESERVE_CHARS;
  for (let i = gists.length - 1; i >= 0; i--) {
    if (used + gists[i]!.length + 1 > MAX_SUMMARY_CHARS) break;
    kept.unshift(gists[i]!);
    used += gists[i]!.length + 1;
  }
  const elided = gists.length - kept.length;
  const lines = [header];
  if (elided > 0) {
    lines.push(`· (… ${elided} older folded turn${elided === 1 ? "" : "s"} elided — full record in the ledger …)`);
  }
  lines.push(...kept);
  return lines.join("\n");
}

/** Deterministically fold the OLDEST turns into ONE rolling-summary message; keep the recent
 *  `keepRecentTurns` turns (counted by user message) VERBATIM. Returns the input unchanged (folded
 *  0) when there are not more turns than the kept tail. Pure — no I/O, no model call. */
export function compactReplay(messages: ModelMessage[], keepRecentTurns: number): ReplayCompaction {
  const keep = Math.max(0, keepRecentTurns);
  const userIdxs = messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
  if (userIdxs.length <= keep) return { messages, foldedTurns: 0 };
  const cut = keep === 0 ? messages.length : userIdxs[userIdxs.length - keep];
  const older = messages.slice(0, cut);
  const tail = messages.slice(cut);
  const foldedTurns = userIdxs.length - keep;
  const summaryText = buildReplaySummary(older, foldedTurns);
  const summaryMsg: ModelMessage = { role: "user", content: summaryText };
  return { messages: [summaryMsg, ...tail], summaryText, foldedTurns };
}

/** Resolve produced handles to a compact `[id@vN] title — summary` reference string. Reads the
 *  ENVELOPE only (readArtifact) — the body is never inlined, which is the whole point of Plan 01. */
function artifactRefs(ws: string, handles: string[]): string {
  const parts: string[] = [];
  for (const h of handles) {
    const a = readArtifact(ws, h);
    if (!a) { parts.push(`[${h}] (unavailable)`); continue; }
    parts.push(`[${artifactHandle(a)}] ${a.title}${a.summary ? " — " + a.summary : ""}`);
  }
  return parts.join("; ");
}

/** Reconstruct the replay message list from the ledger's INCLUDED turns (Plan 01 Ph5 decision C:
 *  ledger = truth, context.json = which turns are safe to replay). An assistant turn that produced
 *  artifacts gets a by-reference handle+summary block appended — handles, never bodies. */
export function buildReplayMessages(ws: string, agent: string): ModelMessage[] {
  const included = new Set(loadContext(ws, agent).includedTurns.map((t) => t.turnId));
  const messages: ModelMessage[] = [];
  for (const turn of loadLedger(ws, agent)) {
    if (!included.has(turn.turnId)) continue;
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    let content = contentToText(turn.content);
    if (turn.role === "assistant" && turn.artifacts?.length) {
      const refs = artifactRefs(ws, turn.artifacts);
      if (refs) content = `${content}\n\n[artifacts produced — by reference, read_artifact for the body] ${refs}`;
    }
    messages.push({ role: turn.role, content });
  }
  return messages;
}

/** Rebuild the DERIVED boot-replay cache (`thread.jsonl`) from the ledger, compacting older turns
 *  into the rolling summary. Called through the `recordTurnOutcome` seam (Plan 05 Ph3): the summary
 *  is written HERE, not recorded in the ledger — the ledger stays append-only truth. Returns the
 *  compaction so the caller can surface it. */
export function rebuildReplayCache(ws: string, agent: string, opts?: { keepRecentTurns?: number }): ReplayCompaction {
  const keep = opts?.keepRecentTurns != null && opts.keepRecentTurns >= 0 ? opts.keepRecentTurns : DEFAULT_REPLAY_KEEP_TURNS;
  const full = buildReplayMessages(ws, agent);
  const compacted = compactReplay(full, keep);
  writeThread(ws, agent, compacted.messages);
  if (compacted.foldedTurns > 0) {
    log.debug(
      `conversation replay compacted for ${agent}: folded ${compacted.foldedTurns} turn(s), ` +
        `${estimateTokens(contentToText(compacted.summaryText ?? ""))} summary tok, ${keep} kept verbatim`,
    );
  }
  return compacted;
}
