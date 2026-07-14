import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushHistory, histStart, histPrev, histNext, loadHistory, appendHistory } from "./input-history";

test("pushHistory appends, drops empties and consecutive dupes, and caps", () => {
  expect(pushHistory([], "hello")).toEqual(["hello"]);
  expect(pushHistory(["hello"], "hello")).toEqual(["hello"]);   // consecutive dupe ignored
  expect(pushHistory(["hello"], "  ")).toEqual(["hello"]);      // blank ignored
  expect(pushHistory(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  expect(pushHistory(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]); // capped, oldest dropped
});

test("histPrev walks older, stashing the live draft; histNext walks back to it", () => {
  const list = ["one", "two", "three"]; // oldest -> newest
  let nav = histStart();                 // idx -1 (on the draft)
  const p1 = histPrev(nav, list, "draft")!; // step up -> newest "three", draft stashed
  expect(p1.value).toBe("three"); nav = p1.nav;
  const p2 = histPrev(nav, list, "three")!;
  expect(p2.value).toBe("two"); nav = p2.nav;
  const n1 = histNext(nav, list)!;          // back down -> "three"
  expect(n1.value).toBe("three"); nav = n1.nav;
  const n2 = histNext(nav, list)!;          // back down past newest -> restored draft
  expect(n2.value).toBe("draft"); nav = n2.nav;
  expect(histNext(nav, list)).toBeNull();   // already on the draft -> no move
});

test("histPrev on an empty history is a no-op", () => {
  expect(histPrev(histStart(), [], "x")).toBeNull();
});

test("appendHistory + loadHistory round-trip, skipping blanks and consecutive dupes", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-hist-"));
  expect(loadHistory(ws)).toEqual([]);
  appendHistory(ws, "one"); appendHistory(ws, "one"); appendHistory(ws, "  "); appendHistory(ws, "two");
  expect(loadHistory(ws)).toEqual(["one", "two"]);
});
