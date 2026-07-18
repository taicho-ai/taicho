import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendWorkflowEvent, readWorkflowEvents, foldWorkflowRun,
  reserveWorkflowRun, reconcileWorkflowRuns, listWorkflowRunIds,
  parkGate, readParkedGate, clearParkedGate, listParkedGates,
} from "./file-journal";
import { parseWorkflowDef } from "./schema";

const mkws = () => mkdtempSync(join(tmpdir(), "taicho-wf-"));
const def = parseWorkflowDef({
  id: "daily-brief", team: "news", version: 1,
  steps: [
    { id: "research", run: "@researcher", produces: "sources" },
    { id: "draft", run: "@writer", consumes: ["sources"], produces: "draft" },
  ],
});

test("appendWorkflowEvent then readWorkflowEvents round-trips events in order, stamping ts", () => {
  const w = mkws(); const runId = "wr_test_1";
  appendWorkflowEvent(w, def.id, runId, { step: "research", status: "running", runId });
  appendWorkflowEvent(w, def.id, runId, { step: "research", status: "done", runId, produced: "sources@v1" });
  const evs = readWorkflowEvents(w, def.id, runId);
  expect(evs).toHaveLength(2);
  expect(evs[1]).toMatchObject({ step: "research", status: "done", produced: "sources@v1" });
  expect(typeof evs[1]!.ts).toBe("string");
});

test("foldWorkflowRun: last event per step wins; steps with no event are pending", () => {
  const w = mkws(); const runId = "wr_test_2";
  appendWorkflowEvent(w, def.id, runId, { step: "research", status: "running", runId });
  appendWorkflowEvent(w, def.id, runId, { step: "research", status: "done", runId, produced: "sources@v1" });
  const state = foldWorkflowRun(w, def, runId);
  expect(state.steps.find((s) => s.id === "research")).toMatchObject({ status: "done", produced: "sources@v1" });
  expect(state.steps.find((s) => s.id === "draft")).toMatchObject({ status: "pending" });
});

test("foldWorkflowRun overall status is running while a step is pending, done when all steps are done", () => {
  const w = mkws(); const runId = "wr_test_3";
  appendWorkflowEvent(w, def.id, runId, { step: "research", status: "done", runId });
  expect(foldWorkflowRun(w, def, runId).status).toBe("running");
  appendWorkflowEvent(w, def.id, runId, { step: "draft", status: "done", runId });
  expect(foldWorkflowRun(w, def, runId).status).toBe("done");
});

test("foldWorkflowRun overall status is failed when any step failed", () => {
  const w = mkws(); const runId = "wr_test_4";
  appendWorkflowEvent(w, def.id, runId, { step: "research", status: "failed", runId, note: "check failed" });
  expect(foldWorkflowRun(w, def, runId).status).toBe("failed");
});

test("reserveWorkflowRun mints a unique run id and creates its run directory", () => {
  const w = mkws();
  const a = reserveWorkflowRun(w, def.id);
  const b = reserveWorkflowRun(w, def.id);
  expect(a).not.toBe(b);
  expect(listWorkflowRunIds(w, def.id).sort()).toEqual([a, b].sort());
});

test("reconcileWorkflowRuns marks an in-flight step interrupted at boot, and reports it", () => {
  const w = mkws(); const runId = reserveWorkflowRun(w, def.id);
  appendWorkflowEvent(w, def.id, runId, { step: "research", status: "running", runId });
  const reconciled = reconcileWorkflowRuns(w);
  expect(reconciled).toContainEqual({ wfId: def.id, runId, step: "research" });
  expect(foldWorkflowRun(w, def, runId).steps.find((s) => s.id === "research")!.status).toBe("interrupted");
});

test("reconcileWorkflowRuns leaves already-terminal steps alone", () => {
  const w = mkws(); const runId = reserveWorkflowRun(w, def.id);
  appendWorkflowEvent(w, def.id, runId, { step: "research", status: "done", runId });
  expect(reconcileWorkflowRuns(w)).toHaveLength(0);
});

test("parkGate persists a gate; readParkedGate returns it; clearParkedGate removes it", () => {
  const w = mkws(); const runId = reserveWorkflowRun(w, def.id);
  parkGate(w, def.id, runId, { step: "signoff", title: "editor sign-off", choices: ["approve", "revise"] });
  const g = readParkedGate(w, def.id, runId);
  expect(g).toMatchObject({ step: "signoff", title: "editor sign-off", choices: ["approve", "revise"] });
  expect(typeof g!.at).toBe("string");
  clearParkedGate(w, def.id, runId);
  expect(readParkedGate(w, def.id, runId)).toBeNull();
});

test("listParkedGates finds every parked run across workflows", () => {
  const w = mkws();
  const r1 = reserveWorkflowRun(w, def.id);
  parkGate(w, def.id, r1, { step: "signoff", title: "sign-off", choices: ["approve"] });
  const parked = listParkedGates(w);
  expect(parked).toContainEqual(expect.objectContaining({ wfId: def.id, runId: r1 }));
});

test("a parked run folds to status 'parked' (until the gate is cleared)", () => {
  const w = mkws(); const runId = reserveWorkflowRun(w, def.id);
  appendWorkflowEvent(w, def.id, runId, { step: "research", status: "done", runId });
  appendWorkflowEvent(w, def.id, runId, { step: "draft", status: "running", runId }); // at the gate/in-flight
  parkGate(w, def.id, runId, { step: "draft", title: "review", choices: ["approve"] });
  expect(foldWorkflowRun(w, def, runId).status).toBe("parked");
  clearParkedGate(w, def.id, runId);
  expect(foldWorkflowRun(w, def, runId).status).toBe("running"); // no longer parked
});
