/** Plan 10 Phase 3 — the live status bar. One compact segment per active run (glyph · agent · state
 *  · tool+argsPreview · elapsed), pinned at the bottom directly above the input. `waiting` is rendered
 *  loud (the "the squad is stalled on YOU" signal). Hidden when nothing runs; "+N more" past width.
 *  Renders purely from the AgentStatus model (agent-status.ts) — nothing invented here. */
import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { AgentStatus } from "../core/agent-status";

const GLYPH: Record<AgentStatus["state"], string> = {
  idle: "·", thinking: "…", writing: "✎", working: "●", delegating: "⇢", waiting: "✋",
};

/** One segment's plain text (used for both rendering and width budgeting). */
export function segmentText(s: AgentStatus, now: number, cap = 64): string {
  const secs = Math.max(0, Math.round((now - s.since) / 1000));
  const tool = s.tool ? ` ${s.tool}${s.argsPreview ? `(${s.argsPreview})` : ""}` : "";
  const label = s.waiting ? `waiting: ${s.tool ?? ""}`.trim() : `${s.state}${tool}`;
  const text = `${GLYPH[s.state]} ${s.agent} ${label} ${secs}s`;
  return text.length > cap ? text.slice(0, cap - 1) + "…" : text;
}

export function StatusBar({ statuses, width }: { statuses: AgentStatus[]; width: number }) {
  // A light ticker advances the elapsed readouts without any engine event.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  if (!statuses.length) return null;

  const now = Date.now();
  const segs = statuses.map((s) => ({ s, text: segmentText(s, now, Math.min(64, width - 4)) }));
  const SEP = 3; // " · "
  const shown: typeof segs = [];
  let used = 0;
  for (const seg of segs) {
    const add = seg.text.length + (shown.length ? SEP : 0);
    if (shown.length && used + add > width - 8) break; // reserve room for the "+N more" tail
    shown.push(seg);
    used += add;
  }
  const hidden = segs.length - shown.length;

  return (
    <Box>
      {shown.map((seg, i) => (
        <Text key={seg.s.runId}>
          {i > 0 ? <Text dimColor> · </Text> : null}
          <Text
            color={seg.s.waiting ? "red" : seg.s.state === "delegating" ? "magenta" : seg.s.state === "writing" ? "green" : "cyan"}
            bold={seg.s.waiting}
          >
            {seg.text}
          </Text>
        </Text>
      ))}
      {hidden > 0 && <Text dimColor>{` +${hidden} more`}</Text>}
    </Box>
  );
}
