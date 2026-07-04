import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, runShell, runSandboxed, isInsideWorkspace } from "./command-guard";

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

test.if(onMac)("runSandboxed (macOS): enforced, allows reads + workspace writes, DENIES filesystem escape", () => {
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

test.if(onMac)("runSandboxed (macOS): the writable set is anchored to writableRoot (ctx.ws), NOT the cwd", () => {
  // Fix 1 (PR #13 review): a model-supplied cwd must NOT widen the confined write set. Run IN `other`
  // (a dir outside the workspace AND outside the temp scratch allowance) but anchor writes to `ws` — a
  // write into the cwd is DENIED, a write into ws is ALLOWED. Sandbox-level proof that a chosen cwd
  // can't self-authorize writes. (`other` lives under $HOME so it isn't covered by the /tmp allowance.)
  const ws = mkdtempSync(join(tmpdir(), "taicho-sb-ws-"));
  const other = mkdtempSync(join(process.env.HOME!, "taicho-sb-other-")); // the run cwd, OUTSIDE ws + temp
  try {
    const toCwd = runSandboxed(`printf x > "${other}/in-cwd.txt"`, other, ws);
    expect(toCwd.enforced).toBe(true);
    expect(toCwd.exitCode).not.toBe(0);
    expect(existsSync(join(other, "in-cwd.txt"))).toBe(false); // cwd is NOT writable — anchor is ws
    const toWs = runSandboxed(`printf y > "${ws}/in-ws.txt"`, other, ws);
    expect(toWs.enforced).toBe(true);
    expect(toWs.exitCode).toBe(0);
    expect(existsSync(join(ws, "in-ws.txt"))).toBe(true);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test.if(onMac)("runSandboxed (macOS): DENIES outbound network (control: the same request succeeds unsandboxed)", async () => {
  // Fix 3 (PR #13 review): the "no network" claim is now actually asserted. A loopback HTTP server runs
  // in a SEPARATE process (an in-process server can't respond — Bun.spawnSync blocks our event loop). It
  // is reachable WITHOUT the sandbox (control) but the identical curl inside runSandboxed is denied the
  // network, proving the deny-default profile blocks outbound connections, not just the filesystem.
  const ws = mkdtempSync(join(tmpdir(), "taicho-sb-net-"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const probe = (Bun as any).serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true); // free the port, then hand it to a separate-process server
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = (Bun as any).spawn(
    ["bun", "-e", `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("ok") }); await new Promise(() => {});`],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    const curl = `curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:${port}/`;
    // control: poll until the separate-process server is reachable WITHOUT the sandbox
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      const r = runShell(curl, ws);
      if (r.exitCode === 0 && r.stdout.includes("200")) up = true;
      else await new Promise((res) => setTimeout(res, 100));
    }
    expect(up).toBe(true);
    // enforced: the SAME request inside the sandbox is DENIED the network
    const denied = runSandboxed(curl, ws);
    expect(denied.enforced).toBe(true);
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stdout).not.toContain("200");
  } finally {
    server.kill();
  }
});

// ── isInsideWorkspace (Fix 1 containment gate) ──

test("isInsideWorkspace: equal path, subpaths, and non-existent leaves inside are contained", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-cw-"));
  mkdirSync(join(ws, "sub"));
  expect(isInsideWorkspace(ws, ws)).toBe(true);
  expect(isInsideWorkspace(ws, join(ws, "sub"))).toBe(true);
  expect(isInsideWorkspace(ws, join(ws, "not-yet", "deep"))).toBe(true); // nonexistent leaf, existing ancestor in ws
  expect(isInsideWorkspace(ws, "sub")).toBe(true);                       // relative → resolved against ws
});

test("isInsideWorkspace: outside paths and prefix-siblings are rejected", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-cw-"));
  expect(isInsideWorkspace(ws, "/etc")).toBe(false);
  expect(isInsideWorkspace(ws, tmpdir())).toBe(false);
  expect(isInsideWorkspace(ws, ws + "-evil")).toBe(false); // …/ws-evil must NOT count as inside …/ws
});

test("isInsideWorkspace: a symlink pointing OUTSIDE the workspace is rejected (the link is resolved)", () => {
  const root = mkdtempSync(join(tmpdir(), "taicho-cw-"));
  const ws = join(root, "ws"); mkdirSync(ws);
  const outside = join(root, "outside"); mkdirSync(outside);
  const escape = join(ws, "escape"); symlinkSync(outside, escape);   // ws/escape → ../outside
  expect(isInsideWorkspace(ws, escape)).toBe(false);                 // follows the link out of ws
  const inner = join(ws, "inner"); symlinkSync(ws, inner);           // ws/inner → ws (stays inside)
  expect(isInsideWorkspace(ws, inner)).toBe(true);
});
