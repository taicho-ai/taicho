import { test, expect } from "bun:test";
import { TaskScheduler, type QueuedTask } from "./tasks";

/** A controllable task: exposes started/settle so a test can drive concurrency deterministically. */
function deferredTask(taskId: string, agentId: string, cap?: number) {
  let resolveRun!: () => void;
  const promise = new Promise<void>((r) => { resolveRun = r; });
  const controller = new AbortController();
  let started = false;
  const task: QueuedTask = {
    taskId, agentId, cap,
    start: () => { started = true; return { controller, promise }; },
  };
  return { task, controller, settle: () => resolveRun(), get started() { return started; } };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("maxConcurrentRuns caps how many of an agent's tasks run at once; the queue pumps on settle", async () => {
  const s = new TaskScheduler();
  const a = deferredTask("t1", "worker", 1);
  const b = deferredTask("t2", "worker", 1);
  s.submit(a.task);
  s.submit(b.task);
  expect(a.started).toBe(true);        // first slot taken
  expect(b.started).toBe(false);       // second stays queued (cap=1)
  expect(s.runningCount("worker")).toBe(1);

  a.settle();                          // free the slot
  await tick();                        // let the .finally pump run
  expect(b.started).toBe(true);        // queued task now starts
  expect(s.runningCount("worker")).toBe(1);
  b.settle();
  await tick();
  expect(s.runningCount("worker")).toBe(0);
});

test("an undefined cap runs every submitted task immediately (unbounded)", () => {
  const s = new TaskScheduler();
  const a = deferredTask("t1", "w"); const b = deferredTask("t2", "w"); const c = deferredTask("t3", "w");
  s.submit(a.task); s.submit(b.task); s.submit(c.task);
  expect([a.started, b.started, c.started]).toEqual([true, true, true]);
  expect(s.runningCount("w")).toBe(3);
});

test("the cap is per-agent: a busy agent never blocks a different agent", () => {
  const s = new TaskScheduler();
  const a1 = deferredTask("a1", "alpha", 1);
  const a2 = deferredTask("a2", "alpha", 1);
  const b1 = deferredTask("b1", "beta", 1);
  s.submit(a1.task); s.submit(a2.task); s.submit(b1.task);
  expect(a1.started).toBe(true);
  expect(a2.started).toBe(false); // alpha at cap
  expect(b1.started).toBe(true);  // beta free
});

test("cancel aborts a running task and drops a queued one (firing onCancelQueued)", () => {
  const s = new TaskScheduler();
  const a = deferredTask("run", "w", 1);
  const b = deferredTask("queued", "w", 1);
  let queuedCancelled = false;
  b.task.onCancelQueued = () => { queuedCancelled = true; };
  s.submit(a.task); s.submit(b.task);

  expect(s.cancel("run")).toBe(true);
  expect(a.controller.signal.aborted).toBe(true); // running task's signal aborted
  expect(s.cancel("queued")).toBe(true);
  expect(queuedCancelled).toBe(true);             // queued task dropped before starting
  expect(s.cancel("nope")).toBe(false);           // unknown id
});

test("awaitRunning resolves with the running task's promise; undefined once settled", async () => {
  const s = new TaskScheduler();
  const a = deferredTask("t", "w");
  s.submit(a.task);
  const p = s.awaitRunning("t");
  expect(p).toBeTruthy();
  a.settle();
  await p;      // resolves when the task settles
  await tick(); // let the finally cleanup run
  expect(s.awaitRunning("t")).toBeUndefined(); // no longer running
});
