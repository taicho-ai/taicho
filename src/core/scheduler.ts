/** Plan 04 Phase 6 — the schedule/trigger engine. This module is PURE (no fs, no wall-clock of its
 *  own): the clock, the file-stat, and the "fire" action are all INJECTED, so "is it time to fire"
 *  and "fire → run" are deterministic and unit-testable without real timers.
 *
 *  Two pieces live here:
 *   - cron evaluation (a 5-field subset, UTC) + `nextCronAfter` — pure functions.
 *   - `SchedulerRunner` — holds armed schedules and, on each `tick(now)`, fires the ones that are due
 *     via the injected `fire` seam (which the host wires to the headless `executeRun` path). It never
 *     re-fires a schedule while its previous run is still in flight (bounds concurrency to 1/schedule).
 *   - `parseScheduleCommand` / `parseDuration` / formatters — the shared `/schedules` + `taicho
 *     schedule` grammar, kept here so both the REPL (slash) and the CLI use one parser. */
import { Schedule, Trigger, ScheduleApprove, type ScheduleSpec } from "../schemas/schedule";

// ── cron (5-field, UTC): minute hour day-of-month month day-of-week ────────────────────────────────

interface CronRange { min: number; max: number }
const FIELD_RANGES: CronRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // day of week (0 = Sunday)
];

/** Expand one cron field into the set of matching values. Supports `*` (all), `a-b` (range), `a,b,c`
 *  (list), and a `/n` step suffix (e.g. a star-slash-15 for "every 15"). Throws on a malformed field
 *  or an out-of-range value so a bad expression is rejected at creation, not at fire. */
export function parseCronField(field: string, range: CronRange): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (!part) throw new Error(`bad cron field "${field}"`);
    let step = 1;
    let spec = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      step = Number(part.slice(slash + 1));
      spec = part.slice(0, slash);
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step in "${field}"`);
    }
    let lo: number, hi: number;
    if (spec === "*") { lo = range.min; hi = range.max; }
    else if (spec.includes("-")) {
      const [a, b] = spec.split("-");
      lo = Number(a); hi = Number(b);
    } else {
      lo = hi = Number(spec);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi || lo < range.min || hi > range.max)
      throw new Error(`bad cron field "${field}" (expected ${range.min}-${range.max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

interface ParsedCron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean; }

/** Parse + validate a 5-field cron expression. Throws with an actionable message on anything invalid. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields (min hour dom month dow), got ${fields.length}: "${expr}"`);
  const [mn, hr, dm, mo, dw] = fields;
  return {
    minute: parseCronField(mn!, FIELD_RANGES[0]!),
    hour: parseCronField(hr!, FIELD_RANGES[1]!),
    dom: parseCronField(dm!, FIELD_RANGES[2]!),
    month: parseCronField(mo!, FIELD_RANGES[3]!),
    dow: parseCronField(dw!, FIELD_RANGES[4]!),
    domStar: dm === "*",
    dowStar: dw === "*",
  };
}

/** Does `date` (its UTC components) match `expr`? Day-of-month and day-of-week follow the standard
 *  Vixie-cron rule: when BOTH are restricted, the day matches if EITHER matches; when one is `*`,
 *  only the restricted one gates. */
export function cronMatches(expr: string, date: Date): boolean {
  const c = parseCron(expr);
  const minMatch = c.minute.has(date.getUTCMinutes());
  const hourMatch = c.hour.has(date.getUTCHours());
  const monthMatch = c.month.has(date.getUTCMonth() + 1);
  const domMatch = c.dom.has(date.getUTCDate());
  const dowMatch = c.dow.has(date.getUTCDay());
  const dayMatch = c.domStar && c.dowStar ? true : c.domStar ? dowMatch : c.dowStar ? domMatch : domMatch || dowMatch;
  return minMatch && hourMatch && monthMatch && dayMatch;
}

const MINUTE_MS = 60_000;
const CRON_SCAN_LIMIT_MINUTES = 366 * 24 * 60; // a year — a valid expr matches well within this

/** The next epoch-ms STRICTLY AFTER `afterMs` at which `expr` matches (scanned minute-by-minute, at
 *  second 0). Throws if no match within a year (e.g. an impossible date like Feb 30) — surfaced at
 *  create time so an unfireable schedule is rejected, never silently dead. */
export function nextCronAfter(expr: string, afterMs: number): number {
  parseCron(expr); // validate once up front (throws on a bad expr)
  // Start at the top of the minute after `afterMs` so we never re-fire the same minute we're in.
  let t = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < CRON_SCAN_LIMIT_MINUTES; i++) {
    if (cronMatches(expr, new Date(t))) return t;
    t += MINUTE_MS;
  }
  throw new Error(`cron "${expr}" has no match within a year — is the date impossible?`);
}

/** Validate a trigger (a cron expr must parse + have a reachable next fire). Throws on invalid. */
export function validateTrigger(trigger: Trigger, nowMs: number): void {
  if (trigger.kind === "cron") nextCronAfter(trigger.expr, nowMs);
}

// ── SchedulerRunner — tick-driven, injected clock / stat / fire ─────────────────────────────────────

export interface SchedulerRunnerDeps {
  /** The clock. `Date.now` in production; a counter in tests. */
  now: () => number;
  /** Current mtime (ms) of a watched path, or null if it doesn't exist. Required for `watch` triggers. */
  statMtimeMs?: (path: string) => number | null;
  /** Fire the run for a due schedule. The host wires this to the headless `executeRun` path. May be
   *  async; the runner tracks it as in-flight and won't re-fire the same schedule until it settles. */
  fire: (schedule: Schedule) => void | Promise<unknown>;
  /** Persist the scheduling state the runner advances on each fire (lastRunAt/nextDueAt/runCount/
   *  lastMtimeMs) so cadence survives a restart. A field-level PATCH — never clobbers lastRunId etc. */
  persist?: (id: string, patch: Partial<Schedule>) => void;
  log?: (msg: string) => void;
}

interface Armed { schedule: Schedule; nextDueMs?: number; lastMtimeMs?: number; inFlight: boolean; }

export class SchedulerRunner {
  private armed = new Map<string, Armed>();
  constructor(private readonly deps: SchedulerRunnerDeps) {}

  /** Arm a schedule: seed its next-due time (cron/interval) or its baseline mtime (watch) from the
   *  clock NOW. Re-arming an existing id replaces it (fresh cadence). A disabled schedule is still
   *  held (so it can be re-enabled) but never fires. */
  add(schedule: Schedule): void {
    const now = this.deps.now();
    const entry: Armed = { schedule, inFlight: false };
    try {
      if (schedule.trigger.kind === "interval") {
        // Resume from the PERSISTED next-due so a nightly REPL restart / hot-reload doesn't reset the
        // cadence — otherwise a long `--every 24h` under nightly restarts would never fire, and
        // `/schedules list` would show a stale `next:`. A next-due already in the PAST (a window missed
        // while the REPL was down) collapses to a SINGLE catch-up fire on the next tick via
        // `max(persisted, now)` — never a boot storm. No persisted value yet (a fresh schedule this
        // session) → the usual `now + everyMs`.
        const persisted = schedule.nextDueAt ? Date.parse(schedule.nextDueAt) : NaN;
        entry.nextDueMs = Number.isNaN(persisted) ? now + schedule.trigger.everyMs : Math.max(persisted, now);
      }
      else if (schedule.trigger.kind === "cron") entry.nextDueMs = nextCronAfter(schedule.trigger.expr, now);
      else entry.lastMtimeMs = this.deps.statMtimeMs?.(schedule.trigger.path) ?? undefined; // watch baseline
    } catch (e) {
      this.deps.log?.(`schedule ${schedule.id} not armed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.armed.set(schedule.id, entry);
  }

  remove(id: string): boolean {
    return this.armed.delete(id);
  }

  has(id: string): boolean {
    return this.armed.has(id);
  }

  count(): number {
    return this.armed.size;
  }

  /** Evaluate every armed schedule against the injected clock and fire the ones that are due. Called
   *  by the host on a real interval (production) or by a test with explicit clock values. Firing is
   *  idempotent within a tick — a schedule already in flight is skipped. */
  tick(): void {
    const now = this.deps.now();
    for (const entry of this.armed.values()) {
      if (!entry.schedule.enabled || entry.inFlight) continue;
      // Per-entry isolation: one schedule's failure must NEVER unwind the whole loop and starve its
      // siblings. The classic poison is a cron whose next match is beyond the year-long scan window
      // (e.g. Feb-29 `0 0 29 2 *`): it passes create-time validation but `nextCronAfter` THROWS at
      // fire time. Without this try/catch that throw escapes tick(), the host's tick wrapper swallows
      // it, and every schedule after the poison is silently never evaluated again. Catch here, disable
      // the offender (so it can't re-throw every tick with a stale nextDueMs), and log it.
      try {
        const trigger = entry.schedule.trigger;
        if (trigger.kind === "watch") {
          const m = this.deps.statMtimeMs?.(trigger.path) ?? null;
          if (m == null || m === entry.lastMtimeMs) { entry.lastMtimeMs = m ?? entry.lastMtimeMs; continue; }
          entry.lastMtimeMs = m;
          this.fireEntry(entry, now, { lastMtimeMs: m });
        } else {
          if (entry.nextDueMs == null || now < entry.nextDueMs) continue;
          const nextDueMs = trigger.kind === "interval" ? now + trigger.everyMs : nextCronAfter(trigger.expr, now);
          entry.nextDueMs = nextDueMs;
          this.fireEntry(entry, now, { nextDueAt: new Date(nextDueMs).toISOString() });
        }
      } catch (e) {
        this.disableEntry(entry, e);
      }
    }
  }

  /** Disable + flag a schedule whose evaluation threw (an unfireable cron surfaced at fire time), so it
   *  can't re-throw every tick or starve its siblings. Persisted (so the disable survives a restart)
   *  and logged — a dead schedule is surfaced, never silently dropped. */
  private disableEntry(entry: Armed, e: unknown): void {
    const reason = e instanceof Error ? e.message : String(e);
    entry.schedule = { ...entry.schedule, enabled: false, lastStatus: "error" };
    this.deps.persist?.(entry.schedule.id, { enabled: false, lastStatus: "error" });
    this.deps.log?.(`schedule ${entry.schedule.id} disabled — ${reason}`);
  }

  /** Force-fire an armed schedule now (the `/schedules run` / `taicho schedule run` path), regardless
   *  of whether it's due. No-op (returns false) if the id isn't armed or is already in flight. */
  fireNow(id: string): boolean {
    const entry = this.armed.get(id);
    if (!entry || entry.inFlight) return false;
    this.fireEntry(entry, this.deps.now(), {});
    return true;
  }

  /** Common fire path: advance the schedule's scheduling state, persist it, mark in-flight, and invoke
   *  the injected `fire`. Clears in-flight when the fire settles so the next due can fire. */
  private fireEntry(entry: Armed, now: number, extraPatch: Partial<Schedule>): void {
    entry.inFlight = true;
    const nowIso = new Date(now).toISOString();
    entry.schedule = { ...entry.schedule, lastRunAt: nowIso, runCount: entry.schedule.runCount + 1, ...extraPatch };
    this.deps.persist?.(entry.schedule.id, { lastRunAt: nowIso, runCount: entry.schedule.runCount, ...extraPatch });
    Promise.resolve()
      .then(() => this.deps.fire(entry.schedule))
      .catch((e) => this.deps.log?.(`schedule ${entry.schedule.id} fire failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        entry.inFlight = false;
        // Watch self-trigger guard: re-baseline the mtime AFTER the run settles, so writes the run
        // ITSELF made to the watched path don't re-fire it. A `--watch <path>` on a path the run writes
        // would otherwise self-sustain ~1 run/tick forever. Trade-off: a change that lands DURING the
        // run is folded into the new baseline (treated as already-seen) — acceptable for the
        // watch-then-process use case, where the run has just consumed the path's current state.
        if (entry.schedule.trigger.kind === "watch") {
          const m = this.deps.statMtimeMs?.(entry.schedule.trigger.path) ?? null;
          if (m != null && m !== entry.lastMtimeMs) {
            entry.lastMtimeMs = m;
            this.deps.persist?.(entry.schedule.id, { lastMtimeMs: m });
          }
        }
      });
  }
}

// ── shared `/schedules` + `taicho schedule` grammar (pure) ─────────────────────────────────────────

/** Parse a human duration (`500ms`, `30s`, `10m`, `2h`, `1d`, or a bare integer = ms) into ms.
 *  Returns null on anything unparseable. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    default: return n; // "ms" or no suffix
  }
}

export type ScheduleCommand =
  | { kind: "list" }
  | { kind: "add"; spec: ScheduleSpec }
  | { kind: "remove"; id: string }
  | { kind: "run"; id: string }
  | { kind: "error"; message: string };

const ADD_USAGE =
  'usage: /schedules add <goal…> (--every <30m|1h> | --cron "<m h dom mon dow>" | --watch <path>) [--agent <id>] [--approve reject|approve] [--id <name>]';

/** Parse pre-tokenized args (the CLI passes argv; the REPL passes a quote-aware tokenization) into a
 *  schedule command. The goal is every token before the first `--flag`; exactly one trigger flag is
 *  required. Shared by the slash command and the `taicho schedule` subcommand. */
export function parseScheduleCommand(tokens: string[]): ScheduleCommand {
  const sub = (tokens[0] ?? "list").toLowerCase();
  if (sub === "list" || sub === "ls") return { kind: "list" };
  if (sub === "remove" || sub === "rm") {
    const id = tokens[1];
    return id ? { kind: "remove", id } : { kind: "error", message: "usage: /schedules remove <id>" };
  }
  if (sub === "run") {
    const id = tokens[1];
    return id ? { kind: "run", id } : { kind: "error", message: "usage: /schedules run <id>" };
  }
  if (sub !== "add") return { kind: "error", message: `unknown /schedules subcommand "${sub}" (try list, add, remove, run)` };

  const rest = tokens.slice(1);
  const goalParts: string[] = [];
  let agent: string | undefined;
  let approveRaw: string | undefined;
  let id: string | undefined;
  let every: string | undefined;
  let cron: string | undefined;
  let watch: string | undefined;
  let seenFlag = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    const take = () => rest[++i];
    if (t === "--agent" || t === "-a") { agent = take(); seenFlag = true; }
    else if (t === "--approve") { approveRaw = take(); seenFlag = true; }
    else if (t === "--id") { id = take(); seenFlag = true; }
    else if (t === "--every") { every = take(); seenFlag = true; }
    else if (t === "--cron") { cron = take(); seenFlag = true; }
    else if (t === "--watch") { watch = take(); seenFlag = true; }
    else if (t.startsWith("--")) return { kind: "error", message: `unknown flag "${t}". ${ADD_USAGE}` };
    else if (!seenFlag) goalParts.push(t); // goal tokens only before the first flag
    else return { kind: "error", message: `unexpected argument "${t}" after flags. ${ADD_USAGE}` };
  }

  const goal = goalParts.join(" ").trim();
  if (!goal) return { kind: "error", message: `a goal is required. ${ADD_USAGE}` };

  const triggerCount = [every, cron, watch].filter((x) => x != null).length;
  if (triggerCount !== 1) return { kind: "error", message: `exactly one of --every / --cron / --watch is required. ${ADD_USAGE}` };

  let trigger: Trigger;
  if (every != null) {
    const ms = parseDuration(every);
    if (ms == null || ms <= 0) return { kind: "error", message: `bad --every "${every}" (try 30m, 1h, 500ms)` };
    trigger = { kind: "interval", everyMs: ms };
  } else if (cron != null) {
    const parsed = Trigger.safeParse({ kind: "cron", expr: cron });
    if (!parsed.success) return { kind: "error", message: `bad --cron "${cron}"` };
    trigger = parsed.data;
  } else {
    trigger = { kind: "watch", path: watch! };
  }

  let approve: ScheduleApprove | undefined;
  if (approveRaw != null) {
    const p = ScheduleApprove.safeParse(approveRaw);
    if (!p.success) return { kind: "error", message: `--approve must be reject or approve (got "${approveRaw}")` };
    approve = p.data;
  }
  return { kind: "add", spec: { goal, agent, trigger, approve, id } };
}

export function describeTrigger(t: Trigger): string {
  switch (t.kind) {
    case "cron": return `cron "${t.expr}" (UTC)`;
    case "interval": return `every ${t.everyMs}ms`;
    case "watch": return `watch ${t.path}`;
  }
}

/** One-line render of a schedule for `/schedules list` and `taicho schedule list`. */
export function formatScheduleLine(s: Schedule): string {
  const state = s.enabled ? "on" : "off";
  const last = s.lastStatus ? ` · last:${s.lastStatus}` : "";
  const runs = s.runCount ? ` · runs:${s.runCount}` : "";
  const next = s.nextDueAt ? ` · next:${s.nextDueAt}` : "";
  return `  [${s.id}] (${state}) ${s.agent}: ${s.goal} · ${describeTrigger(s.trigger)} · approvals:${s.approve}${runs}${last}${next}`;
}
