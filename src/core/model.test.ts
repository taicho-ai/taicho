import { test, expect } from "bun:test";
import { buildModel, createModelResolver } from "./model";
import { TaichoConfig } from "../store/config";

test("builds an anthropic model carrying the requested id", () => {
  const m = buildModel({ provider: "anthropic", model: "claude-sonnet-4-6" });
  expect(m).toBeTruthy();
  // AI SDK provider models expose modelId
  expect((m as { modelId: string }).modelId).toBe("claude-sonnet-4-6");
  // ...and a provider string that distinguishes the backend ("anthropic.messages")
  expect((m as { provider: string }).provider).toContain("anthropic");
});

test("builds an openai model carrying the requested id", () => {
  const m = buildModel({ provider: "openai", model: "gpt-5.5" });
  expect((m as { modelId: string }).modelId).toBe("gpt-5.5");
  // provider string distinguishes the backend ("openai.responses")
  expect((m as { provider: string }).provider).toContain("openai");
});

test("resolveModel: per-agent override beats defaults beats fallback", () => {
  const config = TaichoConfig.parse({ defaults: { model: "claude-opus-4-8" }, agents: { writer: { provider: "openai", model: "gpt-5.5" } } });
  const { resolveModel } = createModelResolver({ config, fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } });
  expect(resolveModel("writer").modelId).toBe("gpt-5.5");
  expect(resolveModel("writer").provider).toBe("openai");
  expect(resolveModel("other").modelId).toBe("claude-opus-4-8"); // defaults
});

test("resolveModel: falls back when config is empty", () => {
  const { resolveModel } = createModelResolver({ config: TaichoConfig.parse({}), fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } });
  expect(resolveModel("x").modelId).toBe("claude-sonnet-4-6");
});

test("resolveModel caches one instance per provider:model", () => {
  const { resolveModel } = createModelResolver({ config: TaichoConfig.parse({}), fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } });
  expect(resolveModel("a").model).toBe(resolveModel("b").model); // same provider:model -> same cached instance
});
