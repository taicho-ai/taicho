/** Plan 04 Phase 6 — a Schedule fires an UNATTENDED run on a schedule (cron-style) or a trigger
 *  (a file watch), driving the goal through the headless `executeRun` path (Plan 03's seam). A
 *  schedule persists to `schedules/<id>.json` (files are canon) so it survives restarts and is
 *  reconciled/armed on boot.
 *
 *  APPROVALS: a scheduled run is unattended — there is no captain watching an approval card — so the
 *  approval channel is restricted to `reject` (the safe default: decline every privileged action) or
 *  `approve` (scripted/trusted only). `prompt` is meaningless with no stdin and is not allowed here. */
import { z } from "zod";

/** Unattended approval modes only. `reject` = the safe default (decline privileged tools); `approve`
 *  = trusted/scripted (approve everything). No `prompt` — nobody is there to answer. */
export const ScheduleApprove = z.enum(["reject", "approve"]);
export type ScheduleApprove = z.infer<typeof ScheduleApprove>;

/** What makes a schedule due:
 *  - `cron`  — a 5-field cron expression, evaluated in **UTC** (deterministic; no DST ambiguity).
 *  - `interval` — fire every `everyMs` milliseconds.
 *  - `watch` — fire when the file/dir at `path` changes (its mtime moves). Polled on each tick. */
export const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: z.string().min(1) }),
  z.object({ kind: z.literal("interval"), everyMs: z.number().int().positive() }),
  z.object({ kind: z.literal("watch"), path: z.string().min(1) }),
]);
export type Trigger = z.infer<typeof Trigger>;

export const Schedule = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  agent: z.string().min(1).default("root"),
  trigger: Trigger,
  approve: ScheduleApprove.default("reject"),
  enabled: z.boolean().default(true),
  created: z.string(),
  updated: z.string(),
  // Mutable scheduling state, advanced by the runner on each fire and persisted so cadence survives
  // a restart. `nextDueAt` is the next computed fire time (cron/interval); `lastMtimeMs` the last-seen
  // mtime (watch). `lastRunId`/`lastStatus` record the outcome of the most recent fire.
  runCount: z.number().int().nonnegative().default(0),
  lastRunAt: z.string().optional(),
  lastRunId: z.string().optional(),
  lastStatus: z.string().optional(),
  nextDueAt: z.string().optional(),
  lastMtimeMs: z.number().optional(),
});
export type Schedule = z.infer<typeof Schedule>;

/** The fields a caller supplies to create a schedule (the rest are defaulted / assigned). */
export interface ScheduleSpec {
  id?: string;
  goal: string;
  agent?: string;
  trigger: Trigger;
  approve?: ScheduleApprove;
}
