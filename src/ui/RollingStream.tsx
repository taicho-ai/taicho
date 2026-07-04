/** Plan 13 — the rolling compact live-stream view. A per-agent FIXED-height tail window: only the last
 *  N lines (default 4, cap 5) of the agent's streamed reply/work output, older lines scroll off — the
 *  window never grows. It gives presence + a peek at the tail ("agent X is producing, here's the end of
 *  it") without dumping the whole stream into scrollback and drowning the signal on a multi-agent run.
 *
 *  This is the reply/work channel the Plan 10 split panes deliberately OMIT — echoing streamed reply
 *  text inside a pane raced the scrollback reply channel (the pane showed the reply before it committed
 *  / the trace persisted; see SquadPanes). So the rolling stream lives behind its own opt-in `/view
 *  stream` mode, leaving the default `both` surfaces (and every test that waits on the scrollback reply)
 *  untouched. Display-only: it reads the SAME AgentStatus model + the SAME live delta events the bar /
 *  panes / live-trace consume, and it NEVER feeds back into the transcript / ledger / boot-replay (Plan
 *  05 owns compaction — this is a view, not a rewrite of the record). The REPL always owns the keyboard.
 *
 *  Lifecycle mirrors the panes: a window appears when an agent goes live, lingers a beat in a dim `done`
 *  settle state after its run leaves the status map (so the tail is seen landing), then collapses.
 *  Visible windows are capped by terminal height with a "+N more" overflow; below a minimum terminal
 *  size the surface degrades to bar-only (resolveLayout). */
import { useState, useEffect, useRef, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { AgentStatus, AgentState } from "../core/agent-status";
import { paneOneLine, MIN_PANE_COLS, MIN_PANE_ROWS } from "./SquadPanes";

/** Per-run streamed text the App accumulates from the `delta` events, already bounded to the last few
 *  lines (never the whole reply). The window shows the tail of this; the full reply still lands in the
 *  scrollback reply channel — this is a VIEW of the tail, not a second copy of the record. */
export type StreamFeedMap = ReadonlyMap<string, string>;

const GLYPH: Record<AgentState, string> = {
  idle: "·", thinking: "…", writing: "✎", working: "●", delegating: "⇢", waiting: "✋",
};

export const ROLL_LINES = 4;      // default tail lines shown per window
export const MAX_ROLL_LINES = 5;  // hard cap — the window never grows past this many lines

const SETTLE_MS = 1200;    // how long a completed window lingers in `done` before collapsing (mirrors panes)
const WINDOW_HEIGHT = 6;   // header + body + spacer budget, for the terminal-height window cap
const RESERVED_ROWS = 6;   // rows kept for banner/scrollback/bar/input when budgeting window space
const RULE = "▎";          // the left-accent column edge (cheap vs an Ink border), shared with the panes

/** The last `n` lines of a run's streamed text — the fixed-height rolling window (older lines scroll
 *  off, the window never grows). A single trailing-newline empty segment is dropped so a just-closed
 *  line never renders as a blank row. Clamped to [1, MAX_ROLL_LINES] so the cap holds end to end. */
export function tailLines(text: string, n: number): string[] {
  if (!text) return [];
  const keep = Math.min(MAX_ROLL_LINES, Math.max(1, n));
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-keep);
}

interface LiveWindow {
  runId: string; agent: string; state: AgentState; since: number; waiting: boolean;
  lines: string[]; done: boolean;
}

function windowColor(w: LiveWindow): string {
  if (w.done) return "gray";
  if (w.waiting) return "red";
  if (w.state === "delegating") return "magenta";
  if (w.state === "writing") return "green";
  return "cyan";
}

function headerText(w: LiveWindow, now: number, width: number): string {
  const secs = Math.max(0, Math.round((now - w.since) / 1000));
  const label = w.done ? "done" : w.state;
  return paneOneLine(`${GLYPH[w.state]} ${w.agent} ${label} · ${secs}s`, width);
}

/** One window's rows (header + indented tail lines), as a flat list of colored Text. Border- and
 *  Box-free like the panes (an Ink bordered/nested Box re-lays-out its yoga tree on every event); the
 *  left-accent rule is the window's column edge. Empty stream (no delta yet) shows just the header. */
function windowRows(w: LiveWindow, width: number, now: number): ReactNode[] {
  const color = windowColor(w);
  const body = w.lines.map((l) => paneOneLine(l, width - 4));
  return [
    <Text key={`${w.runId}-h`} color={color} bold={w.waiting}>{`${RULE} ${headerText(w, now, width - 2)}`}</Text>,
    ...body.map((l, i) => <Text key={`${w.runId}-b${i}`} color={color} dimColor>{`${RULE}   ${l}`}</Text>),
  ];
}

export function RollingStream({ statuses, feed, columns, rows, lines = ROLL_LINES }: {
  statuses: AgentStatus[]; feed: StreamFeedMap; columns: number; rows: number; lines?: number;
}) {
  const [, setTick] = useState(0);
  // settleRef: runs that just left the status map, kept briefly in a `done` snapshot. prevRef: the
  // windows rendered last frame, so a disappearance is detected against a self-contained snapshot
  // (the App may have already cleared the feed by the time a window collapses). Same pattern as panes.
  const settleRef = useRef<Map<string, { win: LiveWindow; at: number }>>(new Map());
  const prevRef = useRef<Map<string, LiveWindow>>(new Map());

  const live: LiveWindow[] = statuses.map((s) => ({
    runId: s.runId, agent: s.agent, state: s.state, since: s.since, waiting: s.waiting,
    lines: tailLines(feed.get(s.runId) ?? "", lines), done: false,
  }));
  const liveIds = new Set(live.map((w) => w.runId));
  const liveById = new Map(live.map((w) => [w.runId, w]));

  const now = Date.now();
  const settle = settleRef.current;
  for (const id of liveIds) settle.delete(id);                              // a reappeared run cancels its settle
  for (const [id, win] of prevRef.current)                                  // newly disappeared → snapshot in `done`
    if (!liveIds.has(id) && !settle.has(id)) settle.set(id, { win: { ...win, done: true }, at: now });
  for (const [id, ent] of settle) if (now - ent.at > SETTLE_MS) settle.delete(id); // expire
  prevRef.current = liveById;
  const settling = [...settle.values()].map((e) => e.win);

  const all = [...live, ...settling];
  // A light ticker advances elapsed readouts + expires settle windows — but ONLY while windows are up
  // (an always-on interval re-renders the whole App at rest; same discipline as the bar/panes tickers).
  const hasWindows = all.length > 0;
  useEffect(() => {
    if (!hasWindows) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [hasWindows]);

  if (!all.length) return null;
  if (columns < MIN_PANE_COLS || rows < MIN_PANE_ROWS) return null;         // degrade to bar-only

  const avail = Math.max(WINDOW_HEIGHT, rows - RESERVED_ROWS);
  const maxWindows = Math.max(1, Math.floor(avail / WINDOW_HEIGHT));
  const shown = all.slice(0, maxWindows);
  const hidden = all.length - shown.length;
  const winWidth = Math.min(columns - 4, 96);

  const out: ReactNode[] = [];
  shown.forEach((w, i) => {
    if (i > 0) out.push(<Text key={`sp-${w.runId}`}> </Text>);
    out.push(...windowRows(w, winWidth, now));
  });
  if (hidden > 0) out.push(<Text key="more" dimColor>{`  +${hidden} more (the bar lists them all)`}</Text>);

  return <Box flexDirection="column">{out}</Box>;
}
