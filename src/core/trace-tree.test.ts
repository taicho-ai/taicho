/** deriveTrace is pure (files → Span[]). We generate the fixture traces + transcripts by running the
 *  real engine with a mocked model (which exercises the shared instrumentation seam that writes the
 *  tool/approval span events), then derive over the produced workspace and assert on the span tree. */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, mockValues } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { ensureWorkspace } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, loadAgent, createAgent } from "../store/roster";
import { makeDeps, executeRun } from "./run";
import { deriveTrace, traceSummary, type Span } from "./trace-tree";

const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } } as const;
const text = (t: string) =>
  ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
const call = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-derive-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  return { ws, db };
}

const byKind = (spans: Span[], kind: Span["kind"]) => spans.filter((s) => s.kind === kind);

test("derives a run span + llm spans + a tool span (with real start/end timing) for a simple run", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("write_artifact", { topicSlug: "hi", markdown: "# Hi" }), text("done")) as any });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: writer, messages: [{ role: "user", content: "write" }], triggeredBy: "user" });

  const spans = deriveTrace(ws, res.runId);
  const runs = byKind(spans, "run");
  expect(runs.length).toBe(1);
  expect(runs[0].id).toBe(res.runId);
  expect(runs[0].status).toBe("ok");

  // two iterations (tool call, then final) → two llm spans, each with start ≤ end
  const llm = byKind(spans, "llm");
  expect(llm.length).toBe(2);
  for (const s of llm) expect(s.endMs).toBeGreaterThanOrEqual(s.startMs);

  const tools = byKind(spans, "tool");
  expect(tools.length).toBe(1);
  expect(tools[0].name).toBe("write_artifact");
  expect(tools[0].parentId).toBe(res.runId);
  expect(tools[0].endMs).toBeGreaterThanOrEqual(tools[0].startMs);
  if (tools[0].detail.kind === "tool") expect(tools[0].detail.argsPreview).toBe("hi"); // save/write_artifact → title/topicSlug
});

test("delegation: the child run span nests UNDER the parent's delegate_task tool span", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "writer", goal: "write hello" }), // root
    call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), // child
    text("child done"), // child
    text("root done"),  // root
  ) as any });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: root, messages: [{ role: "user", content: "make hello" }], triggeredBy: "user" });

  const spans = deriveTrace(ws, res.runId);
  const runs = byKind(spans, "run");
  expect(runs.length).toBe(2); // root + child

  const childId = res.trace.delegatedOut[0];
  const childRun = runs.find((s) => s.id === childId)!;
  const delegSpan = byKind(spans, "tool").find((s) => s.name === "delegate_task")!;
  expect(delegSpan).toBeTruthy();
  expect(childRun.parentId).toBe(delegSpan.id); // linked child → delegate tool span (the plan's key edge)

  // the child's own tool span (write_artifact) is present, parented to the child run
  const childTool = byKind(spans, "tool").find((s) => s.name === "write_artifact")!;
  expect(childTool.parentId).toBe(childId);

  // rolled-up header: the root run span carries the subtree token total (aggregate), > its own
  const summary = traceSummary(spans)!;
  expect(summary.tokens).toBeGreaterThan(0);
  expect(summary.status).toBe("ok");
});

test("verification retry: BOTH the failed first attempt and the retry nest under the delegate_task span", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "worker", role: "works", identity: "You work." }, "root");
  // One delegate_task with criteria: worker fails the first check, retries once, passes. That is ONE
  // tool call but TWO child runs — the tool span only captures the retry's runId, so the first
  // attempt must be re-linked under the same span (not reparented to the root run as a stray sibling).
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" }), // root
    text("attempt one, no Y"),                          // worker (1st attempt)
    text('{"pass": false, "reasons": ["missing Y"]}'),  // checker (1st) — independent model call
    text("attempt two, mentions Y"),                    // worker (retry)
    text('{"pass": true, "reasons": []}'),              // checker (2nd)
    text("root done"),                                  // root final
  ) as any });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: root, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });

  expect(res.trace.delegatedOut.length).toBe(2);  // initial + one retry
  expect(res.trace.verification.length).toBe(2);

  const spans = deriveTrace(ws, res.runId);
  const delegSpan = byKind(spans, "tool").find((s) => s.name === "delegate_task")!;
  expect(delegSpan).toBeTruthy();

  const [firstId, retryId] = res.trace.delegatedOut; // [0]=failed first attempt, [1]=retry
  const runs = byKind(spans, "run");
  const firstRun = runs.find((s) => s.id === firstId)!;
  const retryRun = runs.find((s) => s.id === retryId)!;
  // BOTH children hang off the delegate_task tool span — the tree shows the retry as a sibling of the
  // first attempt under one delegation, not a stray top-level run.
  expect(retryRun.parentId).toBe(delegSpan.id);
  expect(firstRun.parentId).toBe(delegSpan.id);
  expect(firstRun.parentId).not.toBe(res.runId); // NOT reparented to the root run span
  // exactly the three run spans (root + two attempts), all accounted for
  expect(runs.length).toBe(3);
});

test("an approval wait becomes its own approval span", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("create_agent", { id: "scout", role: "scouts", identity: "A scout." }), text("created")) as any });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "approve" }) });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make a scout" }], triggeredBy: "user" });

  const spans = deriveTrace(ws, res.runId);
  const approvals = byKind(spans, "approval");
  expect(approvals.length).toBe(1);
  expect(approvals[0].parentId).toBe(res.runId);
  if (approvals[0].detail.kind === "approval") expect(approvals[0].detail.label).toContain("create_agent");
  // it sits inside the create_agent tool span's wall-clock (start ≥ the tool's start)
  const tool = byKind(spans, "tool").find((s) => s.name === "create_agent")!;
  expect(approvals[0].startMs).toBeGreaterThanOrEqual(tool.startMs);
});

test("a model error surfaces as an error-status llm span (and an error run span)", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({ doGenerate: (() => { throw new Error("boom-derive"); }) as any });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });

  const spans = deriveTrace(ws, res.runId);
  expect(byKind(spans, "run")[0].status).toBe("error");
  const llm = byKind(spans, "llm");
  expect(llm.length).toBe(1);
  expect(llm[0].status).toBe("error");
  expect(llm[0].error).toContain("boom-derive");
});

test("deriveTrace on a missing run id returns no spans (never throws)", async () => {
  const { ws } = await boot();
  expect(deriveTrace(ws, "ghost/2026-01-01-run1")).toEqual([]);
});
