/** Plan 02 Phase 3 — the interactive waterfall inspector. Owns the keyboard while open via the same
 *  `cardKeyRef` pattern the approval cards use (App's one boot-registered useInput forwards keys here,
 *  sidestepping the first-keystroke race). A span tree with absolute-time bars; ⏎ drills into a
 *  per-kind detail (llm response · tool args/result · run outcome + coaching ledger). Layout + spans
 *  are pure (trace-tree.ts / trace-layout.ts); this file is just the view + navigation. */
import { useState, type MutableRefObject } from "react";
import { Box, Text } from "ink";
import type { CardKeyHandler } from "./ProposalCard";
import type { Span, SpanStatus } from "../core/trace-tree";
import { traceSummary } from "../core/trace-tree";
import { computeLayout, barString, fmtDuration } from "../core/trace-layout";

const statusIcon = (s: SpanStatus): string =>
  s === "ok" ? "✓" : s === "error" ? "✗" : s === "running" ? "…" : s === "blocked" ? "⊘" : "◼";

const cost = (c: number | null | undefined): string => (c == null ? "subscription" : `$${c.toFixed(4)}`);

/** The one-line summary of the selected span (pinned at the bottom). */
function selectionLine(span: Span): string {
  if (span.detail.kind === "tool") return `[${span.name}] ${span.detail.argsPreview ?? ""}${span.detail.error ? " ✗ " + span.detail.error : ""}`.trim();
  if (span.detail.kind === "llm") return `[${span.name}] ${span.detail.finishReason ?? ""}${span.detail.tokens != null ? " · " + span.detail.tokens + " tok" : ""}${span.detail.error ? " ✗ " + span.detail.error : ""}`.trim();
  if (span.detail.kind === "approval") return `[approval] ${span.detail.label}`;
  return `[${span.name}] ${span.detail.outcome} · ${span.detail.tokens} tok · ${cost(span.detail.costUsd)}`;
}

/** Build the per-kind detail body (array of lines) for the ⏎ drill-in. */
function detailLines(span: Span): string[] {
  const d = span.detail;
  if (d.kind === "run") {
    const lines = [
      `outcome: ${d.outcome}`,
      `tokens: ${d.tokens}${d.aggregate ? `  (subtree: ${d.aggregate.tokens})` : ""}`,
      `cost: ${cost(d.costUsd)}${d.aggregate ? `  (subtree: ${cost(d.aggregate.costUsd)})` : ""}`,
      `task: ${d.task}`,
      "",
      "coaching ledger:",
      `  policies retrieved: ${d.ledger.retrieved.join(", ") || "—"}`,
      `  policies applied:   ${d.ledger.applied.join(", ") || "—"}`,
      `  policies skipped:   ${d.ledger.skipped.map((s) => `${s.id} (${s.reason})`).join(", ") || "—"}`,
      `  knowledge:          ${d.ledger.knowledge.join(", ") || "—"}`,
      `  skills:             ${d.ledger.skills.join(", ") || "—"}`,
    ];
    if (d.verification.length) {
      lines.push("", "verification:");
      for (const v of d.verification) lines.push(`  ${v.verdict.pass ? "✓" : "✗"}${v.retried ? " (retry)" : ""} ${v.verdict.reasons.join("; ") || v.criteria}`);
    }
    if (d.notes.length) { lines.push("", "notes:"); for (const n of d.notes) lines.push(`  - ${n}`); }
    return lines;
  }
  if (d.kind === "llm") {
    return [
      `iteration: ${d.iteration}`,
      `finish: ${d.finishReason ?? (d.error ? "error" : "—")}`,
      `tokens: ${d.tokens ?? "—"}`,
      ...(d.error ? ["", `error: ${d.error}`] : []),
      "", "response:",
      (d.responseText ?? "(none)").slice(0, 1200),
    ];
  }
  if (d.kind === "tool") {
    return [
      `tool: ${d.tool}`,
      `args: ${d.args ?? d.argsPreview ?? "—"}`,
      ...(d.childRunId ? [`child run: ${d.childRunId}`] : []),
      ...(d.error ? ["", `error: ${d.error}`] : []),
      "", "result:",
      (d.result ?? "(none)").slice(0, 1200),
    ];
  }
  return [`approval: ${d.label}`, `kind: ${d.approvalKind}`, `waited: ${fmtDuration(span.endMs - span.startMs)}`];
}

export function TraceInspector(props: {
  rootId: string;
  spans: Span[];
  width: number;
  keyHandlerRef: MutableRefObject<CardKeyHandler | null>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState(false);

  const timelineWidth = Math.max(8, Math.min(48, props.width - 48));
  const layout = computeLayout(props.spans, { width: timelineWidth, collapsed });
  const rows = layout.rows;
  const sel = Math.min(Math.max(0, selected), Math.max(0, rows.length - 1));
  const selRow = rows[sel];
  const summary = traceSummary(props.spans);

  // Published during render so App's boot-registered useInput forwards the captain's first keystroke.
  props.keyHandlerRef.current = (input, key) => {
    if (detail) { if (key.escape || key.return || input === "q") setDetail(false); return; }
    if (input === "q" || key.escape) { props.onClose(); return; }
    if (key.upArrow) { setSelected(Math.max(0, sel - 1)); return; }
    if (key.downArrow) { setSelected(Math.min(rows.length - 1, sel + 1)); return; }
    if (key.rightArrow) {
      if (selRow?.hasChildren) setCollapsed((c) => { const n = new Set(c); n.delete(selRow.span.id); return n; });
      return;
    }
    if (key.leftArrow) {
      if (selRow?.hasChildren) setCollapsed((c) => { const n = new Set(c); n.add(selRow.span.id); return n; });
      return;
    }
    if (key.return) { if (selRow) setDetail(true); return; }
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {`TRACE ${props.rootId}`}
        {summary ? <Text color="gray">{`   ${fmtDuration(summary.durationMs)} · ${summary.tokens} tok · ${cost(summary.costUsd)} · ${statusIcon(summary.status)}`}</Text> : null}
      </Text>

      {rows.length === 0 && <Text dimColor>(no spans)</Text>}
      {rows.map((r, i) => {
        const isSel = i === sel;
        const expand = r.hasChildren ? (r.collapsed ? "▸" : "▾") : " ";
        const indent = "  ".repeat(r.depth);
        const name = `${expand} ${statusIcon(r.span.status)} ${r.span.name}`;
        const label = (indent + name).slice(0, 30).padEnd(30);
        const bar = barString(r.barOffset, r.barWidth, timelineWidth, r.span.kind === "run" ? "█" : r.span.kind === "approval" ? "▒" : "▓");
        const meta = `${fmtDuration(r.span.endMs - r.span.startMs).padStart(7)}${r.span.tokens != null ? ` ${r.span.tokens}t` : ""}`;
        return (
          <Text key={r.span.id} inverse={isSel} color={r.span.status === "error" ? "red" : isSel ? "cyan" : undefined}>
            {`${isSel ? "›" : " "}${label} ${bar} ${meta}`}
          </Text>
        );
      })}

      {selRow && !detail && (
        <Text color="gray">{selectionLine(selRow.span).slice(0, Math.max(10, props.width - 4))}</Text>
      )}

      {detail && selRow && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
          <Text bold>{selRow.span.name}</Text>
          {detailLines(selRow.span).flatMap((ln, j) =>
            ln.split("\n").map((sub, k) => <Text key={`${j}-${k}`}>{sub.slice(0, Math.max(10, props.width - 6))}</Text>),
          )}
          <Text dimColor>⏎/esc/q back</Text>
        </Box>
      )}

      {!detail && <Text dimColor>↑↓ move · →/← expand/collapse · ⏎ open · q close</Text>}
    </Box>
  );
}
