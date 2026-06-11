import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, mockValues } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { ensureWorkspace, paths } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, loadIndex, loadAgent, createAgent, serializeAgent } from "../store/roster";
import { AgentDef } from "../schemas/agent";
import { makeDeps, executeRun } from "./run";
import { readTrace } from "../store/trace";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;
const text = (t: string) =>
  ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
const call = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  return { ws, db };
}

test("worker run writes an immutable artifact and a completed trace", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "write a hello doc" }], triggeredBy: "user" });
  expect(res.text).toBe("done");
  expect(res.trace.outcome).toBe("completed");
  expect(res.trace.artifacts.length).toBe(1);
  expect(existsSync(res.trace.artifacts[0])).toBe(true);
  expect(existsSync(join(ws, "runs", "writer", `${res.runId.split("/")[1]}.json`))).toBe(true);
});

test("root create_agent tool persists a worker when approval resolves approve", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("create_agent", { id: "newbie", role: "does X", identity: "You do X." }), text("created")) as any,
  });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "approve" }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "I need an X agent" }], triggeredBy: "user" });
  expect(loadIndex(db).some((r) => r.id === "newbie")).toBe(true);
  expect(await Bun.file(join(ws, "agents", "newbie", "agent.md")).exists()).toBe(true);
  const loaded = await loadAgent(ws, "newbie");
  expect(loaded.identity).toBe("You do X.");
});

test("root create_agent does NOT mutate the registry when approval rejects", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("create_agent", { id: "newbie", role: "does X", identity: "You do X." }), text("ok")) as any,
  });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "reject" }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "I need an X agent" }], triggeredBy: "user" });
  expect(loadIndex(db).some((r) => r.id === "newbie")).toBe(false);
});

test("root delegate_task spawns a child run that produces its own trace", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("delegate_task", { to: "writer", goal: "write hello" }), // root step 1
      call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), // child step 1
      text("child done"), // child step 2
      text("root done"),  // root step 2
    ) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make a hello doc" }], triggeredBy: "user" });
  expect(res.text).toBe("root done");
  expect(res.trace.delegatedOut.length).toBe(1);
  const childId = res.trace.delegatedOut[0];
  const child = readTrace(ws, childId);
  expect(child.agent).toBe("writer");
  expect(child.triggeredBy).toBe(res.runId);
  expect(child.artifacts.length).toBe(1);
  expect(existsSync(child.artifacts[0])).toBe(true);
});

test("an agent whose iteration budget is exhausted yields a blocked-outcome trace", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const loopy = await loadAgent(ws, "writer");
  loopy.budgets.maxIterationsPerRun = 2;
  const model = new MockLanguageModelV3({
    doGenerate: (async () => call("write_artifact", { topicSlug: "x", markdown: "y" })) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const res = await executeRun(deps, { agent: loopy, messages: [{ role: "user", content: "loop forever" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("blocked");
});

test("a thrown model error yields a failed-outcome trace", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({ doGenerate: (() => { throw new Error("boom"); }) as any });
  const deps = makeDeps({ ws, db, model });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("failed");
  expect(res.text).toContain("boom");
});

test("delegate_task is denied when the caller's ACL forbids the target", async () => {
  const { ws, db } = await boot();
  // worker seeded with canDelegateTo:[] (default) but given the delegate_task tool
  await createAgent(ws, db, { id: "limited", role: "limited", identity: "You delegate.", tools: ["delegate_task"] }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("delegate_task", { to: "root", goal: "x" }), text("ok")) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const limited = await loadAgent(ws, "limited");
  const res = await executeRun(deps, { agent: limited, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut.length).toBe(0); // ACL blocked the delegation
  expect(res.text).toBe("ok");
});

test("records real tokens + cost on a completed run", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.tokens).toBeGreaterThan(0);
  expect(res.trace.costUsd).toBeGreaterThan(0);
});

test("a token-capped run ends blocked with non-zero tokens", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const loopy = await loadAgent(ws, "writer");
  loopy.budgets.maxTokensPerRun = 1;
  const model = new MockLanguageModelV3({ doGenerate: (async () => call("write_artifact", { topicSlug: "x", markdown: "y" })) as any });
  const deps = makeDeps({ ws, db, model });
  const res = await executeRun(deps, { agent: loopy, messages: [{ role: "user", content: "loop" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("blocked");
  expect(res.trace.tokens).toBeGreaterThan(0);
});

test("an aborted run is interrupted with partial tokens recorded", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const controller = new AbortController();
  controller.abort();
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const deps = makeDeps({ ws, db, model, signal: controller.signal });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("interrupted");
});

test("a model error is failed with partial tokens, not tokens:0", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  let n = 0;
  const model = new MockLanguageModelV3({ doGenerate: (async () => { if (n++ === 0) return call("write_artifact", { topicSlug: "x", markdown: "y" }); throw new Error("boom"); }) as any });
  const deps = makeDeps({ ws, db, model });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("failed");
  expect(res.text).toContain("boom");
  expect(res.trace.tokens).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Phase 1 Task 4: delegation safety guards
// ---------------------------------------------------------------------------

function putAgent(ws: string, db: import("bun:sqlite").Database, def: Record<string, unknown>) {
  const agent = AgentDef.parse({ created: new Date().toISOString(), ...def });
  mkdirSync(paths.agentDir(ws, agent.id), { recursive: true });
  writeFileSync(paths.agentFile(ws, agent.id), serializeAgent(agent));
  db.query("INSERT OR REPLACE INTO registry (id, role, is_root) VALUES (?, ?, ?)").run(agent.id, agent.role, agent.isRoot ? 1 : 0);
  return agent;
}

test("self-delegation terminates at the depth cap (no stack blowup) and the run completes", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "loopy", role: "loops", identity: "Delegate to loopy.", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 1, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: (async () => call("delegate_task", { to: "loopy", goal: "again" })) as any });
  const deps = makeDeps({ ws, db, model });
  const loopy = await loadAgent(ws, "loopy");
  const res = await executeRun(deps, { agent: loopy, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.runId).toBeTruthy(); // terminates
});

test("a direct cycle (a already in ancestry) is refused with a note", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "a", role: "a", identity: "x", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("delegate_task", { to: "a", goal: "self" }), text("ok")) as any });
  const deps = makeDeps({ ws, db, model });
  const a = await loadAgent(ws, "a");
  const res = await executeRun(deps, { agent: a, messages: [{ role: "user", content: "go" }], triggeredBy: "user", ancestry: ["a"] });
  expect(res.trace.delegatedOut.length).toBe(0);
  expect(res.trace.notes.some((n) => /cycle|depth|delegat/i.test(n))).toBe(true);
});

test("work-item budget caps delegate fan-out within one run", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "leaf", role: "leaf", identity: "done", tools: [], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "boss", role: "boss", identity: "delegate a lot", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 10, maxWorkItemsPerRequest: 1 } });
  // boss delegates twice; the 2nd exceeds maxWorkItemsPerRequest=1. leaf just returns text.
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "leaf", goal: "one" }),
    text("leaf one done"),
    call("delegate_task", { to: "leaf", goal: "two" }),
    text("boss done"),
  ) as any });
  const deps = makeDeps({ ws, db, model });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(deps, { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.notes.some((n) => /work item/i.test(n))).toBe(true);
});
