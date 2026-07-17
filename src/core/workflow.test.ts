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

// ── Phase 2: check nodes ─────────────────────────────────────────────────────
const withCheck = parseWorkflowDef({
  id: "wc", team: "t", version: 1,
  steps: [
    { id: "research", run: "@r", produces: "sources" },
    { id: "verify", check: "≥3 sources", on_fail: "research", max_attempts: 2 },
    { id: "draft", run: "@w", consumes: ["sources"], produces: "draft" },
  ],
});

test("a check that passes advances to the next step", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  const runCheck = async () => ({ pass: true, reasons: [] });
  const state = await executeWorkflow({ ws: w, runAgent, runCheck }, withCheck);
  expect(calls.map((c) => c.id)).toEqual(["research", "draft"]);
  expect(state.steps.find((s) => s.id === "verify")!.status).toBe("done");
  expect(state.status).toBe("done");
});

test("a failing check loops back to on_fail, bounded by max_attempts, then stops failed", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  let checks = 0;
  const runCheck = async () => { checks++; return { pass: false, reasons: ["only 2 sources"] }; };
  const state = await executeWorkflow({ ws: w, runAgent, runCheck }, withCheck);
  expect(checks).toBe(2); // max_attempts
  expect(calls.map((c) => c.id)).toEqual(["research", "research"]); // looped once, draft never
  expect(state.status).toBe("failed");
  expect(state.steps.find((s) => s.id === "draft")!.status).toBe("pending");
});

test("a check verifies the last produced artifact by default", async () => {
  const w = mkws();
  const { runAgent } = recorder();
  let target: string | undefined;
  const runCheck = async (a: { target?: string }) => { target = a.target; return { pass: true, reasons: [] }; };
  await executeWorkflow({ ws: w, runAgent, runCheck }, withCheck);
  expect(target).toBe("sources@v1");
});

// ── Phase 2: human gates ─────────────────────────────────────────────────────
const withGate = parseWorkflowDef({
  id: "wg", team: "t", version: 1,
  steps: [
    { id: "draft", run: "@w", produces: "draft" },
    { id: "signoff", human: "sign-off", choices: ["approve", "revise"], routes: { revise: "draft" } },
    { id: "publish", run: "@e", consumes: ["draft"], produces: "article" },
  ],
});

test("a human gate presents upstream artifacts and routes approve → the next step", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  let packet: { items: { name: string }[] } | undefined;
  const requestGate = async (a: { packet: { items: { name: string }[] } }) => { packet = a.packet; return { choice: "approve" }; };
  const state = await executeWorkflow({ ws: w, runAgent, requestGate }, withGate);
  expect(calls.map((c) => c.id)).toEqual(["draft", "publish"]);
  expect(packet!.items.map((i) => i.name)).toContain("draft");
  expect(state.steps.find((s) => s.id === "signoff")!.choice).toBe("approve");
  expect(state.status).toBe("done");
});

test("a human gate 'revise' choice loops back to the routed step, then continues on approve", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  let asked = 0;
  const requestGate = async () => { asked++; return asked === 1 ? { choice: "revise", note: "tighten the lede" } : { choice: "approve" }; };
  const state = await executeWorkflow({ ws: w, runAgent, requestGate }, withGate);
  expect(calls.map((c) => c.id)).toEqual(["draft", "draft", "publish"]);
  expect(state.status).toBe("done");
});

test("a cancelled human gate (null decision) interrupts the run", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  const requestGate = async () => null;
  const state = await executeWorkflow({ ws: w, runAgent, requestGate }, withGate);
  expect(calls.map((c) => c.id)).toEqual(["draft"]);
  expect(state.steps.find((s) => s.id === "signoff")!.status).toBe("interrupted");
  expect(state.status).toBe("interrupted");
});

// ── Phase 3: branch + parallel ───────────────────────────────────────────────
const withBranch = parseWorkflowDef({
  id: "wb", team: "t", version: 1,
  steps: [
    { id: "triage", branch: "@classifier", routes: { bug: "fix", question: "answer" } },
    { id: "fix", run: "@dev", produces: "patch" },
    { id: "answer", run: "@support", produces: "reply" },
  ],
});

test("a branch routes to the step chosen by the classifier; the untaken step is skipped", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  const classify = async () => "question";
  const state = await executeWorkflow({ ws: w, runAgent, classify }, withBranch);
  expect(calls.map((c) => c.id)).toEqual(["answer"]);
  expect(state.steps.find((s) => s.id === "triage")!.choice).toBe("question");
  expect(state.steps.find((s) => s.id === "fix")!.status).toBe("skipped");
  expect(state.status).toBe("done");
});

const withParallel = parseWorkflowDef({
  id: "wp", team: "t", version: 1,
  steps: [
    {
      id: "fan",
      branches: [{ id: "a", run: "@a", produces: "ra" }, { id: "b", run: "@b", produces: "rb" }],
      join: "@merger",
      produces: "report",
    },
    { id: "ship", run: "@shipper", consumes: ["report"], produces: "shipped" },
  ],
});

test("a parallel step fans out its branches then joins, threading the report into the next step", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  const state = await executeWorkflow({ ws: w, runAgent }, withParallel);
  expect(calls.map((c) => c.id).sort()).toEqual(["a", "b", "fan__join", "ship"]);
  expect(calls.find((c) => c.id === "ship")!.inputs).toEqual(["report@v1"]);
  expect(state.status).toBe("done");
  expect(state.steps.find((s) => s.id === "fan")!.status).toBe("done");
});

test("a parallel step fails the workflow if any branch fails", async () => {
  const w = mkws();
  const { runAgent } = recorder({ b: "failed" });
  const state = await executeWorkflow({ ws: w, runAgent }, withParallel);
  expect(state.steps.find((s) => s.id === "fan")!.status).toBe("failed");
  expect(state.status).toBe("failed");
});

const withOver = parseWorkflowDef({
  id: "wo", team: "t", version: 1,
  steps: [
    { id: "gather", run: "@lister", produces: "companies" },
    { id: "analyze", over: "companies", as: { id: "one", run: "@analyst", produces: "analysis" }, join: "@synth", produces: "report" },
    { id: "ship", run: "@shipper", consumes: ["report"] },
  ],
});

test("a parallel 'over' step maps each item of a list, runs 'as' per item, then joins", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  const listItems = async () => ["Acme", "Globex", "Initech"];
  const state = await executeWorkflow({ ws: w, runAgent, listItems }, withOver);
  expect(calls.filter((c) => /^analyze_\d+$/.test(c.id)).length).toBe(3); // one run per item
  expect(calls.some((c) => c.id === "analyze__join")).toBe(true);
  expect(calls.some((c) => c.id === "ship")).toBe(true);
  expect(state.status).toBe("done");
});

test("a parallel 'over' passes each item into its per-item step brief", async () => {
  const w = mkws();
  const { calls, runAgent } = recorder();
  const listItems = async () => ["Acme"];
  await executeWorkflow({ ws: w, runAgent, listItems }, withOver);
  expect(calls.find((c) => c.id === "analyze_0")!.brief).toContain("Acme");
});
