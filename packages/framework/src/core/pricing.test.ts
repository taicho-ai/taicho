import { test, expect } from "bun:test";
import { priceUsd } from "./pricing";

test("prices a known model by input/output split", () => {
  // claude-sonnet-4-6: $3 / $15 per Mtok. 1M in + 1M out = 3 + 15 = 18.
  expect(priceUsd("claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18, 6);
});

test("prorates fractional token counts", () => {
  // 1000 input tokens @ $3/Mtok = 0.003
  expect(priceUsd("claude-sonnet-4-6", { inputTokens: 1000, outputTokens: 0 })).toBeCloseTo(0.003, 9);
});

test("unknown model returns 0 (advisory, never throws)", () => {
  expect(priceUsd("totally-made-up-model", { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
});
