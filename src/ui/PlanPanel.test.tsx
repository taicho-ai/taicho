import { test, expect } from "bun:test";
import { planSummary, visibleItems, PLAN_PANEL_MAX_ROWS } from "./PlanPanel";
import type { PlanState, FoldedItem, PlanItemStatus } from "../schemas/plan";

const item = (id: string, status: PlanItemStatus): FoldedItem => ({ id, text: id, status });
const state = (items: FoldedItem[]): PlanState => ({
  plan: { id: "p_x", version: 1, owner: "root", goal: "g", items, parents: [], producer: "root", runId: "r", created: "2026-07-10T00:00:00.000Z" },
  handle: "p_x@v1",
  items,
  counts: {
    total: items.length,
    done: items.filter((i) => i.status === "done").length,
    open: items.filter((i) => i.status === "pending" || i.status === "in_progress").length,
    failed: items.filter((i) => i.status === "failed").length,
  },
});

test("planSummary omits a zero-failure count the eye would have to discard", () => {
  expect(planSummary(state([item("a", "done"), item("b", "pending")]))).toBe("1/2");
  expect(planSummary(state([item("a", "failed"), item("b", "pending")]))).toBe("0/2 · 1 failed");
});

test("visibleItems shows everything when the plan fits", () => {
  const items = [item("a", "done"), item("b", "pending")];
  expect(visibleItems(items, PLAN_PANEL_MAX_ROWS)).toEqual({ rows: items, hidden: 0 });
});

test("an over-long plan NEVER hides a failure or a running item — those are what the captain watches", () => {
  const items = [
    ...Array.from({ length: 8 }, (_, i) => item(`p${i}`, "pending")),
    item("running", "in_progress"),
    item("broken", "failed"),
  ];
  const { rows, hidden } = visibleItems(items, 4);
  expect(rows).toHaveLength(4);
  expect(hidden).toBe(6);
  expect(rows.map((r) => r.id)).toContain("running");
  expect(rows.map((r) => r.id)).toContain("broken");
});

test("the surviving rows keep the plan's own order, not the urgency order", () => {
  const items = [item("first", "pending"), item("broken", "failed"), item("last", "pending")];
  const { rows } = visibleItems(items, 2);
  // `broken` is urgent so it survives; `first` fills the remaining slot. Rendered in plan order.
  expect(rows.map((r) => r.id)).toEqual(["first", "broken"]);
});
