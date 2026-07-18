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

// Regression: key-name redaction alone was NOT enough — a secret embedded in the VALUE of an
// ordinary key (read_url's url, run_command's command) leaked verbatim into the status bar,
// breadcrumb, inspector, and persisted transcript. Value-level scrubbing must catch it in BOTH the
// one-line preview AND the capped JSON.
test("argsPreview scrubs a secret embedded in a read_url URL query param (value, not key)", () => {
  const p = argsPreview("read_url", { url: "https://api.example.com/x?api_key=sk-live-ABCDEF1234567890&page=2" });
  expect(p).not.toContain("sk-live-ABCDEF1234567890");
  expect(p).toContain("***");
  expect(p).toContain("page=2"); // non-secret query survives
});

test("argsPreview scrubs a Bearer token embedded in a run_command command (value, not key)", () => {
  const p = argsPreview("run_command", { command: "curl -H 'Authorization: Bearer sk-ant-SUPERSECRETTOKEN' https://x" });
  expect(p).not.toContain("sk-ant-SUPERSECRETTOKEN");
  expect(p).not.toContain("Bearer sk-ant-SUPERSECRETTOKEN");
  expect(p).toContain("***");
});

test("argsPreview redacts BEFORE the length cap (no partial-secret leak on truncation)", () => {
  // Pad so the secret sits near the 80-char cap boundary; if we capped before redacting, a partial
  // token would survive. Assert no run of the secret leaks.
  const pad = "x".repeat(60);
  const p = argsPreview("read_url", { url: `https://h/${pad}?token=sk-live-LEAKME9999999999` });
  expect(p).not.toContain("sk-live-LEAKME");
  expect(p).not.toContain("LEAKME");
});

test("capJson scrubs value-embedded secrets (URL param + Bearer), not just secret keys", () => {
  const url = capJson({ url: "https://h/x?access_token=sk-live-XYZ1234567890AB" });
  expect(url).not.toContain("sk-live-XYZ1234567890AB");
  expect(url).toContain("***");

  const cmd = capJson({ command: "gh auth login --with-token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
  expect(cmd).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  expect(cmd).toContain("***");

  // `data` is NOT a secret key, so this only stays masked via value-level scrubbing (the JWT shape).
  const jwt = capJson({ data: "session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.sigpart" });
  expect(jwt).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
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
