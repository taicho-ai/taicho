import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, mockValues, simulateReadableStream } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { ensureWorkspace, paths } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, loadIndex, loadAgent, createAgent, serializeAgent } from "../store/roster";
import { AgentDef } from "../schemas/agent";
import { makeDeps, executeRun } from "./run";
import { readTrace } from "../store/trace";
import { writePolicy } from "../store/policy";
import { PolicyNote } from "../schemas/policy";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;
const text = (t: string) =>
  ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
const call = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;
// doStream variant for the subscription (Codex) path, which streams instead of doGenerate.
const textStream = (t: string) => (async () => ({
  stream: simulateReadableStream({
    initialDelayInMs: 0, chunkDelayInMs: 0,
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: t },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ],
  }),
})) as any;

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
  expect((model as any).doGenerateCalls.length).toBe(1); // token cap stopped it after 1 call, not the 30-iteration cap
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
  expect(res.trace.delegatedOut.length).toBe(1); // only the first (allowed) delegation spawned a child
});

test("a delegating run's aggregate includes child spend", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "writer", goal: "write hello" }), // root
    call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), // child
    text("child done"), // child
    text("root done"),  // root
  ) as any });
  const deps = makeDeps({ ws, db, model, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make a hello doc" }], triggeredBy: "user" });
  const childId = res.trace.delegatedOut[0];
  const child = readTrace(ws, childId);
  expect(res.trace.aggregate).toBeTruthy();
  expect(res.trace.aggregate!.tokens).toBe(res.trace.tokens + child.tokens); // exact: locks out double-counting
});

test("delegation is refused once the per-request run ceiling is hit", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "a", role: "a", identity: "x", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "b", role: "b", identity: "leaf", tools: [], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  // a tries to delegate to b, but the run counter is already at the 50 ceiling
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("delegate_task", { to: "b", goal: "x" }), text("ok")) as any });
  const deps = makeDeps({ ws, db, model, runCounter: { n: 50 } });
  const a = await loadAgent(ws, "a");
  const res = await executeRun(deps, { agent: a, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut.length).toBe(0);
  expect(res.trace.notes.some((n) => /max runs per request/i.test(n))).toBe(true);
});

test("aborting cancels an in-flight child run too (cascade), both interrupted", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "p", role: "parent", identity: "delegate", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "c", role: "child", identity: "work", tools: ["write_artifact"], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const controller = new AbortController();
  let n = 0;
  const model = new MockLanguageModelV3({ doGenerate: (async () => {
    n++;
    if (n === 1) return call("delegate_task", { to: "c", goal: "x" }); // parent delegates
    if (n === 2) { controller.abort(); return call("write_artifact", { topicSlug: "x", markdown: "y" }); } // child's 1st call; abort now
    return text("unreached");
  }) as any });
  const deps = makeDeps({ ws, db, model, signal: controller.signal });
  const p = await loadAgent(ws, "p");
  const res = await executeRun(deps, { agent: p, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("interrupted");          // parent interrupted
  expect(res.trace.delegatedOut.length).toBe(1);
  const child = readTrace(ws, res.trace.delegatedOut[0]);
  expect(child.outcome).toBe("interrupted");              // child interrupted via the shared signal
});

test("aggregate sums the whole run-tree exactly (root + mid + leaf)", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "r2", role: "root2", identity: "delegate", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "mid", role: "mid", identity: "delegate", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "leaf", role: "leaf", identity: "work", tools: ["write_artifact"], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "mid", goal: "x" }),  // r2 step1
    call("delegate_task", { to: "leaf", goal: "y" }), // mid step1
    call("write_artifact", { topicSlug: "z", markdown: "w" }), // leaf step1
    text("leaf done"),  // leaf step2
    text("mid done"),   // mid step2
    text("root done"),  // r2 step2
  ) as any });
  const deps = makeDeps({ ws, db, model, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  const r2 = await loadAgent(ws, "r2");
  const res = await executeRun(deps, { agent: r2, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  const midId = res.trace.delegatedOut[0];
  const mid = readTrace(ws, midId);
  const leafId = mid.delegatedOut[0];
  const leaf = readTrace(ws, leafId);
  expect(res.trace.aggregate!.tokens).toBe(res.trace.tokens + mid.tokens + leaf.tokens); // exact tree sum, no double-count
});

test("a per-agent resolveModel makes an agent run its own model", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const writerModel = new MockLanguageModelV3({ doGenerate: (async () => text("writer ran")) as any });
  const otherModel = new MockLanguageModelV3({ doGenerate: (async () => text("other ran")) as any });
  const deps = makeDeps({ ws, db, model: otherModel,
    resolveModel: (id: string) => id === "writer" ? { model: writerModel, modelId: "writer-model" } : { model: otherModel, modelId: "other-model" },
  });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.text).toBe("writer ran");
  expect((writerModel as any).doGenerateCalls.length).toBe(1);
  expect((otherModel as any).doGenerateCalls.length).toBe(0);
});

test("per-agent pricer reflects each agent's resolved model price", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "cheap", role: "x", identity: "x" }, "root");
  await createAgent(ws, db, { id: "pricey", role: "x", identity: "x" }, "root");
  const mk = () => new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const resolveModel = (id: string) => id === "pricey"
    ? { model: mk(), modelId: "claude-opus-4-8" }
    : { model: mk(), modelId: "claude-sonnet-4-6" };
  const cheap = await loadAgent(ws, "cheap");
  const pricey = await loadAgent(ws, "pricey");
  const cheapRes = await executeRun(makeDeps({ ws, db, model: mk(), resolveModel }), { agent: cheap, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  const priceyRes = await executeRun(makeDeps({ ws, db, model: mk(), resolveModel }), { agent: pricey, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(cheapRes.trace.costUsd).toBeGreaterThan(0);
  expect(priceyRes.trace.costUsd!).toBeGreaterThan(cheapRes.trace.costUsd!); // opus prices higher than sonnet for identical usage
});

test("a subscription-backed run records costUsd null + costNote, tokens still counted", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "sub", role: "x", identity: "x" }, "root");
  // subscription:true ⇒ Codex backend ⇒ streaming path, so the mock must serve doStream.
  const model = new MockLanguageModelV3({ doStream: textStream("done") });
  const deps = makeDeps({ ws, db, model, resolveModel: () => ({ model, modelId: "gpt-5.5", subscription: true }) });
  const sub = await loadAgent(ws, "sub");
  const res = await executeRun(deps, { agent: sub, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.costUsd).toBeNull();
  expect(res.trace.costNote).toBe("subscription");
  expect(res.trace.tokens).toBeGreaterThan(0);
});

test("create_agent applies an edited draft when approval returns edit", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("create_agent", { id: "newbie", role: "orig role", identity: "orig" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "edit", draft: { role: "edited role" } }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  const created = await loadAgent(ws, "newbie");
  expect(created.role).toBe("edited role");
});

test("a worker's later run sees a recent-runs digest of its earlier runs", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const writer = await loadAgent(ws, "writer");
  const m1 = new MockLanguageModelV3({ doGenerate: mockValues(call("write_artifact", { topicSlug: "rep", markdown: "# r" }), text("done1")) as any });
  await executeRun(makeDeps({ ws, db, model: m1 }), { agent: writer, messages: [{ role: "user", content: "do x" }], triggeredBy: "user" });
  const m2 = new MockLanguageModelV3({ doGenerate: (async () => text("done2")) as any });
  await executeRun(makeDeps({ ws, db, model: m2 }), { agent: writer, messages: [{ role: "user", content: "do y" }], triggeredBy: "user" });
  expect(JSON.stringify((m2 as { doGenerateCalls: unknown[] }).doGenerateCalls[0])).toContain("Your recent runs");
});

const policy = (over: Record<string, unknown>) => PolicyNote.parse({ id: "pol_x", agent: "writer", when: "always", do: "cite your sources", scope: "agent", status: "approved", taughtBy: "user", created: "2026-06-11T00:00:00.000Z", ...over });

test("approved policies are injected into the run prompt and recorded in the ledger", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  writePolicy(ws, policy({ id: "pol_a", do: "cite your sources" }));
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(JSON.stringify((model as { doGenerateCalls: unknown[] }).doGenerateCalls[0])).toContain("cite your sources");
  expect(res.trace.ledger.applied).toContain("pol_a");
});

test("proposed (non-approved) notes are NOT injected", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  writePolicy(ws, policy({ id: "pol_p", do: "DRAFT NOT APPROVED", status: "proposed" }));
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(JSON.stringify((model as { doGenerateCalls: unknown[] }).doGenerateCalls[0])).not.toContain("DRAFT NOT APPROVED");
  expect(res.trace.ledger.applied).not.toContain("pol_p");
});

test("a global-scope note authored on one agent reaches another agent's run", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "a", role: "x", identity: "x" }, "root");
  await createAgent(ws, db, { id: "b", role: "y", identity: "y" }, "root");
  writePolicy(ws, policy({ id: "pol_g", agent: "a", do: "be concise globally", scope: "global" }));
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const b = await loadAgent(ws, "b");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: b, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(JSON.stringify((model as { doGenerateCalls: unknown[] }).doGenerateCalls[0])).toContain("be concise globally");
  expect(res.trace.ledger.applied).toContain("pol_g");
});

test("create_agent honors an edited identity, not just role", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("create_agent", { id: "newbie", role: "r", identity: "original soul" }), text("done")) as any });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "edit", draft: { identity: "EDITED SOUL" } }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect((await loadAgent(ws, "newbie")).identity).toBe("EDITED SOUL");
});
