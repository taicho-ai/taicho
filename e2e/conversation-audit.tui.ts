/** Real-binary regression for conversation evidence persistence.
 *  This runs the compiled dist/taicho in a real PTY, submits an actual chat turn, cancels it,
 *  then inspects the workspace files written by the CLI process. No Ink harness, no unit mock. */
import { test, expect } from "@microsoft/tui-test";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const bin = join(repo, "dist", "taicho");
const ws = mkdtempSync(join(tmpdir(), "taicho-real-cli-audit-"));
writeFileSync(join(ws, "taicho.yaml"), "mcp:\n  enabled: false\nauth:\n  chatgpt_signin: false\n");
writeFileSync(join(repo, "artifacts", "taicho-real-cli-audit-workspace.txt"), ws + "\n");

const shellCommand = [
  `cd ${JSON.stringify(ws)}`,
  "export TAICHO_PROVIDER=openai",
  "export OPENAI_API_KEY=bogus",
  "export TAICHO_MODEL=gpt-5.5",
  JSON.stringify(bin),
].join(" && ");

test.use({ program: { file: "/bin/bash", args: ["-lc", shellCommand] }, columns: 100, rows: 30 });

async function poll<T>(fn: () => T | null, timeout = 15000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out after ${timeout}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function latestRootRunFile(): string | null {
  const dir = join(ws, "runs", "root");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.length ? join(dir, files.at(-1)!) : null;
}

test("real CLI preserves an interrupted chat turn as audit evidence", async ({ terminal }) => {
  await expect(terminal.getByText("taicho —")).toBeVisible();
  terminal.write("please start a real cli run, then I will cancel it");
  terminal.write("\r");

  const inputFile = await poll(() => {
    const f = latestRootRunFile();
    if (!f) return null;
    const runName = f.slice(f.lastIndexOf("/") + 1, -".json".length);
    const input = join(ws, "runs", "root", runName, "input.json");
    return existsSync(input) ? input : null;
  });

  terminal.write("\x1b");

  const traceFile = await poll(() => {
    const f = latestRootRunFile();
    if (!f) return null;
    const trace = JSON.parse(readFileSync(f, "utf8")) as { task: string; durationMs: number; outcome: string };
    return trace.task !== "(running)" && trace.durationMs > 0 ? f : null;
  }, 20000);

  const trace = JSON.parse(readFileSync(traceFile, "utf8")) as { id: string; outcome: string };
  const runName = traceFile.slice(traceFile.lastIndexOf("/") + 1, -".json".length);
  const runDir = join(ws, "runs", "root", runName);

  expect(trace.outcome).toBe("interrupted");
  expect(readFileSync(inputFile, "utf8")).toContain("please start a real cli run");
  expect(readFileSync(join(ws, "conversations", "root", "ledger.jsonl"), "utf8")).toContain("please start a real cli run");
  expect(readFileSync(join(ws, "conversations", "root", "context.json"), "utf8")).toContain("interrupted_run_not_safe_as_context");
  expect(existsSync(join(runDir, "transcript.jsonl"))).toBe(true);
  expect(existsSync(join(runDir, "failure.md"))).toBe(true);
  expect(readdirSync(join(ws, "tasks")).some((f) => f.includes(runName))).toBe(true);
});
