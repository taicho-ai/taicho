import { test, expect } from "bun:test";
import { resolveConfig, isMissing } from "./config";

test("resolves anthropic by default when ANTHROPIC_API_KEY present", () => {
  const c = resolveConfig({ ANTHROPIC_API_KEY: "sk-x" });
  expect(isMissing(c)).toBe(false);
  if (!isMissing(c)) { expect(c.provider).toBe("anthropic"); expect(c.model).toBe("claude-sonnet-4-6"); }
});

test("falls back to openai when only OPENAI_API_KEY present", () => {
  const c = resolveConfig({ OPENAI_API_KEY: "sk-o" });
  expect(isMissing(c) ? null : c.provider).toBe("openai");
});

test("honors TAICHO_PROVIDER and TAICHO_MODEL overrides", () => {
  const c = resolveConfig({ TAICHO_PROVIDER: "openai", OPENAI_API_KEY: "sk-o", TAICHO_MODEL: "gpt-5.5" });
  expect(isMissing(c) ? null : c.model).toBe("gpt-5.5");
});

test("reports missing when no key present", () => {
  expect(isMissing(resolveConfig({}))).toBe(true);
});
