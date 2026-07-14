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

test("builds an openrouter model carrying the namespaced slug, and never warns mismatch", () => {
  const m = buildModel({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
  expect((m as { modelId: string }).modelId).toBe("anthropic/claude-sonnet-4.5");
});

test("openrouter without an explicit model throws an actionable error", () => {
  expect(() => buildModel({ provider: "openrouter", model: "" })).toThrow(/OpenRouter requires an explicit/);
});

test("openrouter rejects a non-namespaced slug (a first-party default bleeding in)", () => {
  // A per-agent `provider: openrouter` override with no model can inherit a first-party fallback
  // like "claude-sonnet-4-6"; require vendor/model so that fails fast, not as an opaque 400.
  expect(() => buildModel({ provider: "openrouter", model: "claude-sonnet-4-6" })).toThrow(/namespaced/);
});

test("resolveModel: openrouter override inheriting a non-namespaced fallback throws", () => {
  const config = TaichoConfig.parse({ agents: { writer: { provider: "openrouter" } } });
  const { resolveModel } = createModelResolver({ config, fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } });
  expect(() => resolveModel("writer")).toThrow(/namespaced/);
});

test("resolveModel: openrouter sets captureCost and requires a model", () => {
  const config = TaichoConfig.parse({ defaults: { provider: "openrouter", model: "openai/gpt-4o" } });
  const { resolveModel } = createModelResolver({ config, fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } });
  const r = resolveModel("x");
  expect(r.provider).toBe("openrouter");
  expect(r.modelId).toBe("openai/gpt-4o");
  expect(r.captureCost).toBe(true);
});

test("resolveModel: non-openrouter providers do not set captureCost", () => {
  const { resolveModel } = createModelResolver({ config: TaichoConfig.parse({}), fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } });
  expect(resolveModel("x").captureCost).toBeUndefined();
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

test("resolveModel resolves provider and model independently (partial override keeps the inherited axis)", () => {
  const config = TaichoConfig.parse({ defaults: { provider: "anthropic", model: "claude-sonnet-4-6" }, agents: { writer: { model: "gpt-5.5" } } });
  const { resolveModel } = createModelResolver({ config, fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } });
  const r = resolveModel("writer");
  expect(r.modelId).toBe("gpt-5.5");      // per-agent model
  expect(r.provider).toBe("anthropic");   // provider inherited from defaults (independent axes); warning fires
});

// --- Plan 19: model resolution walks agent -> team -> defaults -------------------------------------

test("resolveModel prefers the agent override, then its team's, then defaults", () => {
  const config = {
    defaults: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
    teams: { trading: { provider: "anthropic" as const, model: "claude-opus-4-8" } },
    agents: { quant: { model: "claude-haiku-4-5" } },
  };
  const fallback = { provider: "anthropic" as const, model: "claude-sonnet-4-6" };
  const teamsOf = (id: string) => (id === "quant" || id === "riskdesk" ? ["trading"] : []);
  const { resolveModel } = createModelResolver({ config, fallback, teamsOf });

  expect(resolveModel("quant").modelId).toBe("claude-haiku-4-5");   // agent wins over its team
  expect(resolveModel("riskdesk").modelId).toBe("claude-opus-4-8"); // team wins over defaults
  expect(resolveModel("root").modelId).toBe("claude-sonnet-4-6");   // unaffiliated falls to defaults
});

test("resolveModel with no teamOf injected behaves exactly as it did before Plan 19", () => {
  const config = { defaults: { model: "claude-sonnet-4-6" }, teams: { trading: { model: "claude-opus-4-8" } } };
  const fallback = { provider: "anthropic" as const, model: "claude-sonnet-4-6" };
  const { resolveModel } = createModelResolver({ config, fallback });
  expect(resolveModel("quant").modelId).toBe("claude-sonnet-4-6"); // teams config is inert without teamOf
});
