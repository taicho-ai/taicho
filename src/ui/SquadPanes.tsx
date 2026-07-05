/** Plan 10 Phase 4 — the split-pane live view. One pane per live agent: a status line (glyph ·
 *  agent · state · current tool+argsPreview · elapsed) plus its live stream (recent tool lines with
 *  argsPreview and the streamed/final text). Renders from the SAME AgentStatus model the bar does
 *  (agent-status.ts) plus a lightweight per-run activity feed the App builds off the one event
 *  stream — nothing is invented or re-derived here.
 *
 *  Lifecycle: a pane appears when an agent goes live and lingers in a dim `done` settle state for a
 *  beat after its run leaves the status map (so the captain sees the result land) before collapsing.
 *  Visible panes are capped by terminal height with a "+N more" overflow — the bar stays the
 *  complete summary. Below a minimum terminal size the panes degrade to bar-only (see resolveLayout).
 *  Display-only: the REPL always owns the keyboard (Plan 10 scope). */
import { useState, useEffect, useRef, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { AgentStatus, AgentState } from "../core/agent-status";
import type { ViewMode } from "../store/prefs";

/** Per-run activity feed the App accumulates from the event stream and hands to the panes: recent
 *  tool lines (each already a redacted `→ tool argsPreview`). The streamed/final REPLY text is NOT
 *  duplicated here — it renders in the main scrollback (the reply channel); echoing it in the pane
 *  raced that channel (the pane showed the reply before it committed / the trace persisted). The
 *  pane's live `writing`/`working` state + tool lines carry the transparency; the bar + scrollback
 *  carry the text. */
export interface PaneEntry { lines: string[] }
export type PaneFeedMap = ReadonlyMap<string, PaneEntry>;

const GLYPH: Record<AgentState, string> = {
  idle: "·", thinking: "…", writing: "✎", working: "●", delegating: "⇢", waiting: "✋",
};

/** Below either bound the panes collapse to bar-only (the bar always fits one line). */
export const MIN_PANE_COLS = 50;
export const MIN_PANE_ROWS = 10;

const SETTLE_MS = 1200;   // how long a completed pane lingers in its `done` state before collapsing
const PANE_BODY = 3;      // max body (activity) lines shown per pane
const PANE_HEIGHT = 5;    // header + body + spacer budget, for the terminal-height pane cap
const RESERVED_ROWS = 6;  // rows kept for the banner/scrollback/bar/input when budgeting pane space
const RULE = "▎";         // the left-accent that reads as a pane's column edge (cheap vs an Ink border)

/** Pure layout decision shared by the App and its tests: which surfaces show for a mode + terminal
 *  size. Panes hide in `bar`/`waterfall` mode and whenever the terminal is too small (degrade
 *  to bar-only); the `waterfall` mode (Plan 02 Phase 6) shows the redrawing live span tree in place of
 *  the panes; the bar stays only in `bar`/`both` (and everywhere when too small to render a richer surface).
 *  Plan 13's consistent-block view is the DEFAULT render — it replaces the panes as the primary squad view. */
export function resolveLayout(viewMode: ViewMode, columns: number, rows: number): { showPanes: boolean; showBar: boolean; showWaterfall: boolean } {
  const tooSmall = columns < MIN_PANE_COLS || rows < MIN_PANE_ROWS;
  return {
    showWaterfall: viewMode === "waterfall" && !tooSmall,
    showPanes: viewMode !== "bar" && viewMode !== "waterfall" && !tooSmall,
    // Bar is the complete summary; it owns the surface in bar/both, and is the fallback whenever a
    // richer surface (panes/waterfall) can't render because the terminal is too small.
    showBar: viewMode === "bar" || viewMode === "both" || tooSmall,
  };
}

/** Collapse to a single line: strip the inline markdown markers the REPL is careful to hide (so a
 *  mid-stream tail can never surface raw `**bold**` / `# heading` / `` `code` ``) and cap. Kept
 *  narrow (backtick/asterisk/hash) so tool names + args like `delegate_task` survive intact. */
export function paneOneLine(s: string, cap = 72): string {
  const flat = s.replace(/[`*#]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > cap ? flat.slice(0, cap - 1) + "…" : flat;
}

interface LivePane {
  runId: string; agent: string; state: AgentState; tool?: string; argsPreview?: string;
  since: number; waiting: boolean; lines: string[]; done: boolean;
}

function paneColor(p: LivePane): string {
  if (p.done) return "gray";
  if (p.waiting) return "red";
  if (p.state === "delegating") return "magenta";
  if (p.state === "writing") return "green";
  return "cyan";
}

function headerText(p: LivePane, now: number, width: number): string {
  const secs = Math.max(0, Math.round((now - p.since) / 1000));
  const label = p.done
    ? "done"
    : p.waiting
      ? `waiting: ${p.tool ?? ""}`.trim()
      : `${p.state}${p.tool ? ` ${p.tool}${p.argsPreview ? ` ${p.argsPreview}` : ""}` : ""}`;
  return paneOneLine(`${GLYPH[p.state]} ${p.agent} ${label} · ${secs}s`, width);
}

/** One pane's rows (header + indented body), as a flat list of plain colored Text. Deliberately
 *  border- and Box-free: an Ink bordered/nested Box re-lays-out its yoga tree on every event, which
 *  is measurably slower and can perturb timing-sensitive flows. A left-accent rule (the color-coded
 *  column edge) reads as the pane's edge for cheap. */
function paneRows(pane: LivePane, width: number, now: number, prefix: string): ReactNode[] {
  const color = paneColor(pane);
  const body = pane.lines.map((l) => paneOneLine(l, width - 4)).slice(-PANE_BODY);
  return [
    <Text key={`${prefix}-h`} color={color} bold={pane.waiting}>{`${RULE} ${headerText(pane, now, width - 2)}`}</Text>,
    ...body.map((l, i) => <Text key={`${prefix}-b${i}`} color={color} dimColor>{`${RULE}   ${l}`}</Text>),
  ];
}

export function SquadPanes({ statuses, feed, columns, rows }: {
  statuses: AgentStatus[]; feed: PaneFeedMap; columns: number; rows: number;
}) {
  const [, setTick] = useState(0);
  // settleRef: runs that just left the status map, kept briefly in a `done` snapshot. prevRef: the
  // panes rendered last frame, so a disappearance is detected against a self-contained snapshot
  // (the App may have already cleared the feed by the time a pane collapses).
  const settleRef = useRef<Map<string, { pane: LivePane; at: number }>>(new Map());
  const prevRef = useRef<Map<string, LivePane>>(new Map());

  const live: LivePane[] = statuses.map((s) => ({
    runId: s.runId, agent: s.agent, state: s.state, tool: s.tool, argsPreview: s.argsPreview,
    since: s.since, waiting: s.waiting,
    lines: feed.get(s.runId)?.lines ?? [], done: false,
  }));
  const liveIds = new Set(live.map((p) => p.runId));
  const liveById = new Map(live.map((p) => [p.runId, p]));

  const now = Date.now();
  const settle = settleRef.current;
  for (const id of liveIds) settle.delete(id);                              // a reappeared run cancels its settle
  for (const [id, pane] of prevRef.current)                                 // newly disappeared → snapshot in `done`
    if (!liveIds.has(id) && !settle.has(id)) settle.set(id, { pane: { ...pane, done: true }, at: now });
  for (const [id, ent] of settle) if (now - ent.at > SETTLE_MS) settle.delete(id); // expire
  prevRef.current = liveById;
  const settling = [...settle.values()].map((e) => e.pane);

  const all = [...live, ...settling];
  // A light ticker advances the elapsed readouts + expires settle panes — but ONLY while panes are
  // up. Left always-on it re-renders the whole App every tick even at rest, which measurably slows
  // the REPL (and perturbed a timing-sensitive steering test); gated, an idle REPL pays nothing.
  const hasPanes = all.length > 0;
  useEffect(() => {
    if (!hasPanes) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [hasPanes]);

  if (!all.length) return null;
  if (columns < MIN_PANE_COLS || rows < MIN_PANE_ROWS) return null;         // degrade to bar-only

  const avail = Math.max(PANE_HEIGHT, rows - RESERVED_ROWS);
  const maxPanes = Math.max(1, Math.floor(avail / PANE_HEIGHT));
  const shown = all.slice(0, maxPanes);
  const hidden = all.length - shown.length;
  const paneWidth = Math.min(columns - 4, 96);

  // One flat column of Text lines — a spacer row between panes gives the split-pane separation
  // without any nested Box (keeps the yoga tree, and so per-event render cost, minimal).
  const out: ReactNode[] = [];
  shown.forEach((p, i) => {
    if (i > 0) out.push(<Text key={`sp-${p.runId}`}> </Text>);
    out.push(...paneRows(p, paneWidth, now, p.runId));
  });
  if (hidden > 0) out.push(<Text key="more" dimColor>{`  +${hidden} more (the bar lists them all)`}</Text>);

  return <Box flexDirection="column">{out}</Box>;
}
