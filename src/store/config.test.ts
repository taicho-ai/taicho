import { test, expect } from "bun:test";
import { resolveConfig, isMissing, loadConfig, resolveAuth, TaichoConfig } from "./config";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("loadConfig returns empty config when no file exists", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-cfg-"));
  const c = await loadConfig(ws);
  expect(c.defaults).toBeUndefined();
  expect(c.agents).toBeUndefined();
});

test("loadConfig parses defaults and per-agent overrides", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-cfg-"));
  writeFileSync(join(ws, "taicho.yaml"),
    "defaults:\n  model: claude-opus-4-8\nagents:\n  writer:\n    provider: openai\n    model: gpt-5.5\n");
  const c = await loadConfig(ws);
  expect(c.defaults?.model).toBe("claude-opus-4-8");
  expect(c.agents?.writer?.provider).toBe("openai");
  expect(c.agents?.writer?.model).toBe("gpt-5.5");
});

test("loadConfig warns and falls back to empty on invalid config", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-cfg-"));
  writeFileSync(join(ws, "taicho.yaml"), "defaults:\n  provider: not-a-provider\n");
  const c = await loadConfig(ws); // invalid enum -> safeParse fails -> {}
  expect(c.defaults).toBeUndefined();
});

const prof = { account_id: "acct", expires_at: 123 };

test("resolveAuth: a signed-in subscription is preferred over an env API key (no override)", () => {
  const c = TaichoConfig.parse({});
  expect(resolveAuth({ env: { OPENAI_API_KEY: "k" }, config: c, loadProfile: () => prof }).kind).toBe("oauth-openai-codex");
});
test("resolveAuth: TAICHO_PROVIDER=openai forces the env API key even with a stored subscription", () => {
  const c = TaichoConfig.parse({});
  expect(resolveAuth({ env: { TAICHO_PROVIDER: "openai", OPENAI_API_KEY: "k" }, config: c, loadProfile: () => prof }).kind).toBe("env");
});
test("resolveAuth: env API key is used when there is no subscription profile", () => {
  const c = TaichoConfig.parse({});
  expect(resolveAuth({ env: { ANTHROPIC_API_KEY: "k" }, config: c, loadProfile: () => null }).kind).toBe("env");
});
test("resolveAuth: no env key + profile + flag on -> oauth", () => {
  expect(resolveAuth({ env: {}, config: TaichoConfig.parse({}), loadProfile: () => prof }).kind).toBe("oauth-openai-codex");
});
test("resolveAuth: chatgpt_signin:false ignores the profile", () => {
  expect(resolveAuth({ env: {}, config: TaichoConfig.parse({ auth: { chatgpt_signin: false } }), loadProfile: () => prof }).kind).toBe("none");
});
test("resolveAuth: TAICHO_PROVIDER=openai-codex forces oauth even with an anthropic key", () => {
  expect(resolveAuth({ env: { TAICHO_PROVIDER: "openai-codex", ANTHROPIC_API_KEY: "k" }, config: TaichoConfig.parse({}), loadProfile: () => prof }).kind).toBe("oauth-openai-codex");
});
test("resolveAuth: nothing -> none", () => {
  expect(resolveAuth({ env: {}, config: TaichoConfig.parse({}), loadProfile: () => null }).kind).toBe("none");
});
