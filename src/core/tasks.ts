/** Plan 04 — the background task SCHEDULER: a per-agent concurrency semaphore over detached runs.
 *
 *  The engine/UI owns *how* a run starts (build deps, executeRun, settle+notify); this class owns
 *  *when* — it holds a persistent queue and enforces `maxConcurrentRuns` per agent (config disposes
 *  the concurrency the model proposes via dispatch_task). A task submitted over its agent's cap sits
 *  `queued` until a running slot frees; when one settles, the queue pumps the next. Single-threaded
 *  Bun means every check-then-act here runs to completion between awaits — no lock needed. */

export interface QueuedTask {
  taskId: string;
  agentId: string;
  /** Max concurrent RUNNING tasks allowed for this task's agent (from budgets.maxConcurrentRuns).
   *  Undefined ⇒ unbounded. Carried on the task (not looked up) so pump() stays synchronous. */
  cap?: number;
  /** Start the detached run. Returns the controller (for cancel) + a promise that settles when the
   *  run (and the caller's settle/notify chain) is fully done. The scheduler only does bookkeeping
   *  around it — status writes + notifications live in the `start` closure the caller supplies. */
  start: () => { controller: AbortController; promise: Promise<unknown> };
  /** Invoked if the task is cancelled while still queued (never started). */
  onCancelQueued?: () => void;
}

interface RunningHandle { controller: AbortController; promise: Promise<unknown>; agentId: string; }

export class TaskScheduler {
  private running = new Map<string, RunningHandle>();
  private queue: QueuedTask[] = [];

  /** Enqueue a task and pump: it starts immediately if the agent is under its cap, else stays queued. */
  submit(task: QueuedTask): void {
    this.queue.push(task);
    this.pump();
  }

  private runningForAgent(agentId: string): number {
    let n = 0;
    for (const h of this.running.values()) if (h.agentId === agentId) n++;
    return n;
  }

  /** Start every queued task whose agent is under its concurrency cap, in FIFO order. Idempotent. */
  private pump(): void {
    const stillQueued: QueuedTask[] = [];
    for (const task of this.queue) {
      if (task.cap != null && this.runningForAgent(task.agentId) >= task.cap) { stillQueued.push(task); continue; }
      const { controller, promise } = task.start();
      this.running.set(task.taskId, { controller, promise, agentId: task.agentId });
      // On settle: free the slot and pump again so a queued task for this agent can start.
      void promise.finally(() => { this.running.delete(task.taskId); this.pump(); });
    }
    this.queue = stillQueued;
  }

  /** Is this task currently running (not queued, not settled)? */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** How many tasks are running for an agent right now (used by the dispatch pre-check for a note). */
  runningCount(agentId: string): number {
    return this.runningForAgent(agentId);
  }

  /** Await a running task's completion promise (undefined if it isn't running — already settled or
   *  queued). `await_task` uses this for a running task and polls the record otherwise. */
  awaitRunning(taskId: string): Promise<unknown> | undefined {
    return this.running.get(taskId)?.promise;
  }

  /** Cancel a task. Running ⇒ abort its signal (the loop stops next iteration). Queued ⇒ drop it and
   *  fire onCancelQueued. Returns whether anything was cancelled. */
  cancel(taskId: string): boolean {
    const running = this.running.get(taskId);
    if (running) { running.controller.abort(); return true; }
    const idx = this.queue.findIndex((t) => t.taskId === taskId);
    if (idx >= 0) {
      const [task] = this.queue.splice(idx, 1);
      task?.onCancelQueued?.();
      return true;
    }
    return false;
  }
}
