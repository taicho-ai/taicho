import { test, expect } from "bun:test";
import { computeLayout, visibleRows, barFor, barString, fmtDuration } from "./trace-layout";
import type { Span } from "./trace-tree";

/** A minimal span factory (only the fields layout reads). */
function span(over: Partial<Span> & { id: string }): Span {
  return {
    kind: "run", name: over.id, agent: "a", status: "ok",
    startMs: 0, endMs: 0, detail: { kind: "run", outcome: "completed", task: "t", tokens: 0, costUsd: 0, notes: [], ledger: { retrieved: [], applied: [], skipped: [], knowledge: [], skills: [] }, verification: [] },
    ...over,
  } as Span;
}

// root [0,10000] → child [100,200] (tiny) → grandchild [150,160] (tinier)
const tree: Span[] = [
  span({ id: "root", startMs: 0, endMs: 10000 }),
  span({ id: "c1", parentId: "root", kind: "llm", startMs: 100, endMs: 200 }),
  span({ id: "c2", parentId: "root", kind: "run", startMs: 5000, endMs: 9000 }),
  span({ id: "g1", parentId: "c2", kind: "tool", startMs: 5100, endMs: 5110 }),
];

test("min-width floor: a tiny sub-second span still gets ≥1 cell", () => {
  const { rows } = computeLayout(tree, { width: 40 });
  const g1 = rows.find((r) => r.span.id === "g1")!;
  expect(g1.barWidth).toBeGreaterThanOrEqual(1); // 10ms of a 10s trace would round to 0 without the floor
  for (const r of rows) expect(r.barWidth).toBeGreaterThanOrEqual(1);
});

test("bars never overflow the column budget", () => {
  const { rows, width } = computeLayout(tree, { width: 20 });
  for (const r of rows) expect(r.barOffset + r.barWidth).toBeLessThanOrEqual(width);
});

test("barFor places the offset proportionally on the shared axis", () => {
  // a span starting halfway through a [0,100] trace lands near the middle of 100 cols
  const { barOffset } = barFor(50, 60, 0, 100, 100);
  expect(barOffset).toBe(50);
});

test("indent increases with nesting depth", () => {
  const rows = visibleRows(tree);
  const depth = (id: string) => rows.find((r) => r.span.id === id)!.depth;
  expect(depth("root")).toBe(0);
  expect(depth("c2")).toBe(1);
  expect(depth("g1")).toBe(2);
});

test("collapse hides the whole subtree", () => {
  const all = visibleRows(tree).map((r) => r.span.id);
  expect(all).toContain("g1");
  const collapsed = visibleRows(tree, new Set(["c2"])).map((r) => r.span.id);
  expect(collapsed).toContain("c2");   // the collapsed node itself stays
  expect(collapsed).not.toContain("g1"); // …but its child is hidden
  expect(collapsed).toContain("c1");   // an unrelated sibling is untouched
});

test("children order by startMs", () => {
  const rows = visibleRows(tree);
  const order = rows.map((r) => r.span.id);
  expect(order.indexOf("c1")).toBeLessThan(order.indexOf("c2")); // c1 starts at 100, c2 at 5000
});

test("a span whose parent is absent is treated as a root", () => {
  const orphan = [span({ id: "x", parentId: "ghost", startMs: 0, endMs: 1 })];
  expect(visibleRows(orphan).map((r) => r.span.id)).toEqual(["x"]);
});

test("barString pads to exactly width", () => {
  expect(barString(2, 3, 10).length).toBe(10);
  expect(barString(0, 1, 5)).toBe("█    ");
});

test("fmtDuration scales ms/s/m", () => {
  expect(fmtDuration(820)).toBe("820ms");
  expect(fmtDuration(4200)).toBe("4.2s");
  expect(fmtDuration(63000)).toBe("1m3s");
});
