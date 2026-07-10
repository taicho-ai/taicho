/** Plan 09: deck-wide spend ceilings. The agent loop is the one meter (tokens + advisory USD); this
 *  is the durable rolling counter it reads/commits against so ceilings SPAN SESSIONS. Counters are
 *  keyed by UTC day (YYYY-MM-DD) and ISO week (YYYY-Www): when the day/week rolls over the key
 *  changes and the new period naturally reads 0 — no explicit reset. Files/traces stay canon for
 *  reporting (`/costs`); this table is a fast, purpose-built enforcement counter, not a second ledger
 *  of record. USD is only ever accumulated for PRICED runs — a subscription/unpriced call commits 0
 *  USD (its tokens still count), so a USD ceiling never fabricates spend it cannot measure. */
import type { Database } from "bun:sqlite";

export interface SpendCeilings {
  dailyTokens?: number;
  weeklyTokens?: number;
  dailyCostUsd?: number;
  weeklyCostUsd?: number;
}

export interface SpendTotals {
  dayTokens: number;
  weekTokens: number;
  dayCostUsd: number;
  weekCostUsd: number;
}

/** The seam the loop enforces against: read the running deck total, commit a call's spend. Bound to
 *  the DB + configured ceilings so the loop stays provider-agnostic and needs no DB import. */
export interface SpendLedger {
  ceilings: SpendCeilings;
  current(): SpendTotals;
  add(delta: { tokens: number; costUsd: number }): void;
}

/** True when at least one ceiling is configured — callers skip building a ledger (and its per-call
 *  DB reads) entirely when there's nothing to enforce, preserving pre-Plan-09 behavior. */
export function hasCeilings(c: SpendCeilings | undefined): c is SpendCeilings {
  return !!c && (c.dailyTokens != null || c.weeklyTokens != null || c.dailyCostUsd != null || c.weeklyCostUsd != null);
}

/** Which ceiling (if any) the current running total has already reached — a human message, else null.
 *  Uses `>=` so it refuses the NEXT call once a limit is met, mirroring the per-run cap check. */
export function ceilingHit(spend: SpendTotals, c: SpendCeilings): string | null {
  if (c.dailyTokens != null && spend.dayTokens >= c.dailyTokens)
    return `daily token ceiling reached (${spend.dayTokens.toLocaleString()}/${c.dailyTokens.toLocaleString()} tok)`;
  if (c.weeklyTokens != null && spend.weekTokens >= c.weeklyTokens)
    return `weekly token ceiling reached (${spend.weekTokens.toLocaleString()}/${c.weeklyTokens.toLocaleString()} tok)`;
  if (c.dailyCostUsd != null && spend.dayCostUsd >= c.dailyCostUsd)
    return `daily USD ceiling reached ($${spend.dayCostUsd.toFixed(2)}/$${c.dailyCostUsd.toFixed(2)})`;
  if (c.weeklyCostUsd != null && spend.weekCostUsd >= c.weeklyCostUsd)
    return `weekly USD ceiling reached ($${spend.weekCostUsd.toFixed(2)}/$${c.weeklyCostUsd.toFixed(2)})`;
  return null;
}

/** UTC calendar day key — matches trace.ts's dateStamp so /runs and the ledger agree on "today". */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO-8601 week key (YYYY-Www). The week's year is decided by its Thursday, so late-December /
 *  early-January days land in the correct ISO year — the standard algorithm. */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // move to this week's Thursday
  const thursday = d.getTime();
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((thursday - firstThursday.getTime()) / (7 * 86_400_000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function readPeriod(db: Database, kind: "day" | "week", key: string): { tokens: number; cost: number } {
  const r = db.query("SELECT tokens, cost_usd FROM deck_spend WHERE period_kind = ? AND period_key = ?").get(kind, key) as
    | { tokens: number; cost_usd: number }
    | null;
  return { tokens: r?.tokens ?? 0, cost: r?.cost_usd ?? 0 };
}

/** Read the current day + week running totals without building a full ledger (used by /costs' header
 *  and tests). Reflects only spend committed while a ceiling was configured. */
export function readSpendTotals(db: Database, now: () => Date = () => new Date()): SpendTotals {
  const d = now();
  const day = readPeriod(db, "day", dayKey(d));
  const week = readPeriod(db, "week", isoWeekKey(d));
  return { dayTokens: day.tokens, weekTokens: week.tokens, dayCostUsd: day.cost, weekCostUsd: week.cost };
}

/** A DB-backed deck ledger. `now` is injectable so tests can cross day/week boundaries deterministically. */
export function makeSpendLedger(db: Database, ceilings: SpendCeilings, now: () => Date = () => new Date()): SpendLedger {
  const upsert = db.query(
    `INSERT INTO deck_spend (period_kind, period_key, tokens, cost_usd, updated)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(period_kind, period_key) DO UPDATE SET
       tokens = tokens + excluded.tokens,
       cost_usd = cost_usd + excluded.cost_usd,
       updated = unixepoch()`,
  );
  return {
    ceilings,
    current: () => readSpendTotals(db, now),
    add: ({ tokens, costUsd }) => {
      if (tokens === 0 && costUsd === 0) return;
      const d = now();
      db.transaction(() => {
        upsert.run("day", dayKey(d), tokens, costUsd);
        upsert.run("week", isoWeekKey(d), tokens, costUsd);
      })();
    },
  };
}
