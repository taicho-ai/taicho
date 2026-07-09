/** Plan 16: OpenTelemetry instrumentation. The engine already produces rich internal evidence
 *  (transcript.jsonl, RunTrace, the /trace waterfall) — but it is taicho-only. This module exports the
 *  SAME model/tool/delegation activity as STANDARD OpenTelemetry: `gen_ai.*` semantic-convention spans
 *  (via the AI SDK's experimental_telemetry) nested under a taicho run span, plus a small metrics
 *  pipeline. Everything ships over OTLP to any collector (Jaeger, Grafana Tempo, Honeycomb, LangSmith…).
 *
 *  OFF BY DEFAULT: with no OTLP endpoint configured, initTelemetry returns undefined and the engine
 *  does zero extra work — no provider, no spans, no network. Turning it on is one env var
 *  (OTEL_EXPORTER_OTLP_ENDPOINT), read by the standard OTel SDK exactly as every other OTel app reads it.
 *
 *  This is Plan 16 Phase 1 ("emit alongside"): OTel spans are produced in addition to today's transcript
 *  evidence, so /trace is unchanged and the export is purely additive. Phases 2/3 (repointing /trace at
 *  the span store, retiring the transcript-derived path) are follow-ups. */
import { metrics, type Tracer, type Histogram, type Counter, type UpDownCounter } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { log } from "./logger";

/** One model call's telemetry, recorded as metrics (the span attributes come from the AI SDK). */
export interface ModelCallMetric {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null; // null on a subscription/unpriced run — never a fabricated 0
  durationMs: number;
}

/** The live telemetry handle threaded through RunDeps (like the deck ledger). Undefined ⇒ disabled. */
export interface Telemetry {
  /** The tracer handed to the AI SDK's experimental_telemetry so its gen_ai spans export through us. */
  tracer: Tracer;
  /** Whether prompt/completion text may leave the process (OTEL_TAICHO_CAPTURE_CONTENT). Off by default. */
  captureContent: boolean;
  /** Per model call → gen_ai token-usage + operation-duration histograms + the taicho cost counter. */
  recordModelCall(m: ModelCallMetric): void;
  /** A run began → active-runs gauge +1. */
  runStarted(agent: string): void;
  /** A run finished (any outcome) → active-runs gauge −1 + the run-duration histogram. */
  runFinished(a: { agent: string; outcome: string; durationMs: number }): void;
  /** Flush + close exporters. MUST be awaited before process exit or buffered spans are lost. */
  shutdown(): Promise<void>;
}

export interface InitTelemetryOpts {
  serviceName?: string;
  serviceVersion?: string;
  /** Test seam: export spans here instead of OTLP (an InMemorySpanExporter in unit tests). When set,
   *  telemetry is forced ON regardless of env, and a SimpleSpanProcessor is used (synchronous flush). */
  spanExporter?: SpanExporter;
  /** Test seam: use this metric reader instead of the OTLP periodic reader. */
  metricReader?: MetricReader;
  env?: Record<string, string | undefined>;
}

const truthy = (v: string | undefined): boolean => v === "1" || v === "true" || v === "yes";

/** Build the telemetry pipeline, or return undefined when disabled.
 *
 *  Enabled when EITHER an OTLP endpoint is configured (OTEL_EXPORTER_OTLP_ENDPOINT /
 *  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) OR a test spanExporter is injected. The OTLP exporters read
 *  their endpoint/headers/protocol from the standard OTEL_* env vars themselves — nothing bespoke. */
export function initTelemetry(opts: InitTelemetryOpts = {}): Telemetry | undefined {
  const env = opts.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const testMode = opts.spanExporter != null || opts.metricReader != null;
  if (!endpoint && !testMode) return undefined; // the on-switch is the endpoint; absent it, a no-op

  const serviceName = opts.serviceName ?? env.OTEL_SERVICE_NAME ?? "taicho";
  const resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.version": opts.serviceVersion ?? "0.0.1",
  });

  let tracerProvider: NodeTracerProvider;
  let meterProvider: MeterProvider | undefined;
  try {
    const spanProcessor = opts.spanExporter
      ? new SimpleSpanProcessor(opts.spanExporter)
      : new BatchSpanProcessor(new OTLPTraceExporter());
    tracerProvider = new NodeTracerProvider({ resource, spanProcessors: [spanProcessor] });
    // AsyncLocalStorage context propagation — how a delegated child run's spans nest under their
    // parent across await boundaries. Bun implements AsyncLocalStorage, so this works on Bun.
    tracerProvider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });

    const reader = opts.metricReader
      ?? new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 });
    meterProvider = new MeterProvider({ resource, readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
  } catch (e) {
    // Never let a telemetry misconfiguration take down the app — log and run without it.
    log.warn("opentelemetry init failed — continuing without telemetry", e);
    return undefined;
  }

  const tracer = tracerProvider.getTracer("taicho", opts.serviceVersion ?? "0.0.1");
  const meter = (meterProvider ?? metrics.getMeterProvider()).getMeter("taicho");

  // GenAI semantic-convention instruments (portable names every backend understands) + a taicho cost
  // counter and active-run gauge for the things the spec doesn't cover.
  const tokenUsage: Histogram = meter.createHistogram("gen_ai.client.token.usage", { unit: "{token}", description: "Tokens used per model call" });
  const opDuration: Histogram = meter.createHistogram("gen_ai.client.operation.duration", { unit: "s", description: "Model call latency" });
  const costCounter: Counter = meter.createCounter("taicho.cost.usd", { unit: "USD", description: "Advisory model spend" });
  const activeRuns: UpDownCounter = meter.createUpDownCounter("taicho.run.active", { description: "Runs currently in flight" });
  const runDuration: Histogram = meter.createHistogram("taicho.run.duration", { unit: "s", description: "Agent run wall-clock" });

  const captureContent = truthy(env.OTEL_TAICHO_CAPTURE_CONTENT);
  log.info("opentelemetry enabled", { serviceName, endpoint: endpoint ?? "(test exporter)", captureContent });

  return {
    tracer,
    captureContent,
    recordModelCall(m) {
      const attrs = { "gen_ai.system": m.provider, "gen_ai.request.model": m.model };
      tokenUsage.record(m.inputTokens, { ...attrs, "gen_ai.token.type": "input" });
      tokenUsage.record(m.outputTokens, { ...attrs, "gen_ai.token.type": "output" });
      opDuration.record(m.durationMs / 1000, attrs);
      if (m.costUsd != null && m.costUsd > 0) costCounter.add(m.costUsd, { "gen_ai.request.model": m.model });
    },
    runStarted(agent) {
      activeRuns.add(1, { "taicho.agent": agent });
    },
    runFinished(a) {
      activeRuns.add(-1, { "taicho.agent": a.agent });
      runDuration.record(a.durationMs / 1000, { "taicho.agent": a.agent, "taicho.run.outcome": a.outcome });
    },
    async shutdown() {
      // shutdown() force-flushes then closes. Swallow errors: an unreachable collector on exit must
      // never crash the process or block the REPL quit path.
      try { await tracerProvider.shutdown(); } catch (e) { log.warn("otel tracer shutdown failed", e); }
      try { await meterProvider?.shutdown(); } catch (e) { log.warn("otel meter shutdown failed", e); }
    },
  };
}

/** Span input/output attributes, in the keys trace backends actually read. Without these, a viewer
 *  shows "No inputs" — the AI SDK writes prompt/response under its own `ai.*` keys, which the generic
 *  OTLP path does NOT map. We set the widely-read ones: OpenInference (`input.value`/`output.value`),
 *  the generic GenAI (`gen_ai.prompt`/`gen_ai.completion`), and LangSmith's explicit reader
 *  (`langsmith.span.inputs`/`outputs`). Gated by content capture at every call site. Capped so a huge
 *  brief/answer can't bloat an attribute. */
export function ioAttrs(kind: "input" | "output", text: string): Record<string, string> {
  const v = text.length > 12_000 ? text.slice(0, 12_000) + "…[truncated]" : text;
  return kind === "input"
    ? { "input.value": v, "gen_ai.prompt": v, "langsmith.span.inputs": JSON.stringify({ input: v }) }
    : { "output.value": v, "gen_ai.completion": v, "langsmith.span.outputs": JSON.stringify({ output: v }) };
}

/** Flatten an AI SDK message's content (string | parts[]) to a readable line, so a chat message shows
 *  as text — not a nested JSON blob. Tool calls/results render compactly (`→ tool(args)` / `← tool: …`). */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text ?? "";
        if (p?.type === "reasoning") return p.text ?? "";
        if (p?.type === "tool-call") return `→ ${p.toolName}(${JSON.stringify(p.input ?? p.args ?? {})})`;
        if (p?.type === "tool-result") {
          const r = p.output ?? p.result;
          return `← ${p.toolName}: ${typeof r === "string" ? r : JSON.stringify(r ?? {})}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

/** GenAI-convention chat-message attributes (the indexed OpenLLMetry form: `<prefix>.<i>.role` /
 *  `<prefix>.<i>.content`) that LangSmith and other backends render as a MESSAGE LIST instead of a raw
 *  JSON dump. `prefix` is "gen_ai.prompt" (input) or "gen_ai.completion" (output). Each message's
 *  content is flattened to readable text and capped. This is the proper OpenTelemetry way to carry a
 *  conversation on a span — used for the `chat` (LLM) spans; single-string I/O uses ioAttrs instead. */
export function chatMessageAttrs(prefix: string, messages: { role: string; content: unknown }[]): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  for (const m of messages) {
    const text = contentToText(m.content);
    if (!text) continue;
    out[`${prefix}.${i}.role`] = m.role;
    out[`${prefix}.${i}.content`] = text.length > 8_000 ? text.slice(0, 8_000) + "…[truncated]" : text;
    i++;
  }
  return out;
}

/** Re-export the api surface run.ts/loop.ts/tools.ts need to open + nest spans, from one place. */
export { trace, context, SpanStatusCode, type Span } from "@opentelemetry/api";
