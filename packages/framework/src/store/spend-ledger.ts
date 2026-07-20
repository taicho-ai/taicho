/** Plan 09 + Plan 19: rolling spend ceilings, at two scopes. The agent loop is the one meter (tokens +
 *  advisory USD); this is the durable rolling counter it reads/commits against so ceilings SPAN SESSIONS.
 *
 *  Counters are keyed by scope × UTC day (YYYY-MM-DD) / ISO week (YYYY-Www): when the day/week rolls over
 *  the key changes and the new period naturally reads 0 — no explicit reset. Files/traces stay canon for
 *  reporting (`/costs`); this table is a fast, purpose-built enforcement counter, not a second ledger of
 *  record. USD is only ever accumulated for PRICED runs — a subscription/unpriced call commits 0 USD (its
 *  tokens still count), so a USD ceiling never fabricates spend it cannot measure.
 *
 *  A run on a team is metered against BOTH scopes in one transaction: the team's ceiling and the squad's.
 *  A team ceiling can therefore stop a run the squad ceiling would happily have allowed. */
import type { Database } from "bun:sqlite";
import { DEFAULT_TEAM_ID } from "@taicho-ai/contracts/team";
import {
  SQUAD_SCOPE, teamScope, hasCeilings,
  type SpendScope, type SpendCeilings, type SpendTotals, type SpendLedger,
} from "@taicho-ai/agent";
export {
  SQUAD_SCOPE, teamScope, hasCeilings, ceilingHit, exhaustionMessage,
  type SpendScope, type SpendCeilings, type SpendTotals, type SpendLedger,
} from "@taicho-ai/agent";

/** The scopes a run by an agent on these teams is metered against (Plan 22: an agent may be on several).
 *  Every explicit team the agent belongs to gets its own ceiling, plus the always-present squad. The
 *  implicit `default` team is dropped — it IS the squad, so metering it separately would double-count.
 *  Order matters only for which exhaustion message the captain sees first, and the narrower (team) ones
 *  come before the squad because they are more actionable. */
export function scopesFor(teams?: string[] | string | null): SpendScope[] {
  const list = teams == null ? [] : Array.isArray(teams) ? teams : [teams];
  const explicit = [...new Set(list.filter((t) => t && t !== DEFAULT_TEAM_ID))];
  return [...explicit.map(teamScope), SQUAD_SCOPE];
}

/** Every ceiling this session enforces: the squad's, and each configured team's. */
export interface CeilingConfig {
  squad?: SpendCeilings;
  teams?: Record<string, SpendCeilings | undefined>;
}

/** The seam the loop enforces against: read a scope's running total, commit a call's spend to every
 *  scope it belongs to. Bound to the DB + configured ceilings so the loop stays provider-agnostic. */
/** True when at least one ceiling is configured — callers skip building a ledger (and its per-call
 *  DB reads) entirely when there's nothing to enforce, preserving pre-Plan-09 behavior. */
/** True when the squad OR any team has a ceiling. With none, the whole subsystem stays off. */
export function hasAnyCeilings(c: CeilingConfig): boolean {
  return hasCeilings(c.squad) || Object.values(c.teams ?? {}).some((t) => hasCeilings(t));
}

/** Which ceiling (if any) the current running total has already reached — a human message, else null.
 *  Uses `>=` so it refuses the NEXT call once a limit is met, mirroring the per-run cap check. */
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

function readPeriod(db: Database, scope: SpendScope, kind: "day" | "week", key: string): { tokens: number; cost: number } {
  const r = db
    .query("SELECT tokens, cost_usd FROM squad_spend WHERE scope = ? AND period_kind = ? AND period_key = ?")
    .get(scope, kind, key) as { tokens: number; cost_usd: number } | null;
  return { tokens: r?.tokens ?? 0, cost: r?.cost_usd ?? 0 };
}

/** Read a scope's current day + week running totals without building a full ledger (used by /costs'
 *  header and tests). Reflects only spend committed while a ceiling was configured. */
export function readSpendTotals(db: Database, now: () => Date = () => new Date(), scope: SpendScope = SQUAD_SCOPE): SpendTotals {
  const d = now();
  const day = readPeriod(db, scope, "day", dayKey(d));
  const week = readPeriod(db, scope, "week", isoWeekKey(d));
  return { dayTokens: day.tokens, weekTokens: week.tokens, dayCostUsd: day.cost, weekCostUsd: week.cost };
}

/** A DB-backed spend ledger. `now` is injectable so tests can cross day/week boundaries deterministically. */
export function makeSpendLedger(db: Database, config: CeilingConfig, now: () => Date = () => new Date()): SpendLedger {
  const upsert = db.query(
    `INSERT INTO squad_spend (scope, period_kind, period_key, tokens, cost_usd, updated)
     VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(scope, period_kind, period_key) DO UPDATE SET
       tokens = tokens + excluded.tokens,
       cost_usd = cost_usd + excluded.cost_usd,
       updated = unixepoch()`,
  );
  return {
    ceilings: (scope) => {
      const c = scope === SQUAD_SCOPE ? config.squad : config.teams?.[scope.slice("team:".length)];
      return hasCeilings(c) ? c : undefined;
    },
    current: (scope) => readSpendTotals(db, now, scope),
    add: (scopes, { tokens, costUsd }) => {
      if ((tokens === 0 && costUsd === 0) || !scopes.length) return;
      const d = now();
      // One transaction across every scope: a crash must not leave the team charged and the squad not.
      db.transaction(() => {
        for (const scope of scopes) {
          upsert.run(scope, "day", dayKey(d), tokens, costUsd);
          upsert.run(scope, "week", isoWeekKey(d), tokens, costUsd);
        }
      })();
    },
  };
}
