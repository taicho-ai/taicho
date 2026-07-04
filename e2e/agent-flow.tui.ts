/** Real-binary e2e for the minimum useful taicho workflow:
 *  prompt root -> create an agent -> prompt root again -> root uses that created agent. */
import { test, expect } from "@microsoft/tui-test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const bin = join(repo, "dist", "taicho");
const ws = mkdtempSync(join(tmpdir(), "taicho-real-cli-agent-flow-"));
writeFileSync(join(ws, "taicho.yaml"), "mcp:\n  enabled: false\nauth:\n  chatgpt_signin: false\n");
writeFileSync(join(repo, "artifacts", "taicho-real-cli-agent-flow-workspace.txt"), ws + "\n");

const shellCommand = [
  `cd ${JSON.stringify(ws)}`,
  "export TAICHO_E2E_MODEL=agent-flow",
  JSON.stringify(bin),
].join(" && ");

test.use({ program: { file: "/bin/bash", args: ["-lc", shellCommand] }, columns: 110, rows: 34 });

async function poll<T>(fn: () => T | null, timeout = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out after ${timeout}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function submitPrompt(terminal: { write: (data: string) => void; getByText: (text: string) => unknown }, text: string) {
  terminal.write(text);
  await expect(terminal.getByText(text)).toBeVisible({ timeout: 5000 });
  terminal.write("\r");
}

function runTrace(agent: string, name: string) {
  return JSON.parse(readFileSync(join(ws, "runs", agent, `${name}.json`), "utf8")) as {
    id: string;
    outcome: string;
    delegatedOut: string[];
  };
}

test("real CLI can create an agent and then use that agent", async ({ terminal }) => {
  await expect(terminal.getByText("taicho —")).toBeVisible();

  await submitPrompt(terminal, "create a proof worker agent");
  await expect(terminal.getByText("New agent")).toBeVisible({ timeout: 10000 });
  terminal.write("y");
  await expect(terminal.getByText("Created proof-agent.")).toBeVisible({ timeout: 10000 });

  await poll(() => existsSync(join(ws, "agents", "proof-agent", "agent.md")) ? true : null);

  await submitPrompt(terminal, "use the proof worker to prove delegation works");
  await expect(terminal.getByText("Root used proof-agent")).toBeVisible({ timeout: 10000 });

  await poll(() => {
    const rootDir = join(ws, "runs", "root");
    if (!existsSync(rootDir)) return null;
    return readdirSync(rootDir).filter((f) => f.endsWith(".json")).length >= 2 ? true : null;
  });

  const rootRun2 = runTrace("root", "2026-07-03-run2");
  expect(rootRun2.outcome).toBe("completed");
  expect(rootRun2.delegatedOut.some((id) => id.startsWith("proof-agent/"))).toBe(true);

  const childRunId = rootRun2.delegatedOut.find((id) => id.startsWith("proof-agent/"))!;
  const childName = childRunId.slice(childRunId.indexOf("/") + 1);
  const childTrace = runTrace("proof-agent", childName);
  expect(childTrace.outcome).toBe("completed");

  expect(readFileSync(join(ws, "agents", "proof-agent", "agent.md"), "utf8")).toContain("Proof worker");
  expect(readFileSync(join(ws, "conversations", "root", "ledger.jsonl"), "utf8")).toContain("use the proof worker");
  expect(readFileSync(join(ws, "runs", "root", "2026-07-03-run2", "child-runs.json"), "utf8")).toContain("proof-agent");
  expect(readFileSync(join(ws, "runs", "proof-agent", childName, "final.md"), "utf8")).toContain("proof-agent completed delegated work");
});
