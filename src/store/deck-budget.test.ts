import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "./migrate";
import {
  makeDeckLedger,
  readDeckSpend,
  deckCeilingHit,
  hasCeilings,
  dayKey,
  isoWeekKey,
  type DeckSpend,
} from "./deck-budget";

function memDb(): Database {
  const db = new Database(":memory:");
  migrate(db); // creates the deck_spend table (migration v6)
  return db;
}

test("add() accumulates day + week counters", () => {
  const db = memDb();
  const at = new Date("2026-07-04T10:00:00Z");
  const led = makeDeckLedger(db, { dailyTokens: 1000 }, () => at);
  led.add({ tokens: 100, costUsd: 1.5 });
  led.add({ tokens: 40, costUsd: 0.5 });
  expect(led.current()).toEqual({ dayTokens: 140, weekTokens: 140, dayCostUsd: 2, weekCostUsd: 2 });
});

test("the day counter RESETS on the day boundary; the week counter carries", () => {
  const db = memDb();
  let clock = new Date("2026-07-04T23:00:00Z"); // Saturday
  const led = makeDeckLedger(db, {}, () => clock);
  led.add({ tokens: 100, costUsd: 1 });
  expect(led.current().dayTokens).toBe(100);

  clock = new Date("2026-07-05T01:00:00Z"); // Sunday — new UTC day, SAME ISO week
  const c = led.current();
  expect(c.dayTokens).toBe(0);   // new day key ⇒ reads 0
  expect(c.weekTokens).toBe(100); // same week ⇒ still counted
  led.add({ tokens: 50, costUsd: 0.5 });
  expect(led.current()).toEqual({ dayTokens: 50, weekTokens: 150, dayCostUsd: 0.5, weekCostUsd: 1.5 });
});

test("the week counter RESETS on the ISO-week boundary", () => {
  const db = memDb();
  let clock = new Date("2026-07-05T12:00:00Z"); // Sunday, last day of its ISO week
  const led = makeDeckLedger(db, {}, () => clock);
  led.add({ tokens: 200, costUsd: 2 });
  expect(led.current().weekTokens).toBe(200);

  clock = new Date("2026-07-06T12:00:00Z"); // Monday — new ISO week
  expect(led.current().weekTokens).toBe(0);
  expect(led.current().dayTokens).toBe(0);
});

test("spend PERSISTS across sessions (a fresh ledger over the same DB file sees prior spend)", () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-budget-"));
  const file = join(dir, "t.db");
  const at = new Date("2026-07-04T10:00:00Z");

  const db1 = new Database(file);
  migrate(db1);
  makeDeckLedger(db1, {}, () => at).add({ tokens: 500, costUsd: 3 });
  db1.close();

  // Reopen — simulates a new process/session. The counter lives in the DB, not the ledger object.
  const db2 = new Database(file);
  migrate(db2);
  expect(readDeckSpend(db2, () => at)).toEqual({ dayTokens: 500, weekTokens: 500, dayCostUsd: 3, weekCostUsd: 3 });
  const led2 = makeDeckLedger(db2, {}, () => at);
  led2.add({ tokens: 100, costUsd: 1 });
  expect(led2.current().dayTokens).toBe(600);
  db2.close();
});

const spend = (over: Partial<DeckSpend> = {}): DeckSpend =>
  ({ dayTokens: 0, weekTokens: 0, dayCostUsd: 0, weekCostUsd: 0, ...over });

test("deckCeilingHit fires per configured ceiling, else null", () => {
  expect(deckCeilingHit(spend({ dayTokens: 999 }), { dailyTokens: 1000 })).toBeNull();
  expect(deckCeilingHit(spend({ dayTokens: 1000 }), { dailyTokens: 1000 })).toContain("daily token ceiling");
  expect(deckCeilingHit(spend({ weekTokens: 5000 }), { weeklyTokens: 5000 })).toContain("weekly token ceiling");
  expect(deckCeilingHit(spend({ dayCostUsd: 10 }), { dailyCostUsd: 10 })).toContain("daily USD ceiling");
  expect(deckCeilingHit(spend({ weekCostUsd: 50 }), { weeklyCostUsd: 50 })).toContain("weekly USD ceiling");
  // No ceilings set ⇒ never hit, whatever the spend.
  expect(deckCeilingHit(spend({ dayTokens: 1e9, dayCostUsd: 1e9 }), {})).toBeNull();
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
