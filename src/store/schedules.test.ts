import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspace } from "./files";
import { createSchedule, readSchedule, listSchedules, updateSchedule, removeSchedule } from "./schedules";

async function ws() {
  const dir = mkdtempSync(join(tmpdir(), "taicho-sched-store-"));
  await ensureWorkspace(dir);
  return dir;
}

test("createSchedule persists a schedule that readSchedule/listSchedules read back", async () => {
  const dir = await ws();
  const s = createSchedule(dir, { goal: "audit the logs", agent: "root", trigger: { kind: "interval", everyMs: 3600_000 } });
  expect(s.enabled).toBe(true);
  expect(s.approve).toBe("reject"); // unattended-safe default
  expect(s.runCount).toBe(0);

  const back = readSchedule(dir, s.id);
  expect(back?.goal).toBe("audit the logs");
  expect(listSchedules(dir).map((x) => x.id)).toContain(s.id);
});

test("a schedule survives a 'restart' — a fresh listSchedules re-reads it from files", async () => {
  const dir = await ws();
  createSchedule(dir, { id: "nightly", goal: "g", trigger: { kind: "cron", expr: "0 9 * * *" } });
  // No in-memory state carried — listSchedules only reads the files (files are canon).
  const reloaded = listSchedules(dir);
  expect(reloaded.map((x) => x.id)).toEqual(["nightly"]);
  expect(reloaded[0]!.trigger).toEqual({ kind: "cron", expr: "0 9 * * *" });
});

test("createSchedule validates the trigger — a bad cron expression throws at creation, not at fire", async () => {
  const dir = await ws();
  expect(() => createSchedule(dir, { goal: "g", trigger: { kind: "cron", expr: "not a cron" } })).toThrow();
  // an impossible date is also rejected up front
  expect(() => createSchedule(dir, { goal: "g", trigger: { kind: "cron", expr: "0 0 30 2 *" } })).toThrow(/no match/);
  expect(listSchedules(dir).length).toBe(0); // nothing persisted for the invalid ones
});

test("a duplicate explicit id is rejected", async () => {
  const dir = await ws();
  createSchedule(dir, { id: "dup", goal: "g", trigger: { kind: "interval", everyMs: 1000 } });
  expect(() => createSchedule(dir, { id: "dup", goal: "g2", trigger: { kind: "interval", everyMs: 1000 } })).toThrow(/already exists/);
});

test("updateSchedule patches only the given fields (never clobbers the rest)", async () => {
  const dir = await ws();
  const s = createSchedule(dir, { goal: "g", trigger: { kind: "interval", everyMs: 1000 } });
  updateSchedule(dir, s.id, { runCount: 3, nextDueAt: "2026-07-04T01:00:00.000Z" });
  updateSchedule(dir, s.id, { lastRunId: "root/run-1", lastStatus: "completed" }); // a separate patch
  const back = readSchedule(dir, s.id)!;
  expect(back.runCount).toBe(3);                 // preserved across the second patch
  expect(back.nextDueAt).toBe("2026-07-04T01:00:00.000Z");
  expect(back.lastRunId).toBe("root/run-1");
  expect(back.lastStatus).toBe("completed");
  expect(back.goal).toBe("g");                   // untouched
});

test("removeSchedule deletes the file; a second remove is a no-op", async () => {
  const dir = await ws();
  const s = createSchedule(dir, { goal: "g", trigger: { kind: "interval", everyMs: 1000 } });
  expect(removeSchedule(dir, s.id)).toBe(true);
  expect(readSchedule(dir, s.id)).toBeNull();
  expect(removeSchedule(dir, s.id)).toBe(false);
});

test("an explicit id is sanitized to be filesystem-safe", async () => {
  const dir = await ws();
  const s = createSchedule(dir, { id: "weird id/../x", goal: "g", trigger: { kind: "interval", everyMs: 1000 } });
  expect(s.id).not.toContain("/");
  expect(readSchedule(dir, s.id)?.goal).toBe("g");
});
