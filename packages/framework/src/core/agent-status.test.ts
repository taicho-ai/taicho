import { test, expect } from "bun:test";
import { statusReducer, statusList, type StatusMap } from "./agent-status";
import type { StepEvent } from "@taicho/agent";

const ev = (phase: StepEvent["phase"], runId: string, agent: string, extra: Partial<StepEvent> = {}): StepEvent =>
  ({ phase, runId, agent, ...extra });

/** Apply a sequence of events with a monotonically advancing clock. */
function run(events: StepEvent[]): StatusMap {
  let map: StatusMap = new Map();
  let now = 1000;
  for (const e of events) map = statusReducer(map, e, (now += 10));
  return map;
}

test("model_start → thinking; delta → writing; final drops the run", () => {
  const afterThink = run([ev("model_start", "root/1", "root")]);
  expect(afterThink.get("root/1")!.state).toBe("thinking");
  const afterWrite = run([ev("model_start", "root/1", "root"), ev("delta", "root/1", "root", { delta: "hi" })]);
  expect(afterWrite.get("root/1")!.state).toBe("writing");
  const afterFinal = run([ev("model_start", "root/1", "root"), ev("final", "root/1", "root", { text: "done" })]);
  expect(afterFinal.has("root/1")).toBe(false); // settled → no longer live
});

test("tool_start → working with tool+argsPreview; tool_end → back to thinking", () => {
  const m = run([
    ev("model_start", "root/1", "root"),
    ev("tool_start", "root/1", "root", { tool: "read_url", argsPreview: "https://x" }),
  ]);
  const s = m.get("root/1")!;
  expect(s.state).toBe("working");
  expect(s.tool).toBe("read_url");
  expect(s.argsPreview).toBe("https://x");
  const after = run([
    ev("model_start", "root/1", "root"),
    ev("tool_start", "root/1", "root", { tool: "read_url" }),
    ev("tool_end", "root/1", "root", { tool: "read_url", ok: true }),
  ]);
  expect(after.get("root/1")!.state).toBe("thinking");
  expect(after.get("root/1")!.tool).toBeUndefined();
});

test("a delegate_task tool puts the agent in the delegating state", () => {
  const m = run([ev("tool_start", "root/1", "root", { tool: "delegate_task", argsPreview: "writer: X" })]);
  expect(m.get("root/1")!.state).toBe("delegating");
});

test("approval_start → waiting (loud); approval_end returns to the in-flight tool", () => {
  const m = run([
    ev("tool_start", "root/1", "root", { tool: "create_agent" }),
    ev("approval_start", "root/1", "root", { tool: "create_agent scout" }),
  ]);
  const s = m.get("root/1")!;
  expect(s.state).toBe("waiting");
  expect(s.waiting).toBe(true);
  expect(s.tool).toBe("create_agent scout");
  // answering the card: the tool is still executing, so we go back to working (not idle)
  const after = run([
    ev("tool_start", "root/1", "root", { tool: "create_agent" }),
    ev("approval_start", "root/1", "root", { tool: "create_agent scout" }),
    ev("approval_end", "root/1", "root", { tool: "create_agent scout" }),
  ]);
  expect(after.get("root/1")!.waiting).toBe(false);
  expect(after.get("root/1")!.state).toBe("working");
});

test("nested delegation: parent 'delegating' and child 'working' are live at the SAME time", () => {
  // root delegates → root.tool_start(delegate_task); child run starts and works, then finishes.
  const m = run([
    ev("model_start", "root/1", "root"),
    ev("tool_start", "root/1", "root", { tool: "delegate_task", argsPreview: "writer: X" }),
    ev("model_start", "writer/1", "writer"),
    ev("tool_start", "writer/1", "writer", { tool: "save_artifact", argsPreview: "Script" }),
  ]);
  expect(m.get("root/1")!.state).toBe("delegating");
  expect(m.get("writer/1")!.state).toBe("working");
  expect(m.get("writer/1")!.tool).toBe("save_artifact");
  expect([...m.keys()].length).toBe(2); // both agents visible in the bar at once
});

test("child final drops only the child; the parent stays delegating until its tool ends", () => {
  const m = run([
    ev("tool_start", "root/1", "root", { tool: "delegate_task" }),
    ev("model_start", "writer/1", "writer"),
    ev("final", "writer/1", "writer", { text: "child done" }),
  ]);
  expect(m.has("writer/1")).toBe(false);         // child settled
  expect(m.get("root/1")!.state).toBe("delegating"); // parent still holding the delegation open
  const done = statusReducer(m, ev("tool_end", "root/1", "root", { tool: "delegate_task", ok: true }), 9999);
  expect(done.get("root/1")!.state).toBe("thinking"); // delegation returned → parent thinks again
});

test("since resets only when the state actually changes (stable elapsed-in-state)", () => {
  let map: StatusMap = new Map();
  map = statusReducer(map, ev("model_start", "root/1", "root"), 1000);
  const t0 = map.get("root/1")!.since;
  map = statusReducer(map, ev("model_start", "root/1", "root"), 2000); // same state → since unchanged
  expect(map.get("root/1")!.since).toBe(t0);
  map = statusReducer(map, ev("tool_start", "root/1", "root", { tool: "x" }), 3000); // state change → reset
  expect(map.get("root/1")!.since).toBe(3000);
});

test("events without a phase/runId are ignored (note breadcrumbs pass through)", () => {
  const map: StatusMap = new Map();
  expect(statusReducer(map, { agent: "root", note: "a breadcrumb" } as StepEvent, 1).size).toBe(0);
});

test("statusList sorts waiting agents first, then oldest-in-state", () => {
  const m = run([
    ev("model_start", "a/1", "a"),
    ev("model_start", "b/1", "b"),
    ev("tool_start", "b/1", "b", { tool: "run_command" }),
    ev("approval_start", "b/1", "b", { tool: "run_command rm" }),
  ]);
  const list = statusList(m);
  expect(list[0].runId).toBe("b/1"); // b is waiting → surfaced first
  expect(list[0].waiting).toBe(true);
});
