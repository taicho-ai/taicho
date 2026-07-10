import { test, expect } from "bun:test";
import { visibleTo, visibleToRows, canDelegate, acl } from "./registry";
import type { AgentDef } from "../schemas/agent";

const mk = (id: string, over: Partial<AgentDef> = {}): AgentDef => ({
  id, role: `${id} role`, identity: "", tools: [], canSee: ["*"], canDelegateTo: ["*"],
  budgets: { maxIterationsPerRun: 30, maxWorkItemsPerRequest: 20 }, isRoot: false,
  created: "2026-06-11T00:00:00.000Z", ...over,
});

test("visibleTo excludes self and honors '*'", () => {
  const root = mk("root", { canSee: ["*"] });
  const all = [root, mk("a"), mk("b")];
  expect(visibleTo(root, all).map((x) => x.id).sort()).toEqual(["a", "b"]);
});

test("visibleTo respects an explicit allow-list", () => {
  const r = mk("r", { canSee: ["a"] });
  expect(visibleTo(r, [r, mk("a"), mk("b")]).map((x) => x.id)).toEqual(["a"]);
});

test("canDelegate honors '*' and explicit ids", () => {
  expect(canDelegate(mk("r", { canDelegateTo: ["*"] }), { id: "x" })).toBe(true);
  expect(canDelegate(mk("r", { canDelegateTo: ["a"] }), { id: "x" })).toBe(false);
});

test("visibleToRows filters registry rows by ACL without loading identities", () => {
  const rows = [
    { id: "root", role: "orchestrator", is_root: 1 },
    { id: "a", role: "ra", is_root: 0 },
    { id: "b", role: "rb", is_root: 0 },
  ];
  expect(visibleToRows(mk("root", { canSee: ["*"] }), rows).map((x) => x.id).sort()).toEqual(["a", "b"]);
  expect(visibleToRows(mk("x", { canSee: ["a"] }), rows).map((x) => x.id)).toEqual(["a"]);
});

// --- Plan 19: the `team:<id>` ACL production -------------------------------------------------------

test("an ACL entry written before Plan 19 keeps exactly the meaning it had", () => {
  // No agent id may contain a colon, so `team:` can never collide with a legacy exact-id entry.
  expect(acl(["*"], { id: "anyone" })).toBe(true);
  expect(acl(["a"], { id: "a", team: "news" })).toBe(true);   // exact id still wins regardless of team
  expect(acl(["a"], { id: "b", team: "news" })).toBe(false);
  expect(acl([], { id: "a" })).toBe(false);
});

test("`team:<id>` matches every member of that team, and nobody else", () => {
  expect(acl(["team:news"], { id: "reporter", team: "news" })).toBe(true);
  expect(acl(["team:news"], { id: "quant", team: "trading" })).toBe(false);
  expect(acl(["team:news"], { id: "root", team: null })).toBe(false);   // unaffiliated
  expect(acl(["team:news"], { id: "root" })).toBe(false);               // absent, not just null
  // an agent named `news` is NOT matched by `team:news` — ids and teams share a namespace, but the
  // ACL entry names a TEAM, and a target with no team affiliation cannot satisfy it.
  expect(acl(["team:news"], { id: "news" })).toBe(false);
});

test("visibility defaults for a team member scope the roster to its own team", () => {
  const reporter = mk("reporter", { team: "news", canSee: ["team:news"] });
  const rows = [
    { id: "reporter", role: "files stories", is_root: 0, team: "news" },
    { id: "factchecker", role: "verifies claims", is_root: 0, team: "news" },
    { id: "quant", role: "prices instruments", is_root: 0, team: "trading" },
    { id: "root", role: "orchestrator", is_root: 1, team: null },
  ];
  // self excluded, own team included, other teams and unaffiliated agents invisible
  expect(visibleToRows(reporter, rows).map((r) => r.id)).toEqual(["factchecker"]);
});

test("canDelegate to a TEAM requires `team:<id>` or '*', never a bare agent id", () => {
  const root = mk("root", { canDelegateTo: ["*"] });
  const editor = mk("editor", { team: "news", canDelegateTo: ["team:news"] });
  const outsider = mk("quant", { team: "trading", canDelegateTo: ["reporter"] });

  expect(canDelegate(root, { id: "news", isTeam: true })).toBe(true);
  expect(canDelegate(editor, { id: "news", isTeam: true })).toBe(true);
  // an exact-id grant for a MEMBER does not confer the right to address the team as a whole
  expect(canDelegate(outsider, { id: "news", isTeam: true })).toBe(false);
  expect(canDelegate(outsider, { id: "reporter", team: "news" })).toBe(true);
});

test("`team:<id>` in canDelegateTo grants the team AND its members (a lead reaching its own people)", () => {
  const editor = mk("editor", { team: "news", canDelegateTo: ["team:news"] });
  expect(canDelegate(editor, { id: "reporter", team: "news" })).toBe(true);
  expect(canDelegate(editor, { id: "quant", team: "trading" })).toBe(false);
});
