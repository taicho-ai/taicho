/** The command guard: decide whether a shell command is safe to auto-run (allow) or needs the
 *  captain's approval (block), by delegating to the external `dcg` binary. Fail SAFE — if dcg is
 *  absent or errors, we block (→ ask the human). runShell executes an approved/allowed command with
 *  output caps + a timeout. */
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
export function runShell(command: string, cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const cap = (b: { toString(): string }) => { const s = b.toString(); return s.length > CAP ? s.slice(0, CAP) + "\n…(truncated)" : s; };
  try {
    const p = Bun.spawnSync({ cmd: ["bash", "-lc", command], cwd, timeout: 60_000 });
    return { exitCode: p.exitCode ?? -1, stdout: cap(p.stdout), stderr: cap(p.stderr) };
  } catch (e) {
    return { exitCode: -1, stdout: "", stderr: `failed to run: ${e instanceof Error ? e.message : String(e)}` };
  }
}
