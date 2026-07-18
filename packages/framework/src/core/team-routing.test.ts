import { test, expect } from "bun:test";
import { routeToTeam } from "./team-routing";
import { TeamDef } from "@taicho/contracts/team";

const team = (over: Partial<TeamDef> = {}): TeamDef =>
  TeamDef.parse({ id: "news", charter: "covers breaking stories", created: "2026-07-10T00:00:00.000Z", ...over });

const members = [
  { id: "editor", role: "assigns and edits copy" },
  { id: "reporter", role: "files stories on deadline" },
  { id: "factchecker", role: "verifies claims and sources" },
];

test("a team with a lead routes to the lead", () => {
  const r = routeToTeam(team({ lead: "editor" }), members, "write a story", []);
  expect(r).toEqual({ ok: true, agentId: "editor", why: "lead" });
});

test("a leadless team routes to the best-ranked member, and says why", () => {
  const r = routeToTeam(team(), members, "verify these claims", []);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  expect(r.agentId).toBe("factchecker"); // 'verifies'/'claims' overlap
  expect(r.why).toContain("ranked");
});

test("a leadless team with no keyword match still routes — deterministically, and says so", () => {
  const r = routeToTeam(team(), members, "zzz qqq", []);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  expect(r.agentId).toBe("editor"); // first by id
  expect(r.why).toBe("no capability match; first member by id");
});

// --- the self-loop the resolution would otherwise create -------------------------------------------

test("a lead may not address its own team", () => {
  // editor leads news; editor delegating to `news` would resolve straight back to editor.
  const r = routeToTeam(team({ lead: "editor" }), members, "write a story", ["editor"]);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.error).toContain("a lead cannot address its own team");
});

test("an ancestor is never a routing candidate (a cycle the team id would have hidden)", () => {
  // reporter is already in the chain; the ranker must not hand the goal back to it.
  const r = routeToTeam(team(), members, "files stories deadline", ["root", "reporter"]);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  expect(r.agentId).not.toBe("reporter");
});

test("a team whose every member is already in the chain is an error, not a cycle", () => {
  const r = routeToTeam(team(), members, "anything", members.map((m) => m.id));
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.error).toContain("no member outside this delegation chain");
});

test("an empty team is an actionable error, not an ENOENT on loadAgent", () => {
  const r = routeToTeam(team(), [], "anything", []);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.error).toContain('team "news" has no members');
});

test("a lead that is not a member of the team it leads is rejected at routing time", () => {
  const r = routeToTeam(team({ lead: "quant" }), members, "anything", []);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.error).toContain('names lead "quant", which is not a member of it');
});
