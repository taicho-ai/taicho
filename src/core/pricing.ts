/** Per-model USD pricing for advisory cost accounting. Tokens are the hard budget; cost is
 *  secondary. Values are USD per 1,000,000 tokens. Unknown models price to 0 (never throw). */
import { log } from "./logger";

export interface ModelPrice { inUsdPerMTok: number; outUsdPerMTok: number; }

const TABLE: Record<string, ModelPrice> = {
  "claude-sonnet-4-6": { inUsdPerMTok: 3, outUsdPerMTok: 15 },
  "claude-opus-4-8": { inUsdPerMTok: 15, outUsdPerMTok: 75 },
  "gpt-5.5": { inUsdPerMTok: 5, outUsdPerMTok: 15 },
};

let warned = false;

export function priceUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const p = TABLE[model];
  if (!p) {
    if (!warned) { warned = true; log.warn(`no price for model "${model}" — cost reported as 0`); }
    return 0;
  }
  return (usage.inputTokens / 1_000_000) * p.inUsdPerMTok + (usage.outputTokens / 1_000_000) * p.outUsdPerMTok;
}

/** Build a pricer bound to a resolved model id (the agent loop is provider-agnostic). */
export function pricerFor(model: string): (u: { inputTokens: number; outputTokens: number }) => number {
  return (u) => priceUsd(model, u);
}
