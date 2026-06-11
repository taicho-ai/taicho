import { test, expect } from "bun:test";
import { formatAuthStatus, noCredentialLines, authExpiredMessage } from "./status";

test("formatAuthStatus renders each source kind", () => {
  expect(formatAuthStatus({ kind: "env", provider: "anthropic", model: "claude-sonnet-4-6" })).toContain("env:anthropic");
  expect(formatAuthStatus({ kind: "oauth-openai-codex", accountId: "a", expiresAt: 0 })).toContain("oauth:openai-codex");
  expect(formatAuthStatus({ kind: "none" })).toContain("none");
});
test("noCredentialLines offers both an API key and /login openai", () => {
  const t = noCredentialLines().join("\n");
  expect(t).toMatch(/API_KEY/);
  expect(t).toContain("/login openai");
});
test("authExpiredMessage points at /login openai", () => {
  expect(authExpiredMessage()).toContain("/login openai");
});
