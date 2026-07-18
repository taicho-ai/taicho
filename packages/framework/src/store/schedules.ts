/** Plan 04 Phase 6 — durable schedule store. Files under `schedules/<id>.json` are canon: a schedule
 *  survives a restart and is reconciled/armed on boot (`listSchedules`). The set is small (a handful
 *  of captain-created schedules), so a file scan is the whole query surface — no DB index needed
 *  (unlike `/tasks`, which needs fast filtered queries over many rows). */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./files";
import { Schedule, type ScheduleSpec } from "@taicho/contracts/schedule";
import { validateTrigger } from "../core/scheduler";
import { log } from "../core/logger";

function scheduleFile(ws: string, id: string): string {
  return join(paths.scheduleDir(ws), `${id}.json`);
}

/** A stable, filesystem-safe id: an explicit `--id name` (sanitized) or a generated one. */
function mkScheduleId(explicit?: string): string {
  if (explicit) {
    const clean = explicit.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (clean) return clean;
  }
  return `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Atomic write — temp file + `rename` (atomic on POSIX) — so a crash mid-write can never leave a
 *  half-written `<id>.json` that `listSchedules` would silently drop (losing the schedule). The temp
 *  suffix isn't `.json`, so a leftover temp from a crashed write is ignored by `listSchedules`.
 *  Mirrors the pattern already used by `artifacts.ts`. */
function write(ws: string, schedule: Schedule): void {
  mkdirSync(paths.scheduleDir(ws), { recursive: true });
  const dest = scheduleFile(ws, schedule.id);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(schedule, null, 2));
  renameSync(tmp, dest);
}

/** Create + persist a new schedule. Validates the trigger (a bad cron expression throws HERE, at
 *  creation, never silently at fire time). Rejects a duplicate explicit id. */
export function createSchedule(ws: string, spec: ScheduleSpec, nowMs = Date.now()): Schedule {
  validateTrigger(spec.trigger, nowMs); // throws on an unfireable cron
  const id = mkScheduleId(spec.id);
  if (existsSync(scheduleFile(ws, id))) throw new Error(`schedule "${id}" already exists`);
  const now = new Date(nowMs).toISOString();
  const schedule = Schedule.parse({
    id,
    goal: spec.goal,
    agent: spec.agent ?? "root",
    trigger: spec.trigger,
    approve: spec.approve ?? "reject",
    enabled: true,
    created: now,
    updated: now,
    runCount: 0,
  });
  write(ws, schedule);
  return schedule;
}

export function readSchedule(ws: string, id: string): Schedule | null {
  const f = scheduleFile(ws, id);
  if (!existsSync(f)) return null;
  try { return Schedule.parse(JSON.parse(readFileSync(f, "utf8"))); }
  catch { return null; }
}

/** All schedules, newest first — the boot reconcile/arm list AND the `/schedules list` source. */
export function listSchedules(ws: string): Schedule[] {
  const dir = paths.scheduleDir(ws);
  if (!existsSync(dir)) return [];
  const out: Schedule[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(Schedule.parse(JSON.parse(readFileSync(join(dir, f), "utf8")))); }
    catch (e) { log.warn(`skipped unparseable schedule file ${f}`, e); } // surfaced, not silently lost
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

/** Field-level patch of a schedule (the runner advances lastRunAt/nextDueAt/runCount; fire records
 *  lastRunId/lastStatus). Reads-merges-writes so concurrent patches never clobber each other's fields. */
export function updateSchedule(ws: string, id: string, patch: Partial<Schedule>): Schedule | null {
  const cur = readSchedule(ws, id);
  if (!cur) return null;
  const next = Schedule.parse({ ...cur, ...patch, id: cur.id, updated: new Date().toISOString() });
  write(ws, next);
  return next;
}

export function removeSchedule(ws: string, id: string): boolean {
  const f = scheduleFile(ws, id);
  if (!existsSync(f)) return false;
  rmSync(f);
  return true;
}
