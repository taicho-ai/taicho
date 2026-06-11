import { test, expect } from "bun:test";
import { runSlash } from "./slash";
import type { RunTrace } from "../schemas/trace";

const roster = [{ id: "root", role: "orch", is_root: 1 }, { id: "w", role: "writes", is_root: 0 }];
const trace = (id: string): RunTrace => ({
  id, agent: id.split("/")[0], task: "t", triggeredBy: "user",
  ledger: { retrieved: [], applied: [], skipped: [] },
  toolCalls: [{ tool: "write_artifact", count: 1 }], artifacts: ["a.md"], delegatedOut: [],
  outcome: "completed", tokens: 5, costUsd: 0.01, notes: [], durationMs: 1, started: "2026-06-11T00:00:00.000Z",
});
const deps = {
  roster,
  listTraces: (a?: string) => (a ? [trace(`${a}/2026-06-11-run1`)] : [trace("root/2026-06-11-run1"), trace("w/2026-06-11-run1")]),
  readTrace: (id: string) => { if (id === "missing") throw new Error("nope"); return trace(id); },
  listPolicies: (a: string) => a === "w" ? [{ id: "pol_1", agent: "w", when: "x", do: "y", scope: "agent", status: "approved", taughtBy: "user", created: "2026-06-11T00:00:00.000Z", expanded: [] } as any] : [],
  deletePolicy: (_a: string, p: string) => p === "pol_1",
};

test("/help lists the grammar", () => { expect(runSlash("help", "", deps)[0].text).toMatch(/agents/); });
test("/agents lists roster with root marked", () => {
  const out = runSlash("agents", "", deps).map((l) => l.text);
  expect(out.some((t) => t.includes("* root"))).toBe(true);
  expect(out.some((t) => t.includes("- w"))).toBe(true);
});
test("/runs lists all; /runs <agent> filters", () => {
  expect(runSlash("runs", "", deps).length).toBe(2);
  expect(runSlash("runs", "w", deps).length).toBe(1);
});
test("/runs with no runs -> message", () => {
  expect(runSlash("runs", "", { ...deps, listTraces: () => [] })[0].text).toContain("no runs");
});
test("/trace shows details; missing -> friendly", () => {
  expect(runSlash("trace", "root/2026-06-11-run1", deps)[0].text).toContain("outcome=");
  expect(runSlash("trace", "missing", deps)[0].text).toContain("no such trace");
});
test("unknown command -> message", () => { expect(runSlash("frob", "", deps)[0].text).toContain("unknown command"); });

test("/policies lists an agent's notes; empty -> message", () => {
  expect(runSlash("policies", "w", deps)[0].text).toContain("pol_1");
  expect(runSlash("policies", "none", deps)[0].text).toContain("no policies");
});
test("/forget deletes by id; missing -> message; bad usage -> hint", () => {
  expect(runSlash("forget", "w pol_1", deps)[0].text).toContain("forgot");
  expect(runSlash("forget", "w nope", deps)[0].text).toContain("no such policy");
  expect(runSlash("forget", "w", deps)[0].text).toContain("usage");
});
