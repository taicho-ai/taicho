/** Plan 10 Phase 4 — pure unit coverage for the split-pane layout decision + the one-line sanitizer.
 *  The full pane lifecycle (appear / stream tool lines / collapse) and the /view toggle are exercised
 *  end-to-end through the real <App> in App.test.tsx; these lock down the size/mode math in isolation. */
import { test, expect } from "bun:test";
import { resolveLayout, paneOneLine, MIN_PANE_COLS, MIN_PANE_ROWS } from "./SquadPanes";

test("resolveLayout: `both` shows both surfaces on a roomy terminal", () => {
  expect(resolveLayout("both", 120, 40)).toEqual({ showPanes: true, showBar: true });
});

test("resolveLayout: `bar` hides the panes", () => {
  expect(resolveLayout("bar", 120, 40)).toEqual({ showPanes: false, showBar: true });
});

test("resolveLayout: `panes` hides the bar (on a terminal large enough to render panes)", () => {
  expect(resolveLayout("panes", 120, 40)).toEqual({ showPanes: true, showBar: false });
});

test("resolveLayout: a too-small terminal degrades EVERY mode to bar-only", () => {
  for (const mode of ["bar", "panes", "both"] as const) {
    expect(resolveLayout(mode, MIN_PANE_COLS - 1, 40)).toEqual({ showPanes: false, showBar: true }); // too narrow
    expect(resolveLayout(mode, 120, MIN_PANE_ROWS - 1)).toEqual({ showPanes: false, showBar: true }); // too short
  }
});

test("paneOneLine strips inline markdown markers, collapses whitespace, and caps", () => {
  // The pane must never leak the raw markdown the REPL is careful to hide (a mid-stream tail etc.).
  expect(paneOneLine("# Heading  **bold**   `code`")).toBe("Heading bold code");
  expect(paneOneLine("x".repeat(100), 10)).toHaveLength(10);
  expect(paneOneLine("x".repeat(100), 10).endsWith("…")).toBe(true);
});
