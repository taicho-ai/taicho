/** Plan 09: cross-session cost rollup for `/costs`. Reads run TRACES (the same source /runs and
 *  /trace use) and aggregates each run's OWN spend by agent, day, and model — never trace.aggregate
 *  (which folds in child runs, so summing across the list would double-count). Each run's OWN spend =
 *  its primary loop (tokens/costUsd) PLUS its delegation-checker (verifierTokens/verifierCostUsd): the
 *  verifier makes real, metered model calls but writes NO child trace, so adding its spend here counts
 *  it exactly once. HONESTY RULE: a subscription run records costUsd:null (unmeasurable) — its TOKENS
 *  (loop + verifier) are always reported, and it is NEVER counted as $0 nor mixed into a USD total.
 *  Tokens are the hard, always-honest number; USD is a supplement shown only where genuinely priced.
 *  SCOPE: /costs covers RUN TRACES — the agent loop and its delegation verifier. The `/teach` coaching
 *  distiller (src/coaching/teach.ts) runs OUTSIDE any run and produces no trace; its spend IS metered
 *  against the squad ceiling (spend-ledger.ts) but is not itemized here (there is no trace to attach it to). */
import type { RunTrace } from "../schemas/trace";

export interface CostGroup {
  key: string;
  runs: number;
  tokens: number;
  costUsd: number;            // sum over PRICED runs only (costUsd is a finite number)
  subscriptionRuns: number;   // runs with costUsd:null — USD unmeasurable, reported as tokens
}

export interface CostRollup {
  totals: CostGroup;
  byAgent: CostGroup[];
  byDay: CostGroup[];
  byModel: CostGroup[];
}

function blank(key: string): CostGroup {
  return { key, runs: 0, tokens: 0, costUsd: 0, subscriptionRuns: 0 };
}

function accrue(g: CostGroup, t: RunTrace): void {
  g.runs += 1;
  // Own spend = primary loop + this run's delegation verifier (no child trace holds the verifier's
  // spend, so it's counted exactly once here).
  g.tokens += t.tokens + t.verifierTokens;
  if (t.costUsd == null) g.subscriptionRuns += 1; // subscription/unmeasurable — tokens only, never a $0
  else g.costUsd += t.costUsd + t.verifierCostUsd; // priced run ⇒ include the verifier's USD too
}

/** The "by provider" dimension. We record the resolved model id in the trace; group by it, falling
 *  back to the costNote (subscription) or "unknown" for pre-Plan-09 / headless traces without one. */
function modelKey(t: RunTrace): string {
  return t.model ?? (t.costNote === "subscription" ? "subscription" : "unknown");
}

function groupBy(traces: RunTrace[], keyOf: (t: RunTrace) => string): CostGroup[] {
  const map = new Map<string, CostGroup>();
  for (const t of traces) {
    const k = keyOf(t);
    let g = map.get(k);
    if (!g) { g = blank(k); map.set(k, g); }
    accrue(g, t);
  }
  // Highest-spend first (by tokens — the always-present number).
  return [...map.values()].sort((a, b) => b.tokens - a.tokens);
}

export function rollupCosts(traces: RunTrace[]): CostRollup {
  const totals = blank("total");
  for (const t of traces) accrue(totals, t);
  return {
    totals,
    byAgent: groupBy(traces, (t) => t.agent),
    byDay: groupBy(traces, (t) => t.started.slice(0, 10)),
    byModel: groupBy(traces, modelKey),
  };
}

/** Render one group line: always tokens; USD only when some priced spend exists; a subscription note
 *  when any run in the group was unmeasurable. Never prints "$0.00" as if it were a real measured cost. */
function fmtGroup(g: CostGroup, pad: number): string {
  const usd = g.costUsd > 0 ? ` · $${g.costUsd.toFixed(4)}` : "";
  const sub = g.subscriptionRuns > 0 ? ` · ${g.subscriptionRuns} subscription run(s) (tokens only)` : "";
  return `    ${g.key.padEnd(pad)}  ${g.runs} run(s) · ${g.tokens.toLocaleString()} tok${usd}${sub}`;
}

function section(title: string, groups: CostGroup[]): string[] {
  if (!groups.length) return [];
  const pad = Math.min(28, Math.max(...groups.map((g) => g.key.length)));
  return [`  ${title}:`, ...groups.map((g) => fmtGroup(g, pad))];
}

/** Format the rollup into REPL lines. Leads with the honest total (tokens), then by agent/day/model. */
export function formatCostRollup(r: CostRollup): string[] {
  if (r.totals.runs === 0) return ["  (no runs yet — nothing to cost)"];
  const t = r.totals;
  const usd = t.costUsd > 0 ? `, $${t.costUsd.toFixed(4)} priced` : "";
  const sub = t.subscriptionRuns > 0 ? `, ${t.subscriptionRuns} subscription run(s) (tokens only — no USD)` : "";
  return [
    `  total: ${t.runs} run(s), ${t.tokens.toLocaleString()} tok${usd}${sub}`,
    ...section("by agent", r.byAgent),
    ...section("by day", r.byDay),
    ...section("by model", r.byModel),
  ];
}
