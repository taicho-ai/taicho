import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, mockValues } from "./mock-model";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { ensureWorkspace } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, loadIndex, loadAgent } from "../store/roster";
import { runHeadless } from "./headless";
import { loadLedger } from "../store/conversation";
import { loadThread } from "../store/thread";
import {
  parseCronField, parseCron, cronMatches, nextCronAfter,
  SchedulerRunner, parseDuration,
} from "./scheduler";
import { Schedule, type Schedule as ScheduleT } from "../schemas/schedule";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;
const text = (t: string) =>
  ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
const call = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;

/** Flush the microtask/macrotask queue so the runner's (async) fire has run. NOT a scheduler clock —
 *  the scheduler's own clock is always injected; this only drains the event loop. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function mkSchedule(over: Partial<ScheduleT> & Pick<ScheduleT, "id" | "trigger">): ScheduleT {
  const iso = "2026-07-04T00:00:00.000Z";
  return Schedule.parse({ goal: "do the thing", created: iso, updated: iso, ...over });
}

// ── cron parsing / matching (pure, UTC) ─────────────────────────────────────

test("parseCronField expands *, ranges, lists, and steps", () => {
  const range = { min: 0, max: 59 };
  expect([...parseCronField("*", range)].length).toBe(60);
  expect([...parseCronField("1-5", range)]).toEqual([1, 2, 3, 4, 5]);
  expect([...parseCronField("0,30", range)]).toEqual([0, 30]);
  expect([...parseCronField("*/15", range)]).toEqual([0, 15, 30, 45]);
});

test("parseCron rejects a wrong field count and an out-of-range value", () => {
  expect(() => parseCron("* * * *")).toThrow(/5 fields/);
  expect(() => parseCron("99 * * * *")).toThrow(/bad cron field/);
});

test("cronMatches evaluates minute/hour/step against UTC components", () => {
  const at = (h: number, m: number) => new Date(Date.UTC(2026, 0, 1, h, m));
  expect(cronMatches("* * * * *", at(9, 30))).toBe(true);
  expect(cronMatches("30 9 * * *", at(9, 30))).toBe(true);
  expect(cronMatches("30 9 * * *", at(9, 31))).toBe(false);
  expect(cronMatches("*/15 * * * *", at(9, 15))).toBe(true);
  expect(cronMatches("*/15 * * * *", at(9, 16))).toBe(false);
});

test("cronMatches day rule: dom OR dow when both restricted; the restricted one gates when the other is *", () => {
  // A date that is the 13th of its month; use its ACTUAL dow so the test is TZ/calendar independent.
  const d13 = new Date(Date.UTC(2026, 0, 13, 0, 0));
  const dow = d13.getUTCDay();
  const otherDow = (dow + 1) % 7;
  // both restricted → matches because the DOM matches, even though the DOW does not (OR rule).
  expect(cronMatches(`0 0 13 * ${otherDow}`, d13)).toBe(true);
  // dom is *, dow restricted to a non-matching day → no match (dow gates).
  expect(cronMatches(`0 0 * * ${otherDow}`, d13)).toBe(false);
  // dom is *, dow restricted to the matching day → match.
  expect(cronMatches(`0 0 * * ${dow}`, d13)).toBe(true);
});

test("nextCronAfter returns the next matching minute STRICTLY after the given time", () => {
  const from = Date.UTC(2026, 0, 1, 9, 30);
  expect(nextCronAfter("0 * * * *", from)).toBe(Date.UTC(2026, 0, 1, 10, 0)); // next top-of-hour
  expect(nextCronAfter("*/15 * * * *", Date.UTC(2026, 0, 1, 9, 7))).toBe(Date.UTC(2026, 0, 1, 9, 15));
  // exactly on a match → the NEXT one (strictly after), never the current minute
  expect(nextCronAfter("0 * * * *", Date.UTC(2026, 0, 1, 10, 0))).toBe(Date.UTC(2026, 0, 1, 11, 0));
});

test("parseDuration understands ms/s/m/h/d and a bare integer", () => {
  expect(parseDuration("500ms")).toBe(500);
  expect(parseDuration("30s")).toBe(30_000);
  expect(parseDuration("10m")).toBe(600_000);
  expect(parseDuration("2h")).toBe(7_200_000);
  expect(parseDuration("1d")).toBe(86_400_000);
  expect(parseDuration("1000")).toBe(1000);
  expect(parseDuration("nope")).toBeNull();
});

// ── SchedulerRunner: interval trigger with an INJECTED clock ────────────────

test("an interval schedule fires at its time, not before, and not twice for one due window", async () => {
  let clock = 0;
  const fired: string[] = [];
  const runner = new SchedulerRunner({ now: () => clock, fire: (s) => { fired.push(s.id); } });
  runner.add(mkSchedule({ id: "s1", trigger: { kind: "interval", everyMs: 1000 } })); // nextDue = 0 + 1000

  clock = 500; runner.tick(); await flush();
  expect(fired).toEqual([]);                 // not yet due

  clock = 1000; runner.tick(); await flush();
  expect(fired).toEqual(["s1"]);             // due → fired once

  clock = 1000; runner.tick(); await flush();
  expect(fired).toEqual(["s1"]);             // same window → not again (nextDue advanced to 2000)

  clock = 2000; runner.tick(); await flush();
  expect(fired).toEqual(["s1", "s1"]);       // next interval → fires again
});

test("the runner never re-fires a schedule whose previous run is still in flight", async () => {
  let clock = 0;
  const fired: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const runner = new SchedulerRunner({ now: () => clock, fire: (s) => { fired.push(s.id); return gate; } });
  runner.add(mkSchedule({ id: "s1", trigger: { kind: "interval", everyMs: 1000 } }));

  clock = 1000; runner.tick(); await flush();
  expect(fired).toEqual(["s1"]);             // fires; the run is still in flight (gate unresolved)

  clock = 5000; runner.tick(); await flush(); // well past several intervals, but the first is still running
  expect(fired).toEqual(["s1"]);             // NOT re-fired while in flight

  release(); await flush();                   // the run settles
  clock = 6000; runner.tick(); await flush();
  expect(fired).toEqual(["s1", "s1"]);       // now the next due can fire
});

test("a disabled schedule is armed but never fires", async () => {
  let clock = 0;
  const fired: string[] = [];
  const runner = new SchedulerRunner({ now: () => clock, fire: (s) => { fired.push(s.id); } });
  runner.add(mkSchedule({ id: "off", enabled: false, trigger: { kind: "interval", everyMs: 100 } }));
  clock = 10_000; runner.tick(); await flush();
  expect(fired).toEqual([]);
  expect(runner.has("off")).toBe(true);
});

test("the runner persists advanced scheduling state (runCount / nextDueAt) on fire", async () => {
  let clock = 0;
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const runner = new SchedulerRunner({
    now: () => clock,
    fire: () => {},
    persist: (id, patch) => patches.push({ id, patch }),
  });
  runner.add(mkSchedule({ id: "s1", trigger: { kind: "interval", everyMs: 1000 } }));
  clock = 1000; runner.tick(); await flush();
  expect(patches.length).toBe(1);
  expect(patches[0]!.patch.runCount).toBe(1);
  expect(patches[0]!.patch.nextDueAt).toBe(new Date(2000).toISOString());
});

// ── SchedulerRunner: watch trigger with an INJECTED file-stat ───────────────

test("a watch schedule fires when the file mtime changes, and not otherwise", async () => {
  let clock = 0;
  let mtime = 100; // baseline captured at arm
  const fired: string[] = [];
  const runner = new SchedulerRunner({
    now: () => clock,
    statMtimeMs: () => mtime,
    fire: (s) => { fired.push(s.id); },
  });
  runner.add(mkSchedule({ id: "w1", trigger: { kind: "watch", path: "/some/file" } }));

  clock = 1; runner.tick(); await flush();
  expect(fired).toEqual([]);                 // unchanged mtime → no fire

  mtime = 200; clock = 2; runner.tick(); await flush();
  expect(fired).toEqual(["w1"]);             // mtime moved → fire

  clock = 3; runner.tick(); await flush();
  expect(fired).toEqual(["w1"]);             // unchanged again → no re-fire

  mtime = 300; clock = 4; runner.tick(); await flush();
  expect(fired).toEqual(["w1", "w1"]);       // changed again → fire
});

// ── boot reconciliation: persisted schedules are armed and fire when due ────

test("schedules armed from a persisted list fire when due (boot reconciliation)", async () => {
  let clock = 0;
  const fired: string[] = [];
  const runner = new SchedulerRunner({ now: () => clock, fire: (s) => { fired.push(s.id); } });
  // Simulate boot: arm every persisted schedule (what index/App does with listSchedules on boot).
  const persisted = [
    mkSchedule({ id: "a", trigger: { kind: "interval", everyMs: 1000 } }),
    mkSchedule({ id: "b", enabled: false, trigger: { kind: "interval", everyMs: 500 } }),
  ];
  for (const s of persisted) runner.add(s);
  expect(runner.count()).toBe(2);

  clock = 1000; runner.tick(); await flush();
  expect(fired).toEqual(["a"]);              // enabled one fired; the disabled one stayed silent
});

// ── the fire path is the UNATTENDED headless path: privileged tools auto-reject ─

test("an unattended scheduled run drives runHeadless and auto-rejects a privileged tool (no ghost agent)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-sched-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);

  // The model tries to spawn an agent, then finishes. A scheduled run is unattended, so the approval
  // must be auto-REJECTED — no captain to approve a create_agent, so no unsupervised privileged exec.
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("create_agent", { id: "ghost", role: "x", identity: "y" }), text("could not create it")) as any,
  });

  let firePromise: Promise<unknown> | undefined;
  let clock = 0;
  const runner = new SchedulerRunner({
    now: () => clock,
    fire: (s) => (firePromise = runHeadless({ ws, db, model }, { goal: s.goal, agent: s.agent, approve: s.approve, out: () => {} })),
  });
  runner.add(mkSchedule({ id: "nightly", goal: "spawn a ghost", approve: "reject", trigger: { kind: "interval", everyMs: 1000 } }));

  clock = 1000; runner.tick();
  await flush();                             // let the runner invoke fire (deferred a microtask) …
  await firePromise;                         // … then wait for the detached headless run to complete

  expect(loadIndex(db).some((r) => r.id === "ghost")).toBe(false); // the create_agent approval was rejected
});

// ── a scheduled fire is AUTOMATION, not a conversation turn (Plan 01 Ph5 follow-up) ─
//    Regression: the fire path went runHeadless → executeRun with a HARDCODED triggeredBy "user", so
//    every cron/interval/watch fire appended a user+assistant pair to the target agent's append-only
//    ledger and rebuilt its boot-replay cache — the automation then replayed as prior "conversation" on
//    the next interactive launch. The real wiring now passes triggeredBy `schedule:<id>`; this drives the
//    SAME real scheduler→runHeadless path and proves the fire leaves NO conversation audit, while an
//    explicit `taicho run` (default triggeredBy) STILL audits.

test("a scheduled fire writes NO conversation-ledger turn and does NOT rebuild the replay cache", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-sched-audit-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("nightly report")) as any });

  let firePromise: Promise<unknown> | undefined;
  let clock = 0;
  const runner = new SchedulerRunner({
    now: () => clock,
    // Mirrors the production fire closure (App.tsx / index.tsx): the schedule id becomes the triggeredBy.
    fire: (s) => (firePromise = runHeadless({ ws, db, model }, { goal: s.goal, agent: s.agent, approve: s.approve, triggeredBy: `schedule:${s.id}`, out: () => {} })),
  });
  runner.add(mkSchedule({ id: "nightly", goal: "summarize the logs", agent: "root", approve: "reject", trigger: { kind: "interval", everyMs: 1000 } }));

  clock = 1000; runner.tick();
  await flush();
  await firePromise;

  // The autonomous fire produced run evidence but left the CONVERSATION untouched: no ledger turn …
  expect(loadLedger(ws, "root")).toEqual([]);
  // … and no boot-replay cache rebuild (thread.jsonl stays empty ⇒ nothing replays next launch).
  expect(loadThread(ws, "root")).toEqual([]);
});

test("an explicit `taicho run` (default triggeredBy) STILL audits — the seam distinguishes user from automation", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-sched-audit2-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  await loadAgent(ws, "root");

  // Same headless entrypoint, NO triggeredBy ⇒ a real user turn ⇒ audited (ledger + replay cache).
  await runHeadless({ ws, db, model }, { goal: "hello", out: () => {} });

  const led = loadLedger(ws, "root");
  expect(led.length).toBe(2);                                   // user + assistant recorded
  expect(led[0]).toMatchObject({ role: "user", content: "hello", status: "submitted" });
  expect(loadThread(ws, "root").length).toBeGreaterThan(0);     // boot-replay cache rebuilt
});
