/** Plan 02 Phase 6 — the LIVE waterfall surface. A display-only, redrawing span tree of the in-flight
 *  run(s): the live counterpart to the post-hoc /trace inspector (TraceInspector.tsx), rendered in
 *  place above the input while a run executes (replacing the flat `↳` breadcrumbs, which stay in
 *  scrollback as the record). The spans come from live-trace.ts folding the SAME event stream that
 *  drives the status bar/panes; the layout is the SAME pure trace-layout code the inspector uses, so
 *  the live and post-hoc waterfalls read identically. A light ticker re-renders while running so
 *  in-flight bars grow between engine events. Display-only: the REPL always owns the keyboard. */
import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { Span, SpanStatus } from "../core/trace-tree";
import { computeLayout, barString, fmtDuration } from "../core/trace-layout";

const statusIcon = (s: SpanStatus): string =>
  s === "ok" ? "✓" : s === "error" ? "✗" : s === "running" ? "…" : s === "blocked" ? "⊘" : "◼";

const barFill = (kind: Span["kind"]): string =>
  kind === "run" ? "█" : kind === "approval" ? "▒" : "▓";

/** Extend a still-running span's endMs to `now` so its bar grows between events (the settled ones keep
 *  the authoritative end their settle event stamped). Mirrors liveSpans() — done here too so the
 *  ticker's re-render keeps growing bars even without a new engine event. */
function withNow(spans: Span[], now: number): Span[] {
  return spans.map((s) => (s.status === "running" && now > s.endMs ? { ...s, endMs: now } : s));
}

export function LiveWaterfall({ spans, width, maxRows = 12 }: { spans: Span[]; width: number; maxRows?: number }) {
  // A light ticker advances elapsed readouts + grows in-flight bars. Gated on there being spans so an
  // idle REPL pays nothing (same discipline as the bar/panes tickers).
  const [, setTick] = useState(0);
  const hasSpans = spans.length > 0;
  useEffect(() => {
    if (!hasSpans) return;
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [hasSpans]);
  if (!hasSpans) return null;

  const now = Date.now();
  const live = withNow(spans, now);
  const timelineWidth = Math.max(8, Math.min(40, width - 44));
  const layout = computeLayout(live, { width: timelineWidth });
  const allRows = layout.rows;
  // Keep the newest rows in view when the tree outgrows the budget (a deep cascade); the header stays.
  const rows = allRows.length > maxRows ? allRows.slice(allRows.length - maxRows) : allRows;
  const overflow = allRows.length - rows.length;

  const running = live.filter((s) => s.status === "running").length;
  const start = Math.min(...live.map((s) => s.startMs).filter(Number.isFinite));
  const end = Math.max(...live.map((s) => s.endMs).filter(Number.isFinite));
  const elapsed = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>{`WATERFALL (live) · ${fmtDuration(elapsed)}${running ? ` · ${running} running` : ""}`}</Text>
      {overflow > 0 && <Text dimColor>{`  … ${overflow} earlier span(s)`}</Text>}
      {rows.map((r) => {
        const expand = r.hasChildren ? (r.collapsed ? "▸" : "▾") : " ";
        const indent = "  ".repeat(r.depth);
        const name = `${expand} ${statusIcon(r.span.status)} ${r.span.name}`;
        const label = (indent + name).slice(0, 28).padEnd(28);
        const bar = barString(r.barOffset, r.barWidth, timelineWidth, barFill(r.span.kind));
        const meta = `${fmtDuration(r.span.endMs - r.span.startMs).padStart(7)}${r.span.tokens != null ? ` ${r.span.tokens}t` : ""}`;
        return (
          <Text key={r.span.id} color={r.span.status === "error" ? "red" : r.span.status === "running" ? "cyan" : "gray"}>
            {`${label} ${bar} ${meta}`}
          </Text>
        );
      })}
    </Box>
  );
}
