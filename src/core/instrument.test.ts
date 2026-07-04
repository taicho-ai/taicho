import { test, expect } from "bun:test";
import { argsPreview, capJson, redactValue, isSecretKey, oneLine } from "./instrument";

test("argsPreview picks the meaningful field per known tool", () => {
  expect(argsPreview("read_url", { url: "https://arxiv.org/abs/1234" })).toBe("https://arxiv.org/abs/1234");
  expect(argsPreview("run_command", { command: "bun test" })).toBe("bun test");
  expect(argsPreview("delegate_task", { to: "writer", goal: "write X" })).toBe("writer: write X");
  expect(argsPreview("save_artifact", { title: "Dossier", body: "…" })).toBe("Dossier");
  expect(argsPreview("use_skill", { name: "deploy-app" })).toBe("deploy-app");
});

test("argsPreview is length-capped to a one-liner", () => {
  const long = "x".repeat(500);
  const p = argsPreview("read_url", { url: long });
  expect(p.length).toBeLessThanOrEqual(80);
  expect(p.endsWith("…")).toBe(true);
});

test("argsPreview collapses whitespace/newlines", () => {
  expect(argsPreview("ask_human", { question: "line one\n  line two" })).toBe("line one line two");
});

test("argsPreview NEVER leaks auth material (redacted in the generic fallback)", () => {
  const p = argsPreview("some_mcp_tool", { apiKey: "sk-secret-123", authorization: "Bearer abc", visible: "ok" });
  expect(p).not.toContain("sk-secret-123");
  expect(p).not.toContain("Bearer abc");
  expect(p).toContain("visible=ok");
  expect(p).toContain("‹redacted›");
});

test("isSecretKey matches common auth key names", () => {
  for (const k of ["token", "api_key", "apiKey", "authorization", "password", "SESSION_COOKIE", "bearer"]) expect(isSecretKey(k)).toBe(true);
  for (const k of ["title", "url", "goal", "count"]) expect(isSecretKey(k)).toBe(false);
});

test("redactValue deep-redacts nested secrets, leaves the rest", () => {
  const out = redactValue({ headers: { Authorization: "Bearer x" }, list: [{ token: "t" }], keep: 1 }) as any;
  expect(out.headers.Authorization).toBe("‹redacted›");
  expect(out.list[0].token).toBe("‹redacted›");
  expect(out.keep).toBe(1);
});

test("capJson truncates with a marker and redacts", () => {
  const big = { body: "y".repeat(5000), secret: "nope" };
  const s = capJson(big, 100);
  expect(s.length).toBeLessThanOrEqual(120);
  expect(s).toContain("…[+");
  expect(capJson({ secret: "nope", ok: 1 })).toContain("‹redacted›");
});

test("oneLine caps and trims", () => {
  expect(oneLine("  a   b  ", 80)).toBe("a b");
  expect(oneLine("abcdef", 4)).toBe("abc…");
});
