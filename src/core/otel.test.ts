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
import { initTelemetry } from "./otel";

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
  await telemetry.shutdown();
});

test("prompt content is NOT exported unless OTEL_TAICHO_CAPTURE_CONTENT opts in", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const spans = new InMemorySpanExporter();
  const metricReader = new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 60_000 });
  // No OTEL_TAICHO_CAPTURE_CONTENT ⇒ captureContent is false ⇒ recordInputs/recordOutputs off.
  const telemetry = initTelemetry({ spanExporter: spans, metricReader, env: { OTEL_EXPORTER_OTLP_ENDPOINT: "x" } })!;
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

test("the run span carries input + output when content capture IS opted in", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const spans = new InMemorySpanExporter();
  const metricReader = new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 60_000 });
  const telemetry = initTelemetry({ spanExporter: spans, metricReader, env: { OTEL_EXPORTER_OTLP_ENDPOINT: "x", OTEL_TAICHO_CAPTURE_CONTENT: "1" } })!;
  expect(telemetry.captureContent).toBe(true);

  const model = new MockLanguageModelV3({ doGenerate: mockValues(text("here is the answer")) as any });
  const deps = makeDeps({ ws, db, model, telemetry });
  const writer = await loadAgent(ws, "writer");
  await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "MY_QUESTION_42" }], triggeredBy: "user" });

  const runSpan = spans.getFinishedSpans().find((s) => s.name === "writer · user turn")!;
  // The run node now shows WHAT it was asked and WHAT it produced — not "No inputs".
  expect(String(runSpan.attributes["gen_ai.prompt"])).toContain("MY_QUESTION_42");
  expect(String(runSpan.attributes["gen_ai.completion"])).toContain("here is the answer");
  await telemetry.shutdown();
});
