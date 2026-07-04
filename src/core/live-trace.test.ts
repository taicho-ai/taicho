/** Plan 02 Phase 6 — the live waterfall reducer is pure (an event sequence → a redrawing Span tree),
 *  so it is unit-tested in isolation with no Ink, no engine, no disk. These lock down the fold: llm
 *  spans pair model_start→transition; tool spans pair by callId; a delegated child nests under its
 *  parent's open delegate tool span; still-running bars grow to `now`; run-end settles open children. */
import { test, expect } from "bun:test";
import { emptyLiveTrace, liveRunStart, liveStep, liveRunEnd, liveSpans } from "./live-trace";
import type { StepEvent } from "./step-events";
import type { Span } from "./trace-tree";

const ev = (over: Partial<StepEvent> & { phase: StepEvent["phase"]; runId: string; agent: string }): StepEvent => over as StepEvent;
const byKind = (spans: Span[], kind: Span["kind"]) => spans.filter((s) => s.kind === kind);
const byId = (spans: Span[], id: string) => spans.find((s) => s.id === id);

test("a simple run: run span + two paired llm spans + one paired tool span, all settled", () => {
  const st = emptyLiveTrace();
  const R = "root/run1";
  liveRunStart(st, { runId: R, agent: "root", triggeredBy: "user" }, 100);
  liveStep(st, ev({ phase: "model_start", runId: R, agent: "root" }), 110);
  liveStep(st, ev({ phase: "delta", runId: R, agent: "root", delta: "hi" }), 115);
  liveStep(st, ev({ phase: "tool_start", runId: R, agent: "root", tool: "write_artifact", callId: "c1", argsPreview: "x" }), 120);
  liveStep(st, ev({ phase: "tool_end", runId: R, agent: "root", tool: "write_artifact", callId: "c1", ok: true }), 130);
  liveStep(st, ev({ phase: "model_start", runId: R, agent: "root" }), 140);
  liveStep(st, ev({ phase: "final", runId: R, agent: "root", text: "done" }), 150);
  liveRunEnd(st, { runId: R, agent: "root", triggeredBy: "user", outcome: "completed" }, 160);

  const spans = liveSpans(st, 999);
  const runs = byKind(spans, "run");
  expect(runs.length).toBe(1);
  expect(runs[0].id).toBe(R);
  expect(runs[0].status).toBe("ok"); // settled — NOT extended to `now` despite being asked for 999

  const llm = byKind(spans, "llm");
  expect(llm.length).toBe(2);
  for (const s of llm) { expect(s.status).toBe("ok"); expect(s.endMs).toBeGreaterThanOrEqual(s.startMs); expect(s.parentId).toBe(R); }

  const tools = byKind(spans, "tool");
  expect(tools.length).toBe(1);
  expect(tools[0].name).toBe("write_artifact");
  expect(tools[0].status).toBe("ok");
  expect(tools[0].parentId).toBe(R);
  if (tools[0].detail.kind === "tool") expect(tools[0].detail.argsPreview).toBe("x");
});

test("a still-open llm span stays `running` and its bar grows toward `now`", () => {
  const st = emptyLiveTrace();
  const R = "root/run1";
  liveRunStart(st, { runId: R, agent: "root", triggeredBy: "user" }, 100);
  liveStep(st, ev({ phase: "model_start", runId: R, agent: "root" }), 110);

  const at200 = byId(liveSpans(st, 200), `${R}#llm1`)!;
  expect(at200.status).toBe("running");
  expect(at200.endMs).toBe(200); // extended to the snapshot `now`
  const at300 = byId(liveSpans(st, 300), `${R}#llm1`)!;
  expect(at300.endMs).toBe(300); // grows as the redraw ticks
  // the run span (still running) grows too
  expect(byId(liveSpans(st, 300), R)!.endMs).toBe(300);
});

test("tool spans pair by callId even when two tools overlap", () => {
  const st = emptyLiveTrace();
  const R = "root/run1";
  liveRunStart(st, { runId: R, agent: "root", triggeredBy: "user" }, 0);
  liveStep(st, ev({ phase: "model_start", runId: R, agent: "root" }), 1);
  liveStep(st, ev({ phase: "tool_start", runId: R, agent: "root", tool: "a", callId: "ca" }), 2);
  liveStep(st, ev({ phase: "tool_start", runId: R, agent: "root", tool: "b", callId: "cb" }), 3);
  // end them in the OPPOSITE order — a LIFO stack would mispair; callId keeps it exact.
  liveStep(st, ev({ phase: "tool_end", runId: R, agent: "root", tool: "a", callId: "ca", ok: true }), 4);
  liveStep(st, ev({ phase: "tool_end", runId: R, agent: "root", tool: "b", callId: "cb", ok: false }), 5);

  const spans = liveSpans(st, 10);
  const a = byId(spans, `${R}#tool:ca`)!;
  const b = byId(spans, `${R}#tool:cb`)!;
  expect(a.name).toBe("a"); expect(a.status).toBe("ok"); expect(a.endMs).toBe(4);
  expect(b.name).toBe("b"); expect(b.status).toBe("error"); expect(b.endMs).toBe(5);
});

test("a delegated child run nests UNDER the parent's open delegate_task tool span", () => {
  const st = emptyLiveTrace();
  const P = "root/run1", C = "writer/run1";
  liveRunStart(st, { runId: P, agent: "root", triggeredBy: "user" }, 0);
  liveStep(st, ev({ phase: "model_start", runId: P, agent: "root" }), 1);
  liveStep(st, ev({ phase: "tool_start", runId: P, agent: "root", tool: "delegate_task", callId: "d1" }), 2);
  // the delegate tool blocks while the child runs (its onRunStart fires mid-tool)
  liveRunStart(st, { runId: C, agent: "writer", triggeredBy: P }, 3);
  liveStep(st, ev({ phase: "model_start", runId: C, agent: "writer" }), 4);
  liveStep(st, ev({ phase: "final", runId: C, agent: "writer", text: "child done" }), 5);
  liveRunEnd(st, { runId: C, agent: "writer", triggeredBy: P, outcome: "completed" }, 6);
  liveStep(st, ev({ phase: "tool_end", runId: P, agent: "root", tool: "delegate_task", callId: "d1", ok: true }), 7);
  liveStep(st, ev({ phase: "final", runId: P, agent: "root", text: "parent done" }), 8);
  liveRunEnd(st, { runId: P, agent: "root", triggeredBy: "user", outcome: "completed" }, 9);

  const spans = liveSpans(st, 20);
  const child = byId(spans, C)!;
  const delegSpan = byId(spans, `${P}#tool:d1`)!;
  expect(child.kind).toBe("run");
  expect(child.parentId).toBe(delegSpan.id); // nested under the delegate tool span, not the run span
  expect(byId(spans, P)!.parentId).toBeUndefined(); // the foreground root is a root
});

test("approval spans pair FIFO and settle ok", () => {
  const st = emptyLiveTrace();
  const R = "root/run1";
  liveRunStart(st, { runId: R, agent: "root", triggeredBy: "user" }, 0);
  liveStep(st, ev({ phase: "approval_start", runId: R, agent: "root", tool: "create_agent scout" }), 1);
  // while blocked, the approval span is running…
  expect(byId(liveSpans(st, 5), `${R}#approval0`)!.status).toBe("running");
  liveStep(st, ev({ phase: "approval_end", runId: R, agent: "root", tool: "create_agent scout" }), 8);
  const a = byId(liveSpans(st, 10), `${R}#approval0`)!;
  expect(a.kind).toBe("approval");
  expect(a.status).toBe("ok");
  expect(a.endMs).toBe(8);
});

test("run-end settles any still-open child span (interrupted cascade)", () => {
  const st = emptyLiveTrace();
  const R = "root/run1";
  liveRunStart(st, { runId: R, agent: "root", triggeredBy: "user" }, 0);
  liveStep(st, ev({ phase: "model_start", runId: R, agent: "root" }), 1);
  liveStep(st, ev({ phase: "tool_start", runId: R, agent: "root", tool: "read_url", callId: "c1" }), 2);
  // no tool_end — the run is interrupted mid-tool
  liveRunEnd(st, { runId: R, agent: "root", triggeredBy: "user", outcome: "interrupted" }, 3);

  const spans = liveSpans(st, 100);
  expect(byId(spans, R)!.status).toBe("interrupted");
  const tool = byId(spans, `${R}#tool:c1`)!;
  expect(tool.status).toBe("interrupted"); // settled, not left dangling as `running`
  expect(tool.endMs).toBe(3);
});

test("TWO delegations in one turn each adopt a distinct child (openDeleg is a stack, not a slot)", () => {
  const st = emptyLiveTrace();
  const P = "root/run1", C1 = "a/run1", C2 = "b/run1";
  liveRunStart(st, { runId: P, agent: "root", triggeredBy: "user" }, 0);
  liveStep(st, ev({ phase: "model_start", runId: P, agent: "root" }), 1);
  // both delegate_task tool calls open (concurrent execution) BEFORE either child starts
  liveStep(st, ev({ phase: "tool_start", runId: P, agent: "root", tool: "delegate_task", callId: "d1" }), 2);
  liveStep(st, ev({ phase: "tool_start", runId: P, agent: "root", tool: "delegate_task", callId: "d2" }), 3);
  liveRunStart(st, { runId: C1, agent: "a", triggeredBy: P }, 4);
  liveRunStart(st, { runId: C2, agent: "b", triggeredBy: P }, 5);

  const spans = liveSpans(st, 10);
  const c1 = byId(spans, C1)!, c2 = byId(spans, C2)!;
  const d1 = byId(spans, `${P}#tool:d1`)!, d2 = byId(spans, `${P}#tool:d2`)!;
  // each child hangs off a DISTINCT delegation span (not both under the last one)
  expect(new Set([c1.parentId, c2.parentId])).toEqual(new Set([d1.id, d2.id]));
  expect(c1.parentId).not.toBe(c2.parentId);
});

test("concurrent runs with the SAME fallback callId don't cross-settle (toolByCall is runId-scoped)", () => {
  const st = emptyLiveTrace();
  const A = "a/run1", B = "b/run1";
  liveRunStart(st, { runId: A, agent: "a", triggeredBy: "user" }, 0);
  liveRunStart(st, { runId: B, agent: "b", triggeredBy: "user" }, 0);
  // both runs' tools share the engine's per-run fallback callId "read#1"
  liveStep(st, ev({ phase: "tool_start", runId: A, agent: "a", tool: "read_url", callId: "read#1" }), 1);
  liveStep(st, ev({ phase: "tool_start", runId: B, agent: "b", tool: "read_url", callId: "read#1" }), 2);
  // A ends its tool — must settle A's span, NOT B's
  liveStep(st, ev({ phase: "tool_end", runId: A, agent: "a", tool: "read_url", callId: "read#1", ok: true }), 3);

  const spans = liveSpans(st, 10);
  expect(byId(spans, `${A}#tool:read#1`)!.status).toBe("ok");     // A settled
  expect(byId(spans, `${B}#tool:read#1`)!.status).toBe("running"); // B still open (not cross-settled)
});

test("an event for an unknown run is dropped (a background run that outlived its turn's clear)", () => {
  const st = emptyLiveTrace();
  // no liveRunStart for this run (it started before a clear that emptied the state)
  liveStep(st, ev({ phase: "tool_start", runId: "ghost/run1", agent: "ghost", tool: "read_url", callId: "c1" }), 5);
  expect(liveSpans(st)).toEqual([]); // no mis-rooted, mis-timed span synthesized
});

test("liveSpans returns a fresh array each call (React state updates fire)", () => {
  const st = emptyLiveTrace();
  liveRunStart(st, { runId: "root/run1", agent: "root", triggeredBy: "user" }, 0);
  expect(liveSpans(st)).not.toBe(liveSpans(st));
});
