import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "./migrate";
import {
  makeSpendLedger,
  readSpendTotals,
  ceilingHit,
  hasCeilings,
  hasAnyCeilings,
  exhaustionMessage,
  scopesFor,
  teamScope,
  SQUAD_SCOPE,
  dayKey,
  isoWeekKey,
  type SpendTotals,
} from "./spend-ledger";

function memDb(): Database {
  const db = new Database(":memory:");
  migrate(db); // creates squad_spend, scoped (migrations v6 -> v9)
  return db;
}

test("add() accumulates day + week counters", () => {
  const db = memDb();
  const at = new Date("2026-07-04T10:00:00Z");
  const led = makeSpendLedger(db, { squad: { dailyTokens: 1000 } }, () => at);
  led.add([SQUAD_SCOPE], { tokens: 100, costUsd: 1.5 });
  led.add([SQUAD_SCOPE], { tokens: 40, costUsd: 0.5 });
  expect(led.current(SQUAD_SCOPE)).toEqual({ dayTokens: 140, weekTokens: 140, dayCostUsd: 2, weekCostUsd: 2 });
});

test("the day counter RESETS on the day boundary; the week counter carries", () => {
  const db = memDb();
  let clock = new Date("2026-07-04T23:00:00Z"); // Saturday
  const led = makeSpendLedger(db, {}, () => clock);
  led.add([SQUAD_SCOPE], { tokens: 100, costUsd: 1 });
  expect(led.current(SQUAD_SCOPE).dayTokens).toBe(100);

  clock = new Date("2026-07-05T01:00:00Z"); // Sunday — new UTC day, SAME ISO week
  const c = led.current(SQUAD_SCOPE);
  expect(c.dayTokens).toBe(0);   // new day key ⇒ reads 0
  expect(c.weekTokens).toBe(100); // same week ⇒ still counted
  led.add([SQUAD_SCOPE], { tokens: 50, costUsd: 0.5 });
  expect(led.current(SQUAD_SCOPE)).toEqual({ dayTokens: 50, weekTokens: 150, dayCostUsd: 0.5, weekCostUsd: 1.5 });
});

test("the week counter RESETS on the ISO-week boundary", () => {
  const db = memDb();
  let clock = new Date("2026-07-05T12:00:00Z"); // Sunday, last day of its ISO week
  const led = makeSpendLedger(db, {}, () => clock);
  led.add([SQUAD_SCOPE], { tokens: 200, costUsd: 2 });
  expect(led.current(SQUAD_SCOPE).weekTokens).toBe(200);

  clock = new Date("2026-07-06T12:00:00Z"); // Monday — new ISO week
  expect(led.current(SQUAD_SCOPE).weekTokens).toBe(0);
  expect(led.current(SQUAD_SCOPE).dayTokens).toBe(0);
});

test("spend PERSISTS across sessions (a fresh ledger over the same DB file sees prior spend)", () => {
  const dir = mkdtempSync(join(tmpdir(), "spend-ledger-"));
  const file = join(dir, "t.db");
  const at = new Date("2026-07-04T10:00:00Z");

  const db1 = new Database(file);
  migrate(db1);
  makeSpendLedger(db1, {}, () => at).add([SQUAD_SCOPE], { tokens: 500, costUsd: 3 });
  db1.close();

  // Reopen — simulates a new process/session. The counter lives in the DB, not the ledger object.
  const db2 = new Database(file);
  migrate(db2);
  expect(readSpendTotals(db2, () => at)).toEqual({ dayTokens: 500, weekTokens: 500, dayCostUsd: 3, weekCostUsd: 3 });
  const led2 = makeSpendLedger(db2, {}, () => at);
  led2.add([SQUAD_SCOPE], { tokens: 100, costUsd: 1 });
  expect(led2.current(SQUAD_SCOPE).dayTokens).toBe(600);
  db2.close();
});

const spend = (over: Partial<SpendTotals> = {}): SpendTotals =>
  ({ dayTokens: 0, weekTokens: 0, dayCostUsd: 0, weekCostUsd: 0, ...over });

test("ceilingHit fires per configured ceiling, else null", () => {
  expect(ceilingHit(spend({ dayTokens: 999 }), { dailyTokens: 1000 })).toBeNull();
  expect(ceilingHit(spend({ dayTokens: 1000 }), { dailyTokens: 1000 })).toContain("daily token ceiling");
  expect(ceilingHit(spend({ weekTokens: 5000 }), { weeklyTokens: 5000 })).toContain("weekly token ceiling");
  expect(ceilingHit(spend({ dayCostUsd: 10 }), { dailyCostUsd: 10 })).toContain("daily USD ceiling");
  expect(ceilingHit(spend({ weekCostUsd: 50 }), { weeklyCostUsd: 50 })).toContain("weekly USD ceiling");
  // No ceilings set ⇒ never hit, whatever the spend.
  expect(ceilingHit(spend({ dayTokens: 1e9, dayCostUsd: 1e9 }), {})).toBeNull();
});

test("hasCeilings distinguishes an empty budgets block from a configured one", () => {
  expect(hasCeilings(undefined)).toBe(false);
  expect(hasCeilings({})).toBe(false);
  expect(hasCeilings({ dailyTokens: 1 })).toBe(true);
  expect(hasCeilings({ weeklyCostUsd: 0.01 })).toBe(true);
});

test("period keys: UTC day and ISO week", () => {
  expect(dayKey(new Date("2026-07-04T23:59:59Z"))).toBe("2026-07-04");
  // Same ISO week (Mon 2026-06-29 … Sun 2026-07-05) shares a key; the following Monday starts a new one.
  expect(isoWeekKey(new Date("2026-07-04T00:00:00Z"))).toBe(isoWeekKey(new Date("2026-07-05T00:00:00Z")));
  expect(isoWeekKey(new Date("2026-07-05T00:00:00Z"))).not.toBe(isoWeekKey(new Date("2026-07-06T00:00:00Z")));
  // ISO year rule: 2026-12-31 (Thursday) is week 53 of 2026.
  expect(isoWeekKey(new Date("2026-12-31T00:00:00Z"))).toBe("2026-W53");
});

// --- Plan 19: two scopes, one meter ---------------------------------------------------------------

test("a team run commits to BOTH scopes, and the counters stay independent", () => {
  const db = memDb();
  const at = new Date("2026-07-04T10:00:00Z");
  const led = makeSpendLedger(db, { squad: { dailyTokens: 1000 }, teams: { trading: { dailyTokens: 100 } } }, () => at);

  led.add(scopesFor("trading"), { tokens: 60, costUsd: 1 });
  led.add(scopesFor(null), { tokens: 30, costUsd: 0.5 }); // an unaffiliated agent

  expect(led.current(teamScope("trading")).dayTokens).toBe(60);  // only its own runs
  expect(led.current(SQUAD_SCOPE).dayTokens).toBe(90);           // everything
  expect(led.current(teamScope("news")).dayTokens).toBe(0);      // an unconfigured team reads 0
});

test("a team ceiling stops work the squad ceiling would have allowed", () => {
  const db = memDb();
  const at = new Date("2026-07-04T10:00:00Z");
  const led = makeSpendLedger(db, { squad: { dailyTokens: 10_000 }, teams: { trading: { dailyTokens: 100 } } }, () => at);
  led.add(scopesFor("trading"), { tokens: 100, costUsd: 0 });

  expect(ceilingHit(led.current(SQUAD_SCOPE), led.ceilings(SQUAD_SCOPE)!)).toBeNull();          // squad: plenty left
  expect(ceilingHit(led.current(teamScope("trading")), led.ceilings(teamScope("trading"))!)).toContain("daily token ceiling");
});

test("ceilings(scope) is undefined for a scope with nothing configured, so the loop skips its DB read", () => {
  const db = memDb();
  const led = makeSpendLedger(db, { squad: { dailyTokens: 10 }, teams: { news: {} } });
  expect(led.ceilings(SQUAD_SCOPE)).toEqual({ dailyTokens: 10 });
  expect(led.ceilings(teamScope("news"))).toBeUndefined();   // present but empty
  expect(led.ceilings(teamScope("ghost"))).toBeUndefined();  // absent entirely
});

test("scopesFor puts the NARROWER scope first, so the more actionable message wins", () => {
  expect(scopesFor("trading")).toEqual(["team:trading", "squad"]);
  expect(scopesFor(null)).toEqual(["squad"]);
  expect(scopesFor(undefined)).toEqual(["squad"]);
});

test("exhaustionMessage names the scope that tripped", () => {
  expect(exhaustionMessage(SQUAD_SCOPE, "daily token ceiling reached (10/10 tok)")).toBe("[squad budget exhausted: daily token ceiling reached (10/10 tok)]");
  expect(exhaustionMessage(teamScope("trading"), "daily USD ceiling reached ($25.00/$25.00)")).toBe("[team budget exhausted: trading, daily USD ceiling reached ($25.00/$25.00)]");
});

test("hasAnyCeilings: the subsystem stays off unless the squad OR some team configures one", () => {
  expect(hasAnyCeilings({})).toBe(false);
  expect(hasAnyCeilings({ squad: {}, teams: { news: {} } })).toBe(false);
  expect(hasAnyCeilings({ squad: { dailyTokens: 1 } })).toBe(true);
  expect(hasAnyCeilings({ teams: { trading: { weeklyCostUsd: 5 } } })).toBe(true); // team alone is enough
});
