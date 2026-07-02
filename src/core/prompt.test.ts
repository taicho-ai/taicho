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
