import { test, expect } from "bun:test";
import { visibleTo, canDelegate } from "./registry";
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
  expect(canDelegate(mk("r", { canDelegateTo: ["*"] }), "x")).toBe(true);
  expect(canDelegate(mk("r", { canDelegateTo: ["a"] }), "x")).toBe(false);
});
