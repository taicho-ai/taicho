/** Plan 13 — pure unit coverage for the rolling-tail window logic. The full lifecycle (window appears
 *  on a streaming run, rolls as deltas arrive, clears on completion) is exercised end-to-end through the
 *  real <App> in App.test.tsx; these lock down the fixed-height windowing math in isolation. */
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { RollingStream, tailLines, ROLL_LINES, MAX_ROLL_LINES } from "./RollingStream";
import type { AgentStatus } from "../core/agent-status";

const now = Date.now();
const mkStatus = (runId: string, agent: string): AgentStatus =>
  ({ runId, agent, state: "writing", since: now, inflightTools: 0, waiting: false });

test("tailLines keeps only the last N lines — older lines scroll off (fixed window, never grows)", () => {
  expect(tailLines("a\nb\nc\nd\ne\nf", 4)).toEqual(["c", "d", "e", "f"]);
  expect(tailLines("a\nb\nc\nd\ne\nf\ng\nh", 4)).toEqual(["e", "f", "g", "h"]);
});

test("tailLines shows fewer than N when the stream is short (never pads)", () => {
  expect(tailLines("only", 4)).toEqual(["only"]);
  expect(tailLines("a\nb", 4)).toEqual(["a", "b"]);
});

test("tailLines drops a single trailing-newline empty segment so a just-closed line isn't blank", () => {
  expect(tailLines("a\nb\n", 4)).toEqual(["a", "b"]);
  // …but an intentional blank line in the middle survives.
  expect(tailLines("a\n\nb\n", 4)).toEqual(["a", "", "b"]);
});

test("tailLines handles empty input", () => {
  expect(tailLines("", 4)).toEqual([]);
});

test("tailLines clamps N to [1, MAX_ROLL_LINES] so the cap holds end to end", () => {
  const text = "a\nb\nc\nd\ne\nf\ng";
  expect(tailLines(text, 99)).toHaveLength(MAX_ROLL_LINES);        // capped at 5, never more
  expect(tailLines(text, 99)).toEqual(["c", "d", "e", "f", "g"]);
  expect(tailLines(text, 0)).toEqual(["g"]);                       // clamped up to at least 1
});

test("the default window is 4 lines and the hard cap is 5", () => {
  expect(ROLL_LINES).toBe(4);
  expect(MAX_ROLL_LINES).toBe(5);
});

test("caps visible windows by terminal height and shows a `+N more` overflow when many agents stream", () => {
  const statuses = ["r1", "r2", "r3", "r4"].map((id, i) => mkStatus(id, `agent-${i}`));
  const feed = new Map(statuses.map((s) => [s.runId, "tail line for " + s.runId]));
  // rows=12 leaves room for a single window (WINDOW_HEIGHT=6, RESERVED_ROWS=6), so 3 overflow.
  const { lastFrame } = render(<RollingStream statuses={statuses} feed={feed} columns={120} rows={12} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("agent-0");        // the first window renders
  expect(frame).toContain("+3 more");        // the rest collapse into the overflow line
  expect(frame).not.toContain("agent-3");    // an overflowed agent's window is not drawn
});

test("degrades to nothing below the minimum terminal size (bar-only is the fallback surface)", () => {
  const statuses = [mkStatus("r1", "solo")];
  const feed = new Map([["r1", "hello"]]);
  const { lastFrame } = render(<RollingStream statuses={statuses} feed={feed} columns={40} rows={8} />);
  expect((lastFrame() ?? "").trim()).toBe("");   // returns null → no rolling surface when too small
});
