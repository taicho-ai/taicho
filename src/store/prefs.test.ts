/** Plan 10 Phase 4 — the durable UI-prefs store (the mechanism /view persists through). */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getViewMode, setViewMode, readPrefs, DEFAULT_VIEW_MODE, isViewMode } from "./prefs";

const tmpWs = () => mkdtempSync(join(tmpdir(), "taicho-prefs-"));

test("getViewMode defaults to `both` when nothing is persisted", () => {
  expect(DEFAULT_VIEW_MODE).toBe("both");
  expect(getViewMode(tmpWs())).toBe("both");
});

test("setViewMode round-trips through disk (creates the file, survives a re-read)", () => {
  const ws = tmpWs();
  setViewMode(ws, "panes");
  expect(getViewMode(ws)).toBe("panes");
  expect(readPrefs(ws).viewMode).toBe("panes");
  setViewMode(ws, "bar"); // overwrite
  expect(getViewMode(ws)).toBe("bar");
});

test("isViewMode guards the known modes", () => {
  expect(isViewMode("both")).toBe(true);
  expect(isViewMode("panes")).toBe(true);
  expect(isViewMode("bar")).toBe(true);
  expect(isViewMode("nope")).toBe(false);
});

test("a malformed prefs file falls back to the default instead of throwing", () => {
  const ws = tmpWs();
  const { mkdirSync, writeFileSync } = require("node:fs");
  mkdirSync(join(ws, "agents"), { recursive: true });
  writeFileSync(join(ws, "agents", ".prefs.json"), "{ not json");
  expect(getViewMode(ws)).toBe("both");
});
