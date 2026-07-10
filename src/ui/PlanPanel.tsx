/** Plan 18: the pinned plan panel — a checklist that redraws in place while a plan is live and
 *  collapses to nothing when there isn't one.
 *
 *  Display-only. The REPL always owns the keyboard, exactly as SquadPanes does; there is no focus
 *  state, no key handler, nothing to steal ⏎ from the input. Rail colours are lifted from AgentBlock's
 *  railColor so the two live surfaces read as one system rather than two. */
import React from "react";
import { Box, Text } from "ink";
import type { PlanState, PlanItemStatus, FoldedItem } from "../schemas/plan";

/** Fixed height, like AgentBlock's body: a long plan must not push the input off the screen. */
export const PLAN_PANEL_MAX_ROWS = 8;

const GLYPH: Record<PlanItemStatus, string> = {
  pending: "○",
  in_progress: "◐",
  done: "✓",
  failed: "✗",
  blocked: "✗",
  interrupted: "?",
  dropped: "–",
};

/** Same vocabulary as AgentBlock: green done, amber live, red failed, magenta delegated. */
function itemColor(s: PlanItemStatus): string | undefined {
  switch (s) {
    case "done": return "green";
    case "in_progress": return "yellow";
    case "failed":
    case "blocked": return "red";
    case "interrupted": return "red";
    case "dropped": return "gray";
    default: return "gray";
  }
}

/** `3/7 · 1 failed` — the summary a captain reads before the detail. Only mention failures when there
 *  are any: a clean plan should not carry a "0 failed" the eye has to discard. */
export function planSummary(s: PlanState): string {
  const base = `${s.counts.done}/${s.counts.total}`;
  return s.counts.failed ? `${base} · ${s.counts.failed} failed` : base;
}

/** Which rows to show when the plan is taller than the panel: never hide a failure, and never hide
 *  what is running. Those are the two things the captain is watching for. */
export function visibleItems(items: FoldedItem[], max: number): { rows: FoldedItem[]; hidden: number } {
  if (items.length <= max) return { rows: items, hidden: 0 };
  const urgent = items.filter((i) => i.status === "in_progress" || i.status === "failed" || i.status === "blocked" || i.status === "interrupted");
  const rest = items.filter((i) => !urgent.includes(i));
  const rows = [...urgent, ...rest].slice(0, max);
  // restore the plan's own order — the captain wrote it in that order for a reason
  const ordered = items.filter((i) => rows.includes(i));
  return { rows: ordered, hidden: items.length - ordered.length };
}

export function PlanPanel({ plan, width }: { plan: PlanState; width: number }) {
  const { rows, hidden } = visibleItems(plan.items, PLAN_PANEL_MAX_ROWS);
  const cap = Math.max(20, width - 8);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color="cyan">▎plan</Text>
        <Text color="gray"> · {plan.handle} · </Text>
        <Text color={plan.counts.failed ? "red" : "gray"}>{planSummary(plan)}</Text>
      </Text>
      {rows.map((i) => {
        const who = i.assignee ? ` @${i.assignee}` : "";
        const why = i.status === "failed" && i.note ? ` — ${i.note}` : "";
        const line = `${i.text}${who}${why}`;
        return (
          <Text key={i.id}>
            <Text color={itemColor(i.status)}>{"  "}{GLYPH[i.status]} </Text>
            <Text color={i.status === "done" || i.status === "dropped" ? "gray" : undefined} dimColor={i.status === "pending"}>
              {line.slice(0, cap)}
            </Text>
          </Text>
        );
      })}
      {hidden > 0 && <Text color="gray">{"  "}+{hidden} more</Text>}
    </Box>
  );
}
