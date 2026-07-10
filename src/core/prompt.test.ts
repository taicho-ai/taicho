import { test, expect } from "bun:test";
import { assemble, INLINE_ROSTER_MAX } from "./prompt";
import type { AgentDef } from "../schemas/agent";

const agent: AgentDef = {
  id: "root", role: "orchestrator", identity: "I orchestrate.", tools: ["find_agents"],
  canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 30, maxWorkItemsPerRequest: 20 },
  isRoot: true, created: "2026-06-11T00:00:00.000Z",
};
const mkVisible = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, role: `role ${i}` }));

test("small roster is listed inline", () => {
  const { system } = assemble(agent, { visibleAgents: mkVisible(3), policies: [] });
  expect(system).toContain("a0: role 0");
  expect(system).toContain("delegate with delegate_task");
});

test("large roster switches to a find_agents instruction, not a dump", () => {
  const { system } = assemble(agent, { visibleAgents: mkVisible(INLINE_ROSTER_MAX + 1), policies: [] });
  expect(system).not.toContain("a0: role 0");
  expect(system).toContain("find_agents");
  expect(system).toContain(String(INLINE_ROSTER_MAX + 1));
});

test("assemble renders a memoryBlock in the context tier when provided", () => {
  const { system } = assemble(agent, { visibleAgents: [], policies: [], memoryBlock: "## Your recent runs\n- did x" });
  expect(system).toContain("Your recent runs");
});

test("assemble includes a skills block in the volatile tier when provided", () => {
  const { system, sections } = assemble(agent, { visibleAgents: [], policies: [], skillsBlock: "## Skills available (call use_skill(name)…)\n- deploy: ship to prod" });
  expect(system).toContain("Skills available");
  expect(system).toContain("deploy: ship to prod");
  expect(sections.find((s) => s.name === "skills")?.tier).toBe("volatile");
});

test("root gets the Operating taicho context block (workspace + commands + CLI), in the stable tier", () => {
  const { system, sections } = assemble(agent, { visibleAgents: [], policies: [] });
  expect(system).toContain("## Operating taicho");
  expect(system).toContain("kb/sources");          // workspace layout
  expect(system).toContain("/kb sync");            // command surface
  expect(system).toContain("run_command");         // CLI usage
  const op = sections.find((s) => s.name === "operating");
  expect(op?.tier).toBe("stable");                 // stable → doesn't churn the prefix cache
});

test("a non-root agent does NOT carry the Operating taicho block (root-only orientation)", () => {
  const worker: AgentDef = { ...agent, id: "researcher", role: "researches", isRoot: false };
  const { system, sections } = assemble(worker, { visibleAgents: [], policies: [] });
  expect(system).not.toContain("## Operating taicho");
  expect(system).not.toContain("run_command");
  expect(sections.find((s) => s.name === "operating")).toBeUndefined();
});

// --- Plan 19: the roster shows teams, not their members -------------------------------------------

const worker = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "reporter", role: "files stories", identity: "I report.", tools: [],
  canSee: ["team:news"], canDelegateTo: [], budgets: { maxIterationsPerRun: 30, maxWorkItemsPerRequest: 20 },
  isRoot: false, created: "2026-06-11T00:00:00.000Z", ...over,
});

const NEWS = { id: "news", charter: "covers breaking stories", lead: "editor", memberCount: 4 };
const TRADING = { id: "trading", charter: "prices and risks instruments", memberCount: 6 };

test("a squad with no teams renders the pre-Plan-19 roster unchanged", () => {
  const { system } = assemble(agent, { visibleAgents: mkVisible(3), teams: [], policies: [] });
  expect(system).toContain("## Your squad (delegate with delegate_task)\n- a0: role 0\n- a1: role 1\n- a2: role 2");
  expect(system).not.toContain("### Teams");
  expect(system).not.toContain("### Direct reports");
});

test("a squad with no teams keeps the >30 find_agents hint", () => {
  const { system } = assemble(agent, { visibleAgents: mkVisible(INLINE_ROSTER_MAX + 1), teams: [], policies: [] });
  expect(system).toContain("too many to list");
  expect(system).toContain("find_agents(query)");
});

test("root's roster renders TEAMS in place of their members — the 30-agent cliff becomes unreachable", () => {
  // 60 agents on the squad, all accounted for by two teams: the caller passes zero loose agents.
  const { system } = assemble(agent, {
    visibleAgents: [],
    teams: [NEWS, TRADING],
    policies: [],
  });
  expect(system).toContain("## Your squad (delegate with delegate_task)");
  expect(system).toContain("### Teams — address the team, not its members");
  expect(system).toContain("- news: covers breaking stories\n  lead: editor · 4 agents");
  expect(system).toContain("- trading: prices and risks instruments\n  6 agents · routed by capability");
  expect(system).not.toContain("too many to list"); // 60 agents, and the hint never fires
  expect(system).not.toContain("### Direct reports");
});

test("agents no team accounts for are listed as direct reports, below the teams", () => {
  const { system } = assemble(agent, {
    visibleAgents: [{ id: "librarian", role: "curates squad knowledge" }],
    teams: [NEWS],
    policies: [],
  });
  const teamsAt = system.indexOf("### Teams");
  const reportsAt = system.indexOf("### Direct reports");
  expect(teamsAt).toBeGreaterThan(-1);
  expect(reportsAt).toBeGreaterThan(teamsAt); // teams first — that's the address root should reach for
  expect(system).toContain("- librarian: curates squad knowledge");
});

test("a member's roster is headed 'Your team', not 'Your squad'", () => {
  const { system } = assemble(worker(), {
    visibleAgents: [{ id: "factchecker", role: "verifies claims" }],
    teams: [],
    policies: [],
  });
  expect(system).toContain("## Your team (delegate with delegate_task)");
  expect(system).not.toContain("## Your squad");
});

test("the team charter is injected as its own context-tier section", () => {
  const { system, sections } = assemble(worker(), {
    visibleAgents: [],
    teams: [],
    teamCharter: "Accurate before fast. Two independent sources.",
    policies: [],
  });
  expect(system).toContain("## Your team's charter\nAccurate before fast. Two independent sources.");
  const charter = sections.find((s) => s.name === "team-charter");
  expect(charter?.tier).toBe("context");
});

test("no charter section when the agent sits on no team", () => {
  const { sections } = assemble(agent, { visibleAgents: [], teams: [], policies: [] });
  expect(sections.find((s) => s.name === "team-charter")).toBeUndefined();
});
