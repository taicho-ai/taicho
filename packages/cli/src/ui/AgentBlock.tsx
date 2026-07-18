/** Plan 13 (corrected) — the consistent agent block. An agent (root and every sub-agent) is rendered
 *  as a single block: header + fixed 2-line body (3 max). The block NEVER changes shape across its
 *  lifecycle — only the state label, rail colour, and body content change:
 *
 *  ▎ <name> · <state> · <elapsed> [· <artifact@vN>]      ← header (one line)
 *  ▎   <body line 1>                                      ← body: fixed 2 lines (3 max)
 *  ▎   <body line 2>
 *
 *  Variants:
 *  - live (amber rail): rolling tail — newest delta line in at bottom, oldest scrolls off inside window
 *  - done (green rail): settled summary + artifact handle in header
 *  - failed (red rail): failure reason (first 2 lines)
 *
 *  The block IS the record: the block you watched live is the exact block that settles into scrollback.
 *  No collapse into a different element, no second UI. Display-only: reads the SAME AgentStatus model
 *  + delta events the bar/panes/live-trace consume; NEVER feeds back into transcript/ledger/replay. */
import { useState, useEffect, useRef, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { AgentStatus, AgentState } from "@taicho/framework/core/agent-status";

export type BlockVariant = "live" | "done" | "failed";

export interface AgentBlockData {
  runId: string;
  agent: string;
  state: AgentState;
  since: number;
  waiting: boolean;
  lines: string[];
  variant: BlockVariant;
  artifact?: string;
  summary?: string;
  error?: string;
  parentRunId?: string;
  depth: number;
}

const GLYPH: Record<AgentState, string> = {
  idle: "·", thinking: "…", writing: "✎", working: "●", delegating: "⇢", waiting: "✋",
};

const RULE = "▎";
const FOCUS_MARKER = "▸";

export const BLOCK_BODY_LINES = 2;
export const BLOCK_BODY_MAX = 3;

function railColor(variant: BlockVariant, state: AgentState, waiting: boolean): string {
  if (variant === "failed") return "red";
  if (variant === "done") return "green";
  if (waiting) return "red";
  if (state === "delegating") return "magenta";
  if (state === "writing") return "yellow";
  return "yellow";
}

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`.padStart(4);
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem.toString().padStart(2, "0")}`.padStart(4);
}

function headerLine(b: AgentBlockData, now: number, width: number): string {
  const elapsed = formatElapsed(now - b.since);
  const stateLabel = b.variant === "done" ? "done" : b.variant === "failed" ? "failed" : b.state;
  const artifact = b.artifact ? ` · ${b.artifact}` : "";
  const raw = `${GLYPH[b.state]} ${b.agent} · ${stateLabel} · ${elapsed}${artifact}`;
  return raw.length > width ? raw.slice(0, width - 1) + "…" : raw;
}

function bodyLines(b: AgentBlockData): string[] {
  if (b.variant === "done" && b.summary) {
    const lines = b.summary.split("\n").filter((l) => l.trim());
    return lines.slice(0, BLOCK_BODY_MAX);
  }
  if (b.variant === "failed" && b.error) {
    const lines = b.error.split("\n").filter((l) => l.trim());
    return lines.slice(0, BLOCK_BODY_MAX);
  }
  const tail = b.lines.slice(-BLOCK_BODY_MAX);
  while (tail.length < BLOCK_BODY_LINES) tail.unshift("");
  return tail;
}

function truncateLine(s: string, cap: number): string {
  const flat = s.replace(/[`*#]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > cap ? flat.slice(0, cap - 1) + "…" : flat;
}

export function AgentBlock({
  block,
  focused,
  width,
  now,
}: {
  block: AgentBlockData;
  focused: boolean;
  width: number;
  now: number;
}) {
  const color = railColor(block.variant, block.state, block.waiting);
  const header = headerLine(block, now, width - 4);
  const body = bodyLines(block);
  const indent = "  ".repeat(block.depth);
  const marker = focused ? FOCUS_MARKER + " " : "  ";

  const rows: ReactNode[] = [
    <Text key="h" color={color} bold={block.waiting || focused}>
      {indent}{marker}{RULE} {header}
    </Text>,
    ...body.map((l, i) => (
      <Text key={`b${i}`} color={color} dimColor>
        {indent}  {RULE}   {truncateLine(l, width - 6 - block.depth * 2)}
      </Text>
    )),
  ];

  return <Box flexDirection="column">{rows}</Box>;
}

/** The last `n` lines of text, bounded to [1, BLOCK_BODY_MAX]. A single trailing-newline empty segment
 *  is dropped so a just-closed line never renders as a blank row. */
export function tailLines(text: string, n: number): string[] {
  if (!text) return [];
  const keep = Math.min(BLOCK_BODY_MAX, Math.max(1, n));
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-keep);
}

/** Settle state: a block that just completed lingers briefly in `done` before being committed to
 *  scrollback. Same pattern as SquadPanes/RollingStream. */
const SETTLE_MS = 800;

interface SettleEntry {
  block: AgentBlockData;
  at: number;
}

export function useBlockSettle(liveBlocks: AgentBlockData[]): { allBlocks: AgentBlockData[]; settled: AgentBlockData[] } {
  const settleRef = useRef<Map<string, SettleEntry>>(new Map());
  const prevRef = useRef<Map<string, AgentBlockData>>(new Map());

  const liveIds = new Set(liveBlocks.map((b) => b.runId));
  const liveById = new Map(liveBlocks.map((b) => [b.runId, b]));
  const now = Date.now();
  const settle = settleRef.current;

  for (const id of liveIds) settle.delete(id);
  for (const [id, block] of prevRef.current) {
    if (!liveIds.has(id) && !settle.has(id)) {
      const doneBlock: AgentBlockData = { ...block, variant: "done", lines: block.lines };
      settle.set(id, { block: doneBlock, at: now });
    }
  }
  for (const [id, ent] of settle) {
    if (now - ent.at > SETTLE_MS) settle.delete(id);
  }
  prevRef.current = liveById;

  const settling = [...settle.values()].map((e) => e.block);
  const settled = settling.filter((b) => now - (settle.get(b.runId)?.at ?? 0) > SETTLE_MS / 2);

  // Merge live and settling blocks, deduplicating by runId (live takes precedence)
  const allById = new Map<string, AgentBlockData>();
  for (const b of settling) allById.set(b.runId, b);
  for (const b of liveBlocks) allById.set(b.runId, b); // live overrides settling

  return { allBlocks: [...allById.values()], settled };
}

/** Ticker hook: re-renders at 500ms intervals while blocks are live (for elapsed time). */
export function useBlockTicker(hasBlocks: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!hasBlocks) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [hasBlocks]);
  return tick;
}
