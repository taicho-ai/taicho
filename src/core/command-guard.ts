/** The command guard: decide whether a shell command is safe to auto-run (allow) or needs the
 *  captain's approval (block), by delegating to the external `dcg` binary. Fail SAFE — if dcg is
 *  absent or errors, we block (→ ask the human). runShell executes an approved/allowed command with
 *  output caps + a timeout; runSandboxed executes it CONFINED (Plan 08 sandbox-then-escalate). */
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";

export interface Verdict { decision: "allow" | "block"; reason?: string }

/** Default runner: spawn `dcg --robot test <command>`. Throws if dcg isn't installed (caught below). */
function dcgTest(command: string): { code: number; stdout: string } {
  const p = Bun.spawnSync({ cmd: ["dcg", "--robot", "test", command] });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
}

export function classifyCommand(
  command: string,
  run: (command: string) => { code: number; stdout: string } = dcgTest,
): Verdict {
  try {
    const { code, stdout } = run(command);
    if (code === 0) return { decision: "allow" };
    let reason: string | undefined;
    try { reason = (JSON.parse(stdout) as { reason?: string }).reason; } catch { /* not JSON */ }
    return { decision: "block", reason: reason ?? "flagged by the command guard" };
  } catch {
    return { decision: "block", reason: "command guard (dcg) unavailable — approve manually" };
  }
}

const CAP = 10_000;
const cap = (b: { toString(): string }): string => { const s = b.toString(); return s.length > CAP ? s.slice(0, CAP) + "\n…(truncated)" : s; };

export function runShell(command: string, cwd: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const p = Bun.spawnSync({ cmd: ["bash", "-lc", command], cwd, timeout: 60_000 });
    return { exitCode: p.exitCode ?? -1, stdout: cap(p.stdout), stderr: cap(p.stderr) };
  } catch (e) {
    return { exitCode: -1, stdout: "", stderr: `failed to run: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Result of a sandbox attempt. `enforced` is the honesty flag: TRUE means the command actually ran
 *  inside an OS-level sandbox (confined); FALSE means no sandbox mechanism was available on this host
 *  and the command was NOT run (we never silently drop confinement — the caller must escalate to an
 *  approved unsandboxed run). */
export interface SandboxResult { exitCode: number; stdout: string; stderr: string; enforced: boolean }

const realish = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
const esc = (p: string): string => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** A Seatbelt (macOS `sandbox-exec`) profile: deny-by-default, allow reads + process spawn, allow
 *  writes ONLY under the given paths (workspace + temp), and — by deny-default — deny all network. */
function seatbeltProfile(writable: string[]): string {
  const writes = writable.map((p) => `(allow file-write* (subpath "${esc(p)}"))`).join("");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)(allow process-exec)",
    "(allow file-read*)",
    "(allow sysctl-read)",
    '(allow file-write-data (path "/dev/null") (path "/dev/stdout") (path "/dev/stderr") (path "/dev/tty"))',
    writes,
  ].join("");
}

/** Run a command CONFINED (Plan 08 sandbox-then-escalate).
 *
 *  ENFORCED on macOS via Seatbelt (`sandbox-exec`): no outbound network, filesystem writes confined
 *  to the workspace + temp dirs, reads allowed. Returns `enforced: true` with the real captured
 *  output.
 *
 *  On any OTHER platform (or if `sandbox-exec` is missing/errors), there is NO enforced sandbox here:
 *  we return `enforced: false` and do NOT run the command — the caller escalates to a human-approved
 *  unsandboxed run. This keeps the enforcement claim HONEST (we never fake confinement). */
export function runSandboxed(command: string, cwd: string): SandboxResult {
  if (process.platform !== "darwin")
    return { exitCode: -1, stdout: "", stderr: `no OS sandbox on this host (${process.platform}) — sandbox enforced on macOS only`, enforced: false };
  try {
    const writable = [...new Set([realish(cwd), realish(tmpdir()), "/tmp", "/private/tmp"])];
    const profile = seatbeltProfile(writable);
    const p = Bun.spawnSync({ cmd: ["sandbox-exec", "-p", profile, "bash", "-lc", command], cwd, timeout: 60_000 });
    // Strip Seatbelt's own deprecation notice so it doesn't masquerade as command output.
    const stderr = cap(p.stderr).replace(/^.*sandbox-exec.*deprecated.*$\n?/im, "");
    return { exitCode: p.exitCode ?? -1, stdout: cap(p.stdout), stderr, enforced: true };
  } catch (e) {
    // sandbox-exec not found / spawn failure → NOT enforced; command NOT run (no fake confinement).
    return { exitCode: -1, stdout: "", stderr: `sandbox unavailable: ${e instanceof Error ? e.message : String(e)}`, enforced: false };
  }
}
