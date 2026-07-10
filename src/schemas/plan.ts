import { z } from "zod";

/** Plan 18. A plan separates STRUCTURE from STATE, because they answer different questions and change
 *  at wildly different rates:
 *
 *    · a plan VERSION (v1, v2, …) is an immutable snapshot of the item SET — the intent. Minted only
 *      when the shape changes: an item added, removed, reworded, reordered. That is a replan, and it
 *      deserves a version. (This is store/artifacts.ts.)
 *    · an item TRANSITION is an append-only line in plans/<id>/events.jsonl. Ticking a box appends; it
 *      never mints a version. (This is store/annotations.ts.)
 *
 *  Current state is fold(events) over the latest version — the same ledger-is-truth, cache-is-derived
 *  discipline that already governs ledger.jsonl → thread.jsonl. Had every tick minted a version, a
 *  twelve-item plan with three transitions each would produce thirty-six versions of an object whose
 *  shape never changed, and "when did this agent change its mind?" would be buried under bookkeeping. */

export const PlanItemStatus = z.enum([
  "pending",
  "in_progress",
  "done",
  "failed",
  "blocked",
  "interrupted", // the process died while this item's bound run was in flight (boot reconcile)
  "dropped",     // the agent abandoned it on purpose; requires a note
]);
export type PlanItemStatus = z.infer<typeof PlanItemStatus>;

/** Terminal for the purposes of "is this item still open". `dropped` counts as settled. */
export const TERMINAL_ITEM_STATUS: ReadonlySet<PlanItemStatus> = new Set<PlanItemStatus>([
  "done", "failed", "blocked", "interrupted", "dropped",
]);

/** An item id is stable ACROSS versions. That is what lets an event logged against v1 still resolve
 *  after a replan mints v2 — the fold matches on item id, not on position. */
export const PlanItem = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase, digits, underscore, hyphen"),
  text: z.string(),
  assignee: z.string().optional(), // the agent or team this item is meant for
});
export type PlanItem = z.infer<typeof PlanItem>;

export const Plan = z.object({
  id: z.string(),                              // p_<slug>
  version: z.number().int().positive(),
  owner: z.string(),                           // the agent whose plan this is
  goal: z.string(),
  items: z.array(PlanItem),
  parents: z.array(z.string()).default([]),    // lineage: ["p_ship@v1"] — a replan's provenance
  producer: z.string(),
  runId: z.string(),
  created: z.string().datetime(),
});
export type Plan = z.infer<typeof Plan>;

/** One line per transition. The LATEST line for an item wins the fold. */
export const PlanEvent = z.object({
  item: z.string(),
  status: PlanItemStatus,
  /** Who wrote it. An `engine` event is the truth about what a run actually did; a `model` event is a
   *  claim. Both are recorded — a model trying to mark a failed delegation `done` is exactly the
   *  behaviour you want visible in a trace, not silently swallowed. */
  by: z.enum(["model", "engine"]),
  runId: z.string(),                           // the run that wrote the event
  /** The child run (or background taskId) this item is bound to. Once set, ONLY the engine may set the
   *  item's terminal status: the checkbox reflects what happened, not what the model claims. */
  boundRunId: z.string().optional(),
  note: z.string().optional(),                 // e.g. a failed verdict's reasons
  /** A recorded-but-refused attempt: the model tried to set a terminal status on an engine-owned item.
   *  The fold SKIPS these — otherwise the attempt would be the last line for that item and would win,
   *  which is precisely the lie the engine-owns rule exists to prevent. It stays in the log because a
   *  model marking a failed delegation `done` is a fact worth having. */
  rejected: z.boolean().optional(),
  ts: z.string().datetime(),
});
export type PlanEvent = z.infer<typeof PlanEvent>;

/** An item with its folded state — what the panel renders and what the model is shown. */
export interface FoldedItem extends PlanItem {
  status: PlanItemStatus;
  boundRunId?: string;
  note?: string;
  /** When this item last changed, for elapsed-in-state. */
  updated?: string;
}

export interface PlanState {
  plan: Plan;
  handle: string;
  items: FoldedItem[];
  counts: { total: number; done: number; open: number; failed: number };
}

export const planHandle = (p: { id: string; version: number }): string => `${p.id}@v${p.version}`;

/** `p_ship` (latest) or `p_ship@v2` (a concrete version). Mirrors schemas/artifact.ts parseHandle. */
export function parsePlanHandle(handle: string): { id: string; version?: number } {
  const at = handle.lastIndexOf("@v");
  if (at < 0) return { id: handle };
  const v = Number(handle.slice(at + 2));
  return Number.isInteger(v) && v > 0 ? { id: handle.slice(0, at), version: v } : { id: handle };
}

/** A stable id from a goal. Deterministic, so re-stating the same goal continues the same plan rather
 *  than forking a second one the agent then has to reconcile against. */
export function planIdForGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `p_${slug || "plan"}`;
}
