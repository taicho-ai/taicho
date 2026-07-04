/** Plan 02 — waterfall layout (pure). Maps the derived Span tree onto absolute-time bars in a fixed
 *  column budget, with a ≥1-cell min-width floor (so sub-second llm/tool spans never vanish) and a
 *  duration-adaptive scale (a 4-second trace and a 4-minute trace both read well). Expand/collapse is
 *  a set of collapsed span ids → visible-rows computation. No Ink; unit-tested in isolation. */
import type { Span } from "./trace-tree";

export interface LayoutRow {
  span: Span;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  barOffset: number; // columns from the left of the timeline region (0-based)
  barWidth: number;  // ≥ 1 (the min-width floor)
}

export interface Layout {
  rows: LayoutRow[];
  traceStart: number;
  traceEnd: number;
  width: number;
}

/** parentId → children, each child list ordered by startMs (then id for stability). */
function childrenByParent(spans: Span[]): Map<string | undefined, Span[]> {
  const ids = new Set(spans.map((s) => s.id));
  const map = new Map<string | undefined, Span[]>();
  for (const s of spans) {
    // Treat a span whose parent isn't present as a root (robust against a pruned/missing parent).
    const parent = s.parentId && ids.has(s.parentId) ? s.parentId : undefined;
    const arr = map.get(parent) ?? [];
    arr.push(s);
    map.set(parent, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  return map;
}

/** Depth-first pre-order visible rows: a collapsed span keeps its own row but hides its subtree. */
export function visibleRows(spans: Span[], collapsed: ReadonlySet<string> = new Set()): Array<{ span: Span; depth: number; hasChildren: boolean; collapsed: boolean }> {
  const byParent = childrenByParent(spans);
  const out: Array<{ span: Span; depth: number; hasChildren: boolean; collapsed: boolean }> = [];
  const walk = (span: Span, depth: number) => {
    const kids = byParent.get(span.id) ?? [];
    const isCollapsed = collapsed.has(span.id);
    out.push({ span, depth, hasChildren: kids.length > 0, collapsed: isCollapsed });
    if (isCollapsed) return;
    for (const k of kids) walk(k, depth + 1);
  };
  for (const root of byParent.get(undefined) ?? []) walk(root, 0);
  return out;
}

/** Map a [traceStart, traceEnd] span onto [0, width) columns with a ≥1-cell floor and clamping. */
export function barFor(startMs: number, endMs: number, traceStart: number, traceEnd: number, width: number): { barOffset: number; barWidth: number } {
  const total = Math.max(0, traceEnd - traceStart);
  const scale = total > 0 ? width / total : 0;
  let barOffset = Math.floor((startMs - traceStart) * scale);
  if (!Number.isFinite(barOffset) || barOffset < 0) barOffset = 0;
  if (barOffset > width - 1) barOffset = Math.max(0, width - 1);
  let barWidth = Math.max(1, Math.round((endMs - startMs) * scale)); // the min-width floor
  if (!Number.isFinite(barWidth) || barWidth < 1) barWidth = 1;
  if (barOffset + barWidth > width) barWidth = Math.max(1, width - barOffset);
  return { barOffset, barWidth };
}

/** Full layout: visible rows + timeline bars over a shared absolute-time axis. */
export function computeLayout(spans: Span[], opts: { width: number; collapsed?: ReadonlySet<string> }): Layout {
  const width = Math.max(1, Math.floor(opts.width));
  const vis = visibleRows(spans, opts.collapsed);
  const starts = spans.map((s) => s.startMs).filter(Number.isFinite);
  const ends = spans.map((s) => s.endMs).filter(Number.isFinite);
  const traceStart = starts.length ? Math.min(...starts) : 0;
  const traceEnd = ends.length ? Math.max(...ends) : traceStart;
  const rows: LayoutRow[] = vis.map((r) => ({
    ...r,
    ...barFor(r.span.startMs, r.span.endMs, traceStart, traceEnd, width),
  }));
  return { rows, traceStart, traceEnd, width };
}

/** Render a bar as a fixed-width string of `width` columns: leading pad, then the filled bar. */
export function barString(barOffset: number, barWidth: number, width: number, fill = "█", track = " "): string {
  const pad = track.repeat(Math.max(0, barOffset));
  const bar = fill.repeat(Math.max(1, barWidth));
  const s = (pad + bar).slice(0, width);
  return s.padEnd(width, track);
}

/** Human duration: 820ms · 4.2s · 1m3s. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}
