import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, runShell, runSandboxed } from "./command-guard";

test("classifyCommand: dcg exit 0 → allow", () => {
  expect(classifyCommand("ls", () => ({ code: 0, stdout: "{}" }))).toEqual({ decision: "allow" });
});

test("classifyCommand: dcg exit 1 → block with the reason from JSON", () => {
  const v = classifyCommand("rm -rf /", () => ({ code: 1, stdout: JSON.stringify({ reason: "destructive rm" }) }));
  expect(v.decision).toBe("block");
  expect(v.reason).toBe("destructive rm");
});

test("classifyCommand: guard throwing (dcg absent) → block, unavailable", () => {
  const v = classifyCommand("ls", () => { throw new Error("ENOENT"); });
  expect(v.decision).toBe("block");
  expect(v.reason).toMatch(/unavailable/);
});

test("runShell runs a harmless command and captures stdout", () => {
  const r = runShell("echo taicho-guard-test", process.cwd());
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("taicho-guard-test");
});

// ── runSandboxed (Plan 08 sandbox-then-escalate) ──

const onMac = process.platform === "darwin";

test("runSandboxed: on a non-macOS host it is NOT enforced and does not run the command", () => {
  if (onMac) return; // enforced-path host; the honesty-stub is only reachable off macOS
  const r = runSandboxed("echo should-not-run", tmpdir());
  expect(r.enforced).toBe(false);
});

test.if(onMac)("runSandboxed (macOS): enforced, allows reads + workspace writes, DENIES escape + network", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-sb-"));

  // 1) benign command runs, confined
  const echo = runSandboxed("echo confined", ws);
  expect(echo.enforced).toBe(true);
  expect(echo.exitCode).toBe(0);
  expect(echo.stdout).toContain("confined");

  // 2) a write INSIDE the workspace is allowed
  const ok = runSandboxed("printf data > inside.txt && cat inside.txt", ws);
  expect(ok.enforced).toBe(true);
  expect(ok.exitCode).toBe(0);
  expect(existsSync(join(ws, "inside.txt"))).toBe(true);

  // 3) a write OUTSIDE the workspace (into $HOME) is DENIED by the sandbox
  const escape = runSandboxed(`printf x > "${process.env.HOME}/taicho-sb-should-not-exist.txt"`, ws);
  expect(escape.enforced).toBe(true);
  expect(escape.exitCode).not.toBe(0);
  expect(existsSync(`${process.env.HOME}/taicho-sb-should-not-exist.txt`)).toBe(false);
});
