import { test, expect } from "bun:test";
import { classifyCommand, runShell } from "./command-guard";

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
