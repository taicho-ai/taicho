import { test, expect } from "bun:test";
import { rankAgents } from "./discovery";

const rows = [
  { id: "geo", role: "Geopolitics researcher with web search", is_root: 0 },
  { id: "poet", role: "Writes poetry and prose", is_root: 0 },
  { id: "root", role: "Orchestrator", is_root: 1 },
];

test("ranks by keyword overlap and excludes root", () => {
  const hits = rankAgents(rows, "research geopolitics", 5);
  expect(hits[0].id).toBe("geo");
  expect(hits.some((h) => h.id === "root")).toBe(false);
});

test("respects k", () => {
  expect(rankAgents(rows, "writes", 1).length).toBe(1);
});

test("no match returns empty", () => {
  expect(rankAgents(rows, "quantum chromodynamics", 5)).toEqual([]);
});
