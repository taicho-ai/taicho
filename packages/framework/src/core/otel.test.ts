import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, mockValues, simulateReadableStream } from "./mock-model";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { InMemoryMetricExporter, AggregationTemporality, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ensureWorkspace } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, loadAgent, createAgent } from "../store/roster";
import { makeDeps, executeRun } from "./run";
import { initTelemetry } from "@taicho-ai/telemetry";

const usage = { inputTokens: { total: 7 }, outputTokens: { total: 3 } } as const;
const text = (t: string) =>
  ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
const call = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-otel-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  return { ws, db };
}

/** A telemetry handle wired to in-memory exporters — no OTLP, no network. */
function testTelemetry() {
  const spans = new InMemorySpanExporter();
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 60_000, // long — we force-flush via shutdown instead
  });
  const telemetry = initTelemetry({ spanExporter: spans, metricReader })!;
  return { spans, telemetry };
}

test("disabled by default: no OTLP endpoint ⇒ initTelemetry returns undefined (zero overhead)", () => {
  expect(initTelemetry({ env: {} })).toBeUndefined();
  // ...and enabled the moment an endpoint is configured, reading the standard OTel env var.
  const t = initTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" } });
  expect(t).toBeDefined();
});

test("a run emits a taicho run span with the gen_ai model call nested under it", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const { spans, telemetry } = testTelemetry();

  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model, telemetry });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "write a hello doc" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("completed");

  // SimpleSpanProcessor exports each span synchronously on end, so read BEFORE shutdown (an
  // InMemorySpanExporter's shutdown() resets its buffer). Production uses BatchSpanProcessor whose
  // shutdown() flushes to OTLP — that path is exercised by index.tsx, not here.
  const finished = spans.getFinishedSpans();

  // The run span is named meaningfully ("<agent> · user turn") and carries identity + outcome.
  const runSpan = finished.find((s) => s.name === "writer · user turn");
  expect(runSpan).toBeDefined();
  expect(runSpan!.attributes["taicho.agent"]).toBe("writer");
  expect(runSpan!.attributes["taicho.run.id"]).toBe(res.runId);
  expect(runSpan!.attributes["taicho.run.outcome"]).toBe("completed");
  expect(runSpan!.attributes["taicho.tokens"]).toBeGreaterThan(0);

  // taicho emits its OWN model-call span named `chat <model> · iter N` (not the AI SDK's opaque
  // `ai.streamText.doStream`), nested under the run span, carrying gen_ai.* attributes.
  const chatSpans = finished.filter((s) => s.name.startsWith("chat "));
  expect(chatSpans.length).toBeGreaterThan(0);
  expect(chatSpans[0]!.attributes["gen_ai.request.model"]).toBeDefined();
  expect(chatSpans.every((s) => s.spanContext().traceId === runSpan!.spanContext().traceId)).toBe(true);
  expect(chatSpans.some((s) => s.parentSpanContext?.spanId === runSpan!.spanContext().spanId)).toBe(true);
  // No opaque AI SDK spans leak into the trace anymore.
  expect(finished.some((s) => s.name.startsWith("ai."))).toBe(false);
  // The tool call is its own named span ("write_artifact · …"), nested under the chat span.
  const toolSpan = finished.find((s) => s.name.startsWith("write_artifact"));
  expect(toolSpan).toBeDefined();
  expect(toolSpan!.attributes["taicho.tool"]).toBe("write_artifact");
  await telemetry.shutdown();
});

test("a delegated child run nests under its parent — one trace across the delegation", async () => {
  const { ws, db } = await boot();
  // root (seeded) can delegate; give it a "helper" worker to delegate to — mirrors run.test.ts.
  await createAgent(ws, db, { id: "helper", role: "helps", identity: "You help." }, "root");
  const { spans, telemetry } = testTelemetry();

  const rootModel = new MockLanguageModelV3({
    doGenerate: mockValues(call("delegate_task", { to: "helper", goal: "do the thing" }), text("delegated & done")) as any,
  });
  const helperModel = new MockLanguageModelV3({ doGenerate: mockValues(text("helper done")) as any });
  const deps = makeDeps({
    ws, db, model: rootModel, telemetry,
    resolveModel: (id) => ({ model: id === "helper" ? helperModel : rootModel, modelId: "mock-model" }),
  });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("completed");
  expect(res.trace.delegatedOut.length).toBe(1); // the delegation actually fired

  const finished = spans.getFinishedSpans(); // read before shutdown (see note above)
  const parent = finished.find((s) => s.name === "root · user turn");
  const child = finished.find((s) => s.name === "helper · delegated");
  const toolSpan = finished.find((s) => s.name.startsWith("delegate_task"));
  expect(parent).toBeDefined();
  expect(child).toBeDefined();
  expect(toolSpan).toBeDefined();
  // Same trace id ⇒ the delegation is ONE distributed trace, not two disconnected ones.
  expect(child!.spanContext().traceId).toBe(parent!.spanContext().traceId);
  expect(child!.attributes["taicho.triggered_by"]).toBe(res.runId);
  // The child run nests under the delegate_task TOOL span (the mockup's structure), not the run directly.
  expect(child!.parentSpanContext?.spanId).toBe(toolSpan!.spanContext().spanId);
  // Each agent is its OWN OTel service (service.name = agent), namespaced under the base — so a
  // backend colors/groups by agent and can draw the delegation graph. The tool span belongs to the
  // delegating agent (root), the child run to the delegate (helper).
  expect(parent!.resource.attributes["service.name"]).toBe("root");
  expect(child!.resource.attributes["service.name"]).toBe("helper");
  expect(toolSpan!.resource.attributes["service.name"]).toBe("root");
  expect(child!.resource.attributes["service.namespace"]).toBe("taicho");
  await telemetry.shutdown();
});

test("cost integrity: gen_ai.usage rides ONLY the real `chat` call spans — never run/delegation/tool CONTAINERS", async () => {
  // Regression guard for the LangSmith double-count bug. A gen_ai-convention backend prices ANY span
  // carrying gen_ai.usage.* as a model call. If a run/turn/delegation/tool CONTAINER also carries it, the
  // same tokens get priced on the container AND the real per-iteration `chat` spans nested inside it —
  // inflating reported cost 2x at the trace root, up to 6x once delegation roll-ups stack. So gen_ai.usage
  // must live ONLY on the leaf `chat` spans; run totals live under taicho.* (which the backend ignores).
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "helper", role: "helps", identity: "You help." }, "root");
  const { spans, telemetry } = testTelemetry();

  const rootModel = new MockLanguageModelV3({
    doGenerate: mockValues(call("delegate_task", { to: "helper", goal: "do the thing" }), text("done")) as any,
  });
  const helperModel = new MockLanguageModelV3({ doGenerate: mockValues(text("helper done")) as any });
  const deps = makeDeps({
    ws, db, model: rootModel, telemetry,
    resolveModel: (id) => ({ model: id === "helper" ? helperModel : rootModel, modelId: "mock-model" }),
  });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("completed");

  const finished = spans.getFinishedSpans();
  const chats = finished.filter((s) => s.name.startsWith("chat "));         // the real inference calls
  const containers = finished.filter((s) => !s.name.startsWith("chat "));   // runs, delegated child, tool, checker
  expect(chats.length).toBeGreaterThan(0);
  expect(containers.length).toBeGreaterThan(0);

  // Every real call span carries gen_ai usage — this is what a backend SHOULD price, exactly once.
  for (const s of chats) {
    expect(s.attributes["gen_ai.usage.input_tokens"]).toBeDefined();
    expect(s.attributes["gen_ai.usage.output_tokens"]).toBeDefined();
  }
  // NO container span may carry gen_ai.usage.* — that was the bug (root · user turn, helper · delegated,
  // delegate_task · …). If this ever fails, LangSmith cost is double-counting again.
  for (const s of containers) {
    expect(s.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(s.attributes["gen_ai.usage.output_tokens"]).toBeUndefined();
  }
  // The per-run token split is preserved — just moved to taicho.* so it's queryable without being priced.
  const runSpan = finished.find((s) => s.name === "root · user turn")!;
  expect(runSpan.attributes["taicho.tokens.input"]).toBeGreaterThan(0);
  expect(runSpan.attributes["taicho.tokens.output"]).toBeGreaterThan(0);
  await telemetry.shutdown();
});

test("content capture is OPT-OUT: an explicit 0/false/no/off strips prompts from the spans", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const spans = new InMemorySpanExporter();
  const metricReader = new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 60_000 });
  const telemetry = initTelemetry({ spanExporter: spans, metricReader, env: { OTEL_EXPORTER_OTLP_ENDPOINT: "x", OTEL_TAICHO_CAPTURE_CONTENT: "0" } })!;
  expect(telemetry.captureContent).toBe(false);

  const SECRET = "SECRET_MARKER_DO_NOT_EXPORT";
  const model = new MockLanguageModelV3({ doGenerate: mockValues(text("ok")) as any });
  const deps = makeDeps({ ws, db, model, telemetry });
  const writer = await loadAgent(ws, "writer");
  await executeRun(deps, { agent: writer, messages: [{ role: "user", content: SECRET }], triggeredBy: "user" });

  const dump = JSON.stringify(spans.getFinishedSpans().map((s) => s.attributes));
  expect(dump.includes(SECRET)).toBe(false);
  await telemetry.shutdown();
});

test("every documented falsey spelling turns content capture off; everything else leaves it ON", () => {
  const base = { OTEL_EXPORTER_OTLP_ENDPOINT: "x" };
  const cap = (v?: string) => initTelemetry({ spanExporter: new InMemorySpanExporter(), env: v === undefined ? base : { ...base, OTEL_TAICHO_CAPTURE_CONTENT: v } })!.captureContent;

  for (const off of ["0", "false", "no", "off"]) expect(cap(off)).toBe(false);
  // unset ⇒ ON. This is the flip: telemetry is already off unless you configured an endpoint, so by the
  // time this flag is read you deliberately pointed taicho at a backend. Skeletons help nobody.
  expect(cap(undefined)).toBe(true);
  for (const on of ["1", "true", "yes"]) expect(cap(on)).toBe(true);
  // An opt-out switch must FAIL TOWARD THE USEFUL BEHAVIOUR: a typo cannot silently gut observability.
  expect(cap("maybe")).toBe(true);
  expect(cap("")).toBe(true);
  expect(cap("FALSE")).toBe(true); // case-sensitive by design — only the documented spellings disable it
});

test("the run span carries input + output BY DEFAULT (no env flag needed)", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const spans = new InMemorySpanExporter();
  const metricReader = new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 60_000 });
  // NO OTEL_TAICHO_CAPTURE_CONTENT — the point is that you get the conversation without asking.
  const telemetry = initTelemetry({ spanExporter: spans, metricReader, env: { OTEL_EXPORTER_OTLP_ENDPOINT: "x" } })!;
  expect(telemetry.captureContent).toBe(true);

  const model = new MockLanguageModelV3({ doGenerate: mockValues(text("here is the answer")) as any });
  const deps = makeDeps({ ws, db, model, telemetry });
  const writer = await loadAgent(ws, "writer");
  await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "MY_QUESTION_42" }], triggeredBy: "user" });

  const finished = spans.getFinishedSpans();
  const runSpan = finished.find((s) => s.name === "writer · user turn")!;
  // The run node now shows WHAT it was asked and WHAT it produced — not "No inputs".
  expect(String(runSpan.attributes["gen_ai.prompt"])).toContain("MY_QUESTION_42");
  expect(String(runSpan.attributes["gen_ai.completion"])).toContain("here is the answer");

  // The chat span carries the prompt as a STRUCTURED message list (indexed gen_ai.* role/content) —
  // rendered as a conversation by backends, not a raw JSON dump. The user's question is a user message.
  const chat = finished.find((s) => s.name.startsWith("chat "))!;
  expect(chat.attributes["gen_ai.prompt.0.role"]).toBe("system");
  const roles = Object.keys(chat.attributes).filter((k) => /^gen_ai\.prompt\.\d+\.role$/.test(k));
  expect(roles.length).toBeGreaterThanOrEqual(2); // system + at least the user turn
  const userMsg = Object.entries(chat.attributes).find(([k, v]) => /gen_ai\.prompt\.\d+\.content/.test(k) && String(v).includes("MY_QUESTION_42"));
  expect(userMsg).toBeDefined();
  expect(String(chat.attributes["gen_ai.completion.0.role"])).toBe("assistant");
  expect(String(chat.attributes["gen_ai.completion.0.content"])).toContain("here is the answer");
  // ...and NOT a JSON blob under a single key.
  expect(chat.attributes["gen_ai.prompt"]).toBeUndefined();
  await telemetry.shutdown();
});

// --- Plan 18/19: the attributes that let an agent self-diagnose from a queryable backend -----------

test("a run span carries the plan attributes, so 'which items failed' is a backend query", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "worker", role: "does the thing", identity: "You work." }, "root");
  await reindex(ws, db);
  const { spans, telemetry } = testTelemetry();

  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("write_plan", { goal: "ship it", items: [{ id: "it_a", text: "mine" }, { id: "it_b", text: "theirs" }] }),
      call("update_plan_item", { itemId: "it_a", status: "done" }),
      call("delegate_task", { to: "worker", goal: "do it", criteria: "must mention Y", itemId: "it_b" }),
      text("worker output, no Y"),                            // worker
      text('{"pass": false, "reasons": ["missing Y"]}'),      // checker
      text("worker retry, still no Y"),                       // worker retry
      text('{"pass": false, "reasons": ["still missing Y"]}'),// checker 2
      text("done"),                                            // root final
    ) as any,
  });
  const res = await executeRun(makeDeps({ ws, db, model, telemetry }), {
    agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "go" }], triggeredBy: "user",
  });

  const runSpan = spans.getFinishedSpans().find((s) => s.name === "root · user turn")!;
  expect(runSpan).toBeDefined();
  expect(runSpan.attributes["taicho.plan.handle"]).toBe("p_ship-it@v1");
  expect(runSpan.attributes["taicho.plan.items.total"]).toBe(2);
  expect(runSpan.attributes["taicho.plan.items.done"]).toBe(1);   // the model's own item
  expect(runSpan.attributes["taicho.plan.items.failed"]).toBe(1); // the delegated one, failed by the checker
  expect(runSpan.attributes["taicho.plan.items.open"]).toBe(0);

  // and the same truth is on the trace, for /costs-style rollups and crash forensics
  expect(res.trace.plan).toBe("p_ship-it@v1");
  expect(res.trace.planEvents).toBeGreaterThan(0);
});

test("a run with no plan records no plan attributes at all (zero overhead)", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const { spans, telemetry } = testTelemetry();
  const model = new MockLanguageModelV3({ doGenerate: mockValues(text("done")) as any });
  const res = await executeRun(makeDeps({ ws, db, model, telemetry }), {
    agent: await loadAgent(ws, "writer"), messages: [{ role: "user", content: "go" }], triggeredBy: "user",
  });
  const runSpan = spans.getFinishedSpans().find((s) => s.name === "writer · user turn")!;
  expect(runSpan.attributes["taicho.plan.handle"]).toBeUndefined();
  expect(res.trace.plan).toBeUndefined();
  expect(res.trace.planEvents).toBeUndefined();
});
