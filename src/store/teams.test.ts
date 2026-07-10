import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { paths } from "./files";
import { createTeam, loadTeam, listTeams, teamExists, membersOf, validateTeams, parseTeam, serializeTeam, assertPolicyRespectsFloor } from "./teams";
import { syncRegistry } from "../core/registry";
import { DEFAULT_WORKER_TOOLS } from "./roster";
import { AgentDef } from "../schemas/agent";
import { TeamDef } from "../schemas/team";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-teams-"));
const agent = (id: string, team?: string): AgentDef =>
  AgentDef.parse({ id, role: `${id} role`, identity: "i", team, created: new Date().toISOString() });

test("serialize/parse round-trips a team, keeping the charter body out of the frontmatter", () => {
  const t = TeamDef.parse({ id: "news", charter: "covers breaking stories", lead: "editor", charterBody: "Accurate before fast.", created: new Date().toISOString() });
  const text = serializeTeam(t);
  expect(text).toContain("id: news");
  expect(text).not.toContain("charterBody"); // the body is the markdown, not a frontmatter key
  const back = parseTeam(text);
  expect(back.charterBody).toBe("Accurate before fast.");
  expect(back.lead).toBe("editor");
  expect(back.tools).toEqual({ grant: [], deny: [] });
});

test("createTeam writes teams/<id>/team.md and listTeams scans it back", () => {
  const w = ws();
  createTeam(w, { id: "news", charter: "covers breaking stories" });
  createTeam(w, { id: "trading", charter: "prices and risks instruments" });
  expect(teamExists(w, "news")).toBe(true);
  expect(loadTeam(w, "news")?.charter).toBe("covers breaking stories");
  expect(loadTeam(w, "nope")).toBeNull();
  expect(listTeams(w).map((t) => t.id)).toEqual(["news", "trading"]); // sorted, deterministic
});

test("createTeam refuses a duplicate id and an id an agent already holds (one namespace)", () => {
  const w = ws();
  createTeam(w, { id: "news", charter: "c" });
  expect(() => createTeam(w, { id: "news", charter: "c" })).toThrow(/already exists/);

  mkdirSync(paths.agentDir(w, "quant"), { recursive: true });
  writeFileSync(paths.agentFile(w, "quant"), "---\nid: quant\n---\nbody\n");
  expect(() => createTeam(w, { id: "quant", charter: "c" })).toThrow(/one namespace/);
});

// --- Plan 14's floor is not a team's to punch through ---------------------------------------------

test("a team that denies a DEFAULT_WORKER_TOOLS entry is rejected at load, naming the tool", () => {
  const w = ws();
  expect(() => createTeam(w, { id: "news", charter: "c", tools: { deny: ["write_artifact"] } })).toThrow(/write_artifact/);
  expect(() => createTeam(w, { id: "news", charter: "c", tools: { deny: ["write_artifact"] } })).toThrow(/every worker must keep/);
  // denying a privileged tool is fine — that's the whole point of a deny list
  expect(() => createTeam(w, { id: "ok", charter: "c", tools: { deny: ["run_command"] } })).not.toThrow();
});

test("assertPolicyRespectsFloor guards every entry of the baseline, not just the first", () => {
  for (const tool of DEFAULT_WORKER_TOOLS) {
    const t = TeamDef.parse({ id: "t", charter: "c", tools: { deny: [tool] }, created: new Date().toISOString() });
    expect(() => assertPolicyRespectsFloor(t)).toThrow(new RegExp(tool));
  }
});

test("listTeams skips a malformed team.md rather than taking boot down with it", () => {
  const w = ws();
  createTeam(w, { id: "good", charter: "c" });
  mkdirSync(paths.teamDir(w, "bad"), { recursive: true });
  writeFileSync(paths.teamFile(w, "bad"), "no frontmatter here");
  expect(listTeams(w).map((t) => t.id)).toEqual(["good"]);
});

// --- membership is derived, never stored twice ----------------------------------------------------

test("membersOf reads the registry's team column — the derived index of agent.md's `team:`", () => {
  const w = ws();
  const db = openDb(w);
  syncRegistry(db, [agent("root"), agent("reporter", "news"), agent("factchecker", "news"), agent("quant", "trading")]);
  expect(membersOf(db, "news").map((m) => m.id)).toEqual(["factchecker", "reporter"]); // sorted
  expect(membersOf(db, "trading").map((m) => m.id)).toEqual(["quant"]);
  expect(membersOf(db, "empty")).toEqual([]);
});

test("validateTeams flags a lead that is missing, or sits on a different team", () => {
  const w = ws();
  const db = openDb(w);
  createTeam(w, { id: "news", charter: "c", lead: "editor" });
  createTeam(w, { id: "trading", charter: "c", lead: "ghost" });
  createTeam(w, { id: "ops", charter: "c" }); // leadless — always valid
  syncRegistry(db, [agent("editor", "trading")]); // editor leads news but sits on trading

  const problems = validateTeams(w, db);
  expect(problems).toHaveLength(2);
  expect(problems.find((p) => p.team === "news")?.problem).toContain('it must declare "news"');
  expect(problems.find((p) => p.team === "trading")?.problem).toContain("is not an agent");
  expect(problems.find((p) => p.team === "ops")).toBeUndefined();
});

test("validateTeams passes when the lead sits on the team it leads", () => {
  const w = ws();
  const db = openDb(w);
  createTeam(w, { id: "news", charter: "c", lead: "editor" });
  syncRegistry(db, [agent("editor", "news")]);
  expect(validateTeams(w, db)).toEqual([]);
});
