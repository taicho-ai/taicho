import { test, expect } from "bun:test";
import { rollupCosts, formatCostRollup } from "./costs";
import type { RunTrace } from "../schemas/trace";

/** A minimal trace: only the fields the rollup reads matter; the rest are schema-valid filler. */
function trace(over: Partial<RunTrace>): RunTrace {
  return {
    id: over.id ?? "x/2026-07-04-run1",
    agent: "root",
    task: "t",
    triggeredBy: "user",
    ledger: { retrieved: [], applied: [], skipped: [], knowledge: [], skills: [] },
    toolCalls: [],
    artifacts: [],
    inputArtifacts: [],
    outputArtifacts: [],
    delegatedOut: [],
    verification: [],
    outcome: "completed",
    tokens: 0,
    costUsd: 0,
    verifierTokens: 0,
    verifierCostUsd: 0,
    notes: [],
    durationMs: 0,
    started: "2026-07-04T10:00:00.000Z",
    ...over,
  };
}

test("rollup sums each run's OWN spend by agent, day, and model", () => {
  const traces = [
    trace({ agent: "root", tokens: 100, costUsd: 1, model: "claude-sonnet-4-6", started: "2026-07-04T09:00:00.000Z" }),
    trace({ agent: "root", tokens: 50, costUsd: 0.5, model: "claude-sonnet-4-6", started: "2026-07-04T11:00:00.000Z" }),
    trace({ agent: "writer", tokens: 200, costUsd: 2, model: "gpt-5.5", started: "2026-07-05T09:00:00.000Z" }),
  ];
  const r = rollupCosts(traces);

  expect(r.totals).toMatchObject({ runs: 3, tokens: 350, costUsd: 3.5, subscriptionRuns: 0 });

  const root = r.byAgent.find((g) => g.key === "root")!;
  expect(root).toMatchObject({ runs: 2, tokens: 150, costUsd: 1.5 });
  expect(r.byAgent.find((g) => g.key === "writer")).toMatchObject({ tokens: 200, costUsd: 2 });

  expect(r.byDay.find((g) => g.key === "2026-07-04")).toMatchObject({ runs: 2, tokens: 150 });
  expect(r.byDay.find((g) => g.key === "2026-07-05")).toMatchObject({ runs: 1, tokens: 200 });

  expect(r.byModel.find((g) => g.key === "claude-sonnet-4-6")).toMatchObject({ tokens: 150, costUsd: 1.5 });
  expect(r.byModel.find((g) => g.key === "gpt-5.5")).toMatchObject({ tokens: 200, costUsd: 2 });
});

test("a subscription run (costUsd:null) reports TOKENS and is never counted as $0", () => {
  const traces = [
    trace({ agent: "root", tokens: 100, costUsd: 5, model: "gpt-5.5" }),
    trace({ agent: "root", tokens: 300, costUsd: null, costNote: "subscription", model: "gpt-5.5" }),
  ];
  const r = rollupCosts(traces);

  // USD total counts ONLY the priced run; tokens count both (honest).
  expect(r.totals.tokens).toBe(400);
  expect(r.totals.costUsd).toBe(5);
  expect(r.totals.subscriptionRuns).toBe(1);

  const group = r.byModel.find((g) => g.key === "gpt-5.5")!;
  expect(group.tokens).toBe(400);       // subscription tokens are NOT dropped
  expect(group.costUsd).toBe(5);        // ...but its (null) cost never becomes a $0 in the USD sum
  expect(group.subscriptionRuns).toBe(1);
});

test("subscription without a model id groups under 'subscription' via costNote", () => {
  const r = rollupCosts([trace({ tokens: 42, costUsd: null, costNote: "subscription" })]);
  expect(r.byModel[0]).toMatchObject({ key: "subscription", tokens: 42, subscriptionRuns: 1 });
});

test("formatCostRollup leads with tokens and never prints a fabricated $0 for subscription runs", () => {
  const lines = formatCostRollup(rollupCosts([
    trace({ agent: "root", tokens: 100, costUsd: 2, model: "gpt-5.5" }),
    trace({ agent: "root", tokens: 300, costUsd: null, costNote: "subscription", model: "codex" }),
  ])).join("\n");

  expect(lines).toContain("400 tok");             // total tokens, honest
  expect(lines).toContain("$2.0000 priced");      // priced USD, labelled as such
  expect(lines).toContain("subscription run(s)"); // subscription surfaced explicitly
  expect(lines).not.toContain("$0.00");           // no fabricated zero-dollar cost anywhere
});

test("empty rollup is honest about having nothing to cost", () => {
  expect(formatCostRollup(rollupCosts([]))).toEqual(["  (no runs yet — nothing to cost)"]);
});
