/** Provider- and persistence-neutral spend enforcement port for a single agent loop. */
export type SpendScope = "squad" | `team:${string}`;

export const SQUAD_SCOPE: SpendScope = "squad";
export const teamScope = (teamId: string): SpendScope => `team:${teamId}`;

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

/** A host may back this with SQLite, Redis, an API, or an in-memory counter. */
export interface SpendLedger {
  ceilings(scope: SpendScope): SpendCeilings | undefined;
  current(scope: SpendScope): SpendTotals;
  add(scopes: SpendScope[], delta: { tokens: number; costUsd: number }): void;
}

export function hasCeilings(c: SpendCeilings | undefined): c is SpendCeilings {
  return !!c && (c.dailyTokens != null || c.weeklyTokens != null || c.dailyCostUsd != null || c.weeklyCostUsd != null);
}

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

export function exhaustionMessage(scope: SpendScope, hit: string): string {
  return scope === SQUAD_SCOPE
    ? `[squad budget exhausted: ${hit}]`
    : `[team budget exhausted: ${scope.slice("team:".length)}, ${hit}]`;
}
