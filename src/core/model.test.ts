import { test, expect } from "bun:test";
import { buildModel } from "./model";

test("builds an anthropic model carrying the requested id", () => {
  const m = buildModel({ provider: "anthropic", model: "claude-sonnet-4-6" });
  expect(m).toBeTruthy();
  // AI SDK provider models expose modelId
  expect((m as { modelId: string }).modelId).toBe("claude-sonnet-4-6");
});

test("builds an openai model carrying the requested id", () => {
  const m = buildModel({ provider: "openai", model: "gpt-5.5" });
  expect((m as { modelId: string }).modelId).toBe("gpt-5.5");
});
