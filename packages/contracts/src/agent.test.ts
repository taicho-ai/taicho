import { test, expect } from "bun:test";
import { AgentDef, effectiveTeams } from "./agent";

const base = { id: "a", role: "r", identity: "i", created: "2026-07-14T00:00:00.000Z" };

test("a modern agent parses its explicit teams verbatim", () => {
  expect(AgentDef.parse({ ...base, teams: ["news", "research"] }).teams).toEqual(["news", "research"]);
});

test("an agent with no teams field defaults to an empty (default-only) list", () => {
  expect(AgentDef.parse(base).teams).toEqual([]);
});

test("Plan 22 back-compat: a legacy single `team:` migrates to `teams: [<id>]` on parse", () => {
  expect(AgentDef.parse({ ...base, team: "news" }).teams).toEqual(["news"]);
  // an explicit `teams` wins over a stray legacy `team` (no double-count, no surprise)
  expect(AgentDef.parse({ ...base, team: "news", teams: ["trading"] }).teams).toEqual(["trading"]);
  // `team: null` / empty is an absence, not a membership
  expect(AgentDef.parse({ ...base, team: null }).teams).toEqual([]);
  expect(AgentDef.parse({ ...base, team: "" }).teams).toEqual([]);
});

test("the legacy `team` key never survives onto the parsed agent", () => {
  const parsed = AgentDef.parse({ ...base, team: "news" }) as Record<string, unknown>;
  expect("team" in parsed).toBe(false);
});

test("effectiveTeams prepends the implicit default, deduped, default first", () => {
  expect(effectiveTeams({ teams: [] })).toEqual(["default"]);
  expect(effectiveTeams({ teams: ["news", "research"] })).toEqual(["default", "news", "research"]);
  // an agent that redundantly lists default is not double-counted
  expect(effectiveTeams({ teams: ["default", "news"] })).toEqual(["default", "news"]);
});
