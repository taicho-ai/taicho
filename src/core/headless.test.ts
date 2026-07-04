import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, PassThrough } from "node:stream";
import { MockLanguageModelV3, mockValues } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { ensureWorkspace } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, loadIndex } from "../store/roster";
import { parseCli, makeApprovalChannel, runHeadless } from "./headless";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;
const text = (t: string) =>
  ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
const call = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-headless-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  return { ws, db };
}

// ── parseCli ──────────────────────────────────────────────────────────────

test("parseCli: no subcommand ⇒ interactive REPL", () => {
  expect(parseCli(["/bin/bun", "/x/index.tsx"]).command).toBeNull();
});

test("parseCli: run with a quoted goal", () => {
  const p = parseCli(["bun", "/$bunfs/root/taicho", "run", "prove it works"]);
  expect(p.command).toEqual({ kind: "run", goal: "prove it works", agent: "root", approve: "reject" });
});

test("parseCli: --agent, --approve, and -v flags", () => {
  const p = parseCli(["bun", "taicho", "run", "--agent", "writer", "--approve", "auto", "-v", "do", "the", "thing"]);
  expect(p.verbose).toBe(true);
  expect(p.command).toEqual({ kind: "run", goal: "do the thing", agent: "writer", approve: "approve" });
});

test("parseCli: --yes is approve; --approve=prompt parses", () => {
  expect(parseCli(["b", "t", "run", "--yes", "go"]).command).toMatchObject({ approve: "approve" });
  expect(parseCli(["b", "t", "run", "--approve=prompt", "go"]).command).toMatchObject({ approve: "prompt" });
});

test("parseCli: tail with runId and --follow", () => {
  expect(parseCli(["b", "t", "tail", "--follow", "root/2026-run1"]).command).toEqual({ kind: "tail", runId: "root/2026-run1", follow: true });
  expect(parseCli(["b", "t", "tail"]).command).toEqual({ kind: "tail", runId: undefined, follow: false });
});

// ── approval channel ──────────────────────────────────────────────────────

test("makeApprovalChannel reject always rejects", async () => {
  const ch = makeApprovalChannel("reject");
  expect(await ch({ kind: "run_command", command: "rm -rf /" })).toEqual({ type: "reject" });
});

test("makeApprovalChannel approve approves, and answers ask_human with the first option", async () => {
  const ch = makeApprovalChannel("approve");
  expect(await ch({ kind: "run_command", command: "ls" })).toEqual({ type: "approve" });
  expect(await ch({ kind: "ask_human", question: "pick", options: ["a", "b"] })).toEqual({ type: "answered", answer: "a" });
});

test("makeApprovalChannel prompt degrades to reject on EOF — BOTH first and second requests, no throw", async () => {
  // Regression: `rl` is created once and reused; after stdin EOF the first request rejected fine but the
  // second called `rl.question` on a closed interface and threw ("readline was closed"). Drive with an
  // immediately-ending stream so the very first request already sees EOF.
  const ch = makeApprovalChannel("prompt", { input: Readable.from([]), out: () => {} });
  const first = await ch({ kind: "run_command", command: "ls" });
  const second = await ch({ kind: "run_command", command: "whoami" });
  expect(first).toEqual({ type: "reject" });
  expect(second).toEqual({ type: "reject" });
});

test("makeApprovalChannel prompt reads a 'y' line, then degrades to reject once stdin EOFs", async () => {
  // Proves the fix doesn't break the normal interactive path: a 'y' still approves, and a later request
  // after EOF degrades to reject instead of throwing.
  const input = new PassThrough();
  const ch = makeApprovalChannel("prompt", { input, out: () => {} });
  const p1 = ch({ kind: "run_command", command: "ls" });
  input.write("y\n"); // answers the first request
  expect(await p1).toEqual({ type: "approve" });
  input.end(); // EOF
  await new Promise((r) => setImmediate(r)); // let readline emit 'close'
  expect(await ch({ kind: "run_command", command: "whoami" })).toEqual({ type: "reject" });
});

// ── runHeadless drives executeRun without Ink ─────────────────────────────

test("runHeadless drives a run to a completed trace and returns the final text — no Ink", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("all done")) as any });
  const out: string[] = [];
  const res = await runHeadless({ ws, db, model }, { goal: "say hi", out: (l) => out.push(l) });

  expect(res.ok).toBe(true);
  expect(res.outcome).toBe("completed");
  expect(res.text).toBe("all done");
  expect(res.runId).toBeString();
  // a real trace file was written by executeRun
  const [, record] = res.runId!.split("/");
  expect(existsSync(join(ws, "runs", "root", `${record}.json`))).toBe(true);
  // the final text + a status summary reached stdout
  expect(out.join("\n")).toContain("all done");
  expect(out.join("\n")).toContain("completed");
});

test("runHeadless auto-rejects privileged actions (unattended-safe default)", async () => {
  const { ws, db } = await boot();
  // model tries to create an agent, then finishes
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("create_agent", { id: "ghost", role: "x", identity: "y" }),
      text("could not create it"),
    ) as any,
  });
  const res = await runHeadless({ ws, db, model }, { goal: "spawn a ghost", approve: "reject", out: () => {} });
  expect(res.outcome).toBe("completed");
  // the create_agent approval was rejected ⇒ no new agent exists
  expect(loadIndex(db).some((r) => r.id === "ghost")).toBe(false);
});

test("runHeadless refuses without a model", async () => {
  const { ws, db } = await boot();
  const out: string[] = [];
  const res = await runHeadless({ ws, db, model: null }, { goal: "hi", out: (l) => out.push(l) });
  expect(res.ok).toBe(false);
  expect(out.join("\n")).toContain("no credentials");
});

test("runHeadless refuses an unknown agent and an empty goal", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("x")) as any });
  expect((await runHeadless({ ws, db, model }, { goal: "hi", agent: "nobody", out: () => {} })).ok).toBe(false);
  expect((await runHeadless({ ws, db, model }, { goal: "   ", out: () => {} })).ok).toBe(false);
});
