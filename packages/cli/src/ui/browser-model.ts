/** Plan 21 — the artifact browser's PURE model: scope resolution, filters, badges, run-grouping,
 *  sorts, and the "N of M" honesty line. No Ink, no state — everything here is unit-testable with a
 *  seeded workspace. The Shelf/Reader (ArtifactBrowser.tsx) render what this module returns.
 *
 *  Scopes (spec §2):
 *   - "run"          — the delegation subtree of one foreground turn (gatherConversationArtifacts).
 *   - "conversation" — the union over EVERY agent's conversation ledger (ledgers are per-agent; a
 *                      foreground @agent turn audits to the TARGET agent's ledger, so reading root's
 *                      alone would miss exactly the turns that docked the browser).
 *   - "all"          — the whole store (latest version per id, by the manifest's construction),
 *                      grouped by producing run so the widest scope reads as execution history. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Artifact, artifactHandle } from "@taicho-ai/contracts/artifact";
import { listArtifacts } from "@taicho-ai/framework/store/artifacts";
import { listAnnotations } from "@taicho-ai/framework/store/annotations";
import { loadLedger } from "@taicho-ai/framework/store/conversation";
import { gatherConversationArtifacts } from "@taicho-ai/framework/core/conversation-artifacts";

export type BrowserScope = "run" | "conversation" | "all";
export type BrowserSort = "run" | "time" | "producer";

export interface BrowserFilters {
  producer?: string;
  type?: string;
  feedback?: "open" | "any";
  verdict?: "pass" | "fail" | "any";
  since?: "24h" | "7d" | "30d" | "all";
  q?: string;
}

export interface RowBadges { openFeedback: number; approved: boolean; verdict?: "pass" | "fail"; }
export type ShelfRow =
  | { kind: "header"; label: string }
  | { kind: "artifact"; artifact: Artifact; badges: RowBadges };

const SINCE_MS: Record<Exclude<NonNullable<BrowserFilters["since"]>, "all">, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

function conversationAgents(ws: string): string[] {
  const dir = join(ws, "conversations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

/** Merge, keeping the LATEST version per logical id, ordered created desc — the same discipline
 *  gatherConversationArtifacts applies inside one run tree, applied across trees. */
function mergeLatest(lists: Artifact[][]): Artifact[] {
  const byId = new Map<string, Artifact>();
  for (const list of lists) for (const a of list) {
    const cur = byId.get(a.id);
    if (!cur || a.version > cur.version) byId.set(a.id, a);
  }
  return [...byId.values()].sort((x, y) => y.created.localeCompare(x.created));
}

export function resolveScope(ws: string, scope: BrowserScope, opts: { rootRunId?: string } = {}): Artifact[] {
  if (scope === "run") return opts.rootRunId ? gatherConversationArtifacts(ws, opts.rootRunId) : [];
  if (scope === "conversation") {
    const runIds = new Set<string>();
    for (const agent of conversationAgents(ws))
      for (const turn of loadLedger(ws, agent)) if (turn.runId) runIds.add(turn.runId);
    return mergeLatest([...runIds].map((id) => gatherConversationArtifacts(ws, id)));
  }
  return listArtifacts(ws);
}

/** Cold-start "latest run": the newest ledger turn across every agent's conversation — a foreground
 *  turn by definition (only user turns are audited). Undefined on a fresh workspace. */
export function latestRunFallback(ws: string): string | undefined {
  let best: { ts: string; runId: string } | undefined;
  for (const agent of conversationAgents(ws))
    for (const turn of loadLedger(ws, agent)) {
      if (!turn.runId || !turn.timestamp) continue;
      if (!best || turn.timestamp > best.ts) best = { ts: turn.timestamp, runId: turn.runId };
    }
  return best?.runId;
}

export function badgesFor(ws: string, a: Artifact): RowBadges {
  const anns = listAnnotations(ws, artifactHandle(a));
  let verdict: "pass" | "fail" | undefined;
  for (const an of anns) if (an.verdict) verdict = an.verdict.pass ? "pass" : "fail"; // last verdict wins
  return {
    // "Open feedback" means ACTIONABLE: open feedback text or a FAILING verdict. A passing checker
    // verdict is an open annotation too, but flagging it would tell the captain to act on a pass —
    // and an approval (open by ledger mechanics) is state, not feedback.
    openFeedback: anns.filter((an) => an.status === "open" && an.kind !== "approval" && (!an.verdict || !an.verdict.pass)).length,
    approved: anns.some((an) => an.kind === "approval"),
    verdict,
  };
}

export function applyFilters(ws: string, arts: Artifact[], f: BrowserFilters, nowMs = Date.now()): Artifact[] {
  const ql = f.q?.trim().toLowerCase();
  return arts.filter((a) => {
    if (f.producer && a.producer !== f.producer) return false;
    if (f.type && a.type !== f.type) return false;
    if (ql && !`${a.id} ${a.title} ${a.summary ?? ""}`.toLowerCase().includes(ql)) return false;
    if (f.since && f.since !== "all") {
      const age = nowMs - Date.parse(a.created);
      if (!(age <= SINCE_MS[f.since])) return false;
    }
    if (f.feedback === "open" || (f.verdict && f.verdict !== "any")) {
      const b = badgesFor(ws, a);
      if (f.feedback === "open" && b.openFeedback === 0) return false;
      if (f.verdict && f.verdict !== "any" && b.verdict !== f.verdict) return false;
    }
    return true;
  });
}

function shortRun(runId: string): string {
  const slash = runId.indexOf("/");
  return slash === -1 ? runId : runId.slice(slash + 1);
}

export function ageLabel(created: string, nowMs = Date.now()): string {
  const ms = nowMs - Date.parse(created);
  if (isNaN(ms)) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${Math.max(secs, 0)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Rows the Shelf renders. Only the all-runs scope with the default "run" sort gets group headers
 *  (execution history); every flat sort/scope is artifact rows only, and `sel` indexes ONLY the
 *  artifact rows — headers are never selectable. */
export function shelfRows(ws: string, arts: Artifact[], scope: BrowserScope, sort: BrowserSort, nowMs = Date.now()): ShelfRow[] {
  const row = (a: Artifact): ShelfRow => ({ kind: "artifact", artifact: a, badges: badgesFor(ws, a) });
  if (scope !== "all" || sort === "time")
    return [...arts].sort((x, y) => y.created.localeCompare(x.created)).map(row);
  if (sort === "producer")
    return [...arts].sort((x, y) => x.producer.localeCompare(y.producer) || y.created.localeCompare(x.created)).map(row);
  // sort === "run": group by producing run, groups ordered by their newest member.
  const groups = new Map<string, Artifact[]>();
  for (const a of arts) {
    const g = groups.get(a.runId) ?? [];
    g.push(a);
    groups.set(a.runId, g);
  }
  const ordered = [...groups.entries()].map(([runId, list]) => {
    list.sort((x, y) => y.created.localeCompare(x.created));
    return { runId, list, newest: list[0]!.created };
  }).sort((x, y) => y.newest.localeCompare(x.newest));
  const out: ShelfRow[] = [];
  for (const g of ordered) {
    out.push({ kind: "header", label: `── ${shortRun(g.runId)} · ${g.list.length} artifact${g.list.length === 1 ? "" : "s"} · ${ageLabel(g.newest, nowMs)}` });
    for (const a of g.list) out.push(row(a));
  }
  return out;
}

/** The honesty line (spec §3): a filtered shelf announces itself, never impersonates the store. */
export function countLine(matched: number, total: number): string {
  if (matched === total) return `${total} artifact${total === 1 ? "" : "s"}`;
  return `${matched} of ${total} match`;
}

/** The artifact rows in shelf order (what `sel` indexes). */
export function artifactRows(rows: ShelfRow[]): Extract<ShelfRow, { kind: "artifact" }>[] {
  return rows.filter((r): r is Extract<ShelfRow, { kind: "artifact" }> => r.kind === "artifact");
}
