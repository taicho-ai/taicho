import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspace } from "../store/files";
import { listSchedules } from "../store/schedules";
import { parseScheduleCommand } from "./scheduler";
import { runScheduleCli } from "./schedule-cli";

async function ws() {
  const dir = mkdtempSync(join(tmpdir(), "taicho-sched-cli-"));
  await ensureWorkspace(dir);
  return dir;
}

// ── parseScheduleCommand (shared by /schedules and `taicho schedule`) ───────

test("bare / list ⇒ list", () => {
  expect(parseScheduleCommand([]).kind).toBe("list");
  expect(parseScheduleCommand(["list"]).kind).toBe("list");
});

test("add with --every builds an interval trigger; goal is the tokens before the first flag", () => {
  const cmd = parseScheduleCommand(["add", "check", "the", "logs", "--every", "30m", "--agent", "root", "--approve", "reject"]);
  expect(cmd).toEqual({ kind: "add", spec: { goal: "check the logs", agent: "root", approve: "reject", id: undefined, trigger: { kind: "interval", everyMs: 1_800_000 } } });
});

test("add with a (pre-tokenized) --cron expression", () => {
  const cmd = parseScheduleCommand(["add", "nightly", "report", "--cron", "0 9 * * *", "--id", "rep"]);
  expect(cmd).toMatchObject({ kind: "add", spec: { goal: "nightly report", id: "rep", trigger: { kind: "cron", expr: "0 9 * * *" } } });
});

test("add with --watch builds a watch trigger", () => {
  const cmd = parseScheduleCommand(["add", "reindex", "--watch", "/data/in.csv"]);
  expect(cmd).toMatchObject({ kind: "add", spec: { trigger: { kind: "watch", path: "/data/in.csv" } } });
});

test("add errors: no trigger, two triggers, no goal, bad approve, unknown flag, goal after a flag", () => {
  expect(parseScheduleCommand(["add", "g"]).kind).toBe("error");                                   // no trigger
  expect(parseScheduleCommand(["add", "g", "--every", "1h", "--cron", "0 0 * * *"]).kind).toBe("error"); // two triggers
  expect(parseScheduleCommand(["add", "--every", "1h"]).kind).toBe("error");                       // no goal
  expect(parseScheduleCommand(["add", "g", "--every", "1h", "--approve", "prompt"]).kind).toBe("error"); // prompt not allowed
  expect(parseScheduleCommand(["add", "g", "--every", "1h", "--bogus"]).kind).toBe("error");       // unknown flag
  expect(parseScheduleCommand(["add", "g", "--every", "1h", "trailing"]).kind).toBe("error");      // positional after a flag
  expect(parseScheduleCommand(["add", "g", "--every", "nope"]).kind).toBe("error");                // bad duration
});

test("remove / run require an id", () => {
  expect(parseScheduleCommand(["remove"]).kind).toBe("error");
  expect(parseScheduleCommand(["remove", "s1"])).toEqual({ kind: "remove", id: "s1" });
  expect(parseScheduleCommand(["run"]).kind).toBe("error");
  expect(parseScheduleCommand(["run", "s1"])).toEqual({ kind: "run", id: "s1" });
});

// ── runScheduleCli: add → list → remove round trip (no model needed) ────────

test("runScheduleCli add persists a schedule; list shows it; remove deletes it", async () => {
  const dir = await ws();
  const out: string[] = [];
  const say = (l: string) => out.push(l);

  expect((await runScheduleCli({ ws: dir, out: say }, ["add", "audit", "logs", "--every", "1h", "--id", "aud"])).ok).toBe(true);
  expect(listSchedules(dir).map((s) => s.id)).toEqual(["aud"]);

  out.length = 0;
  await runScheduleCli({ ws: dir, out: say }, ["list"]);
  expect(out.join("\n")).toContain("aud");
  expect(out.join("\n")).toContain("every 3600000ms");

  out.length = 0;
  expect((await runScheduleCli({ ws: dir, out: say }, ["remove", "aud"])).ok).toBe(true);
  expect(listSchedules(dir).length).toBe(0);
});

test("runScheduleCli list on an empty store says so", async () => {
  const dir = await ws();
  const out: string[] = [];
  await runScheduleCli({ ws: dir, out: (l) => out.push(l) }, ["list"]);
  expect(out.join("\n")).toContain("no schedules");
});

test("runScheduleCli add reports the validation error for a bad cron and persists nothing", async () => {
  const dir = await ws();
  const out: string[] = [];
  const r = await runScheduleCli({ ws: dir, out: (l) => out.push(l) }, ["add", "g", "--cron", "not a cron"]);
  expect(r.ok).toBe(false);
  expect(out.join("\n")).toContain("could not add schedule");
  expect(listSchedules(dir).length).toBe(0);
});

test("runScheduleCli run fires the schedule once through the injected fire seam", async () => {
  const dir = await ws();
  const out: string[] = [];
  await runScheduleCli({ ws: dir, out: (l) => out.push(l) }, ["add", "daily", "--every", "1d", "--id", "d1"]);

  const fired: string[] = [];
  const r = await runScheduleCli(
    { ws: dir, out: (l) => out.push(l), fire: async (s) => { fired.push(s.id); return { ok: true, runId: "root/run-x", outcome: "completed" }; } },
    ["run", "d1"],
  );
  expect(r.ok).toBe(true);
  expect(fired).toEqual(["d1"]);
  expect(out.join("\n")).toContain("run root/run-x");
});

test("runScheduleCli run on an unknown id fails cleanly", async () => {
  const dir = await ws();
  const out: string[] = [];
  const r = await runScheduleCli({ ws: dir, out: (l) => out.push(l), fire: async () => ({ ok: true }) }, ["run", "nope"]);
  expect(r.ok).toBe(false);
  expect(out.join("\n")).toContain('no schedule "nope"');
});
