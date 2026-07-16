import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkflow, type WorkflowExecDeps } from "./workflow";
import { parseWorkflowDef } from "../schemas/workflow";

const mkws = () => mkdtempSync(join(tmpdir(), "taicho-wfx-"));

const twoStep = parseWorkflowDef({
  id: "daily-brief", team: "news", version: 1, brief: "the workflow brief",
  steps: [
    { id: "research", run: "@researcher", produces: "sources", brief: "find sources" },
    { id: "draft", run: "@writer", consumes: ["sources"], produces: "draft" },
  ],
});

function recorder(overrides: Record<string, "completed" | "failed"> = {}) {
  const calls: { id: string; inputs: string[]; brief: string; triggeredBy: string }[] = [];
  const runAgent: WorkflowExecDeps["runAgent"] = async (a) => {
    calls.push({ id: a.step.id, inputs: a.inputs, brief: a.brief, triggeredBy: a.triggeredBy });
    return {
      childRunId: `run_${a.step.id}`,
      outcome: overrides[a.step.id] ?? "completed",
      produced: a.step.produces ? `${a.step.produces}@v1` : undefined,
    };
  };
  return { calls, runAgent };
}

test("runs agent steps in order, threading a produced artifact into the next step's inputs", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  const state = await executeWorkflow({ ws: w, runAgent }, twoStep);
  expect(calls.map((c) => c.id)).toEqual(["research", "draft"]);
  expect(calls[0]!.inputs).toEqual([]);
  expect(calls[1]!.inputs).toEqual(["sources@v1"]);
  expect(state.status).toBe("done");
  expect(state.steps.every((s) => s.status === "done")).toBe(true);
});

test("stops when a step fails and leaves later steps pending", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder({ research: "failed" });
  const state = await executeWorkflow({ ws: w, runAgent }, twoStep);
  expect(calls.map((c) => c.id)).toEqual(["research"]);
  expect(state.status).toBe("failed");
  expect(state.steps.find((s) => s.id === "research")!.status).toBe("failed");
  expect(state.steps.find((s) => s.id === "draft")!.status).toBe("pending");
});

test("each agent receives the workflow brief and its own step brief, tagged by workflow:<id>:<step>", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  await executeWorkflow({ ws: w, runAgent }, twoStep);
  expect(calls[0]!.brief).toContain("the workflow brief");
  expect(calls[0]!.brief).toContain("find sources");
  expect(calls[0]!.triggeredBy).toBe("workflow:daily-brief:research");
});

test("an already-aborted signal interrupts before running any step", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  const ctrl = new AbortController();
  ctrl.abort();
  const state = await executeWorkflow({ ws: w, runAgent, signal: ctrl.signal }, twoStep);
  expect(calls).toHaveLength(0);
  expect(state.status).toBe("interrupted");
});

test("the run is recorded as events that fold back to each produced handle", async () => {
  const w = mkws();
  const { runAgent } = recorder();
  const state = await executeWorkflow({ ws: w, runAgent }, twoStep);
  expect(state.steps.find((s) => s.id === "research")!.produced).toBe("sources@v1");
  expect(state.steps.find((s) => s.id === "draft")!.produced).toBe("draft@v1");
});

test("input artifacts are available to the first step that consumes them", async () => {
  const w = mkws();
  const def = parseWorkflowDef({
    id: "wf2", team: "t", version: 1,
    steps: [{ id: "use", run: "@a", consumes: ["seed"] }],
  });
  const { calls, runAgent } = recorder();
  await executeWorkflow({ ws: w, runAgent }, def, { artifacts: [{ name: "seed", handle: "seed@v3" }] });
  expect(calls[0]!.inputs).toEqual(["seed@v3"]);
});
