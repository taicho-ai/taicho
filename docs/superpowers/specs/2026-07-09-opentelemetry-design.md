# Plan 16 — OpenTelemetry instrumentation

**Status:** Phase 1 shipped (2026-07-09). Phases 2–3 are follow-ups.
**Mockup:** the design was pitched as a visual mockup before implementation (live trace waterfall,
GenAI span-detail card, metrics, migration phases).

## Problem

taicho already produces rich per-run evidence — `transcript.jsonl`, `RunTrace`, the coaching ledger,
verification verdicts, the `/trace` waterfall. But it is **taicho-only**: there is no way to ship that
evidence to a standard observability backend, correlate it with the rest of a system, or alert on it.

## Goal

Export the SAME model/tool/delegation activity as **standard OpenTelemetry**: `gen_ai.*`
semantic-convention spans nested under a taicho run span, plus a small metrics pipeline, over OTLP to
any collector (Jaeger, Grafana Tempo, Honeycomb, Datadog, LangSmith…). "Everything about the model" —
provider, model id, tokens, finish reason, latency, cost — travels as portable OTel attributes.

## Decisions (locked with the user)

1. **Export target:** OTLP/HTTP, configurable. The standard `OTEL_EXPORTER_OTLP_ENDPOINT` is the
   on-switch; absent it, telemetry is a no-op (zero overhead, no network).
2. **Trace scope:** the full run→llm→tool→delegation tree.
3. **Metrics:** traces **and** metrics (GenAI token/duration histograms + a taicho cost counter and
   active-run gauge).
4. **Coexistence:** OTel becomes the new single source of truth — but reached in **phases** (see below),
   never a big-bang cutover. Phase 1 emits OTel *alongside* today's transcript evidence.

## Architecture (Phase 1 — shipped)

The instrumentation hangs off seams that already exist; nothing new is threaded through the app.

- **`src/core/otel.ts`** — `initTelemetry(opts)` builds a `NodeTracerProvider` +
  `AsyncLocalStorageContextManager` (context propagation across the delegation's await boundaries; Bun
  implements `AsyncLocalStorage`) and a `MeterProvider`, both exporting over OTLP. Returns a `Telemetry`
  handle, or **undefined** when no endpoint is configured. Test seam: an injected `spanExporter` /
  `metricReader` forces it on with in-memory exporters (no network).
- **`src/core/loop.ts`** — each `streamText` call gets `experimental_telemetry: { isEnabled: true,
  tracer, functionId, metadata, recordInputs, recordOutputs }`. The AI SDK emits the `gen_ai.*` spans
  (`ai.streamText` → `ai.streamText.doStream`). After each call, `onModelCall` feeds the metrics.
  `recordInputs/recordOutputs` are gated by `OTEL_TAICHO_CAPTURE_CONTENT` — **off by default**, so no
  prompt/completion text leaves the process unless opted in (privacy).
- **`src/core/run.ts`** — `executeRun` opens a `run <agent>` span BEFORE its try (so a pre-loop throw
  still closes it) and makes it **active** around `runLoop` via `context.with`. The AI SDK's gen_ai
  spans and any delegated child runs therefore nest under it — a delegation is ONE distributed trace.
  `finishRunSpan` is idempotent (normal finalize AND catch) and stamps tokens/cost/context/outcome.
  A `taicho.*` attribute namespace carries what the spec doesn't: agent, run id, triggered-by, depth,
  advisory USD, context tokens.
- **Boot (`index.tsx`)** — `initTelemetry()` once at boot; the handle is threaded through `RunDeps`
  (like the deck ledger) into headless, the REPL, and the schedule-fire path. Every exit path awaits
  `telemetry.shutdown()` so the `BatchSpanProcessor` flushes before the process dies.

### Metrics (GenAI semantic conventions + taicho)

- `gen_ai.client.token.usage` (histogram, by `gen_ai.token.type` input/output)
- `gen_ai.client.operation.duration` (histogram, seconds)
- `taicho.cost.usd` (counter; 0/absent for subscription runs — never a fabricated price)
- `taicho.run.active` (up-down gauge), `taicho.run.duration` (histogram)

## Validation

- **Unit** (`src/core/otel.test.ts`, in-memory exporter, no network): disabled-by-default; a run emits
  a `run <agent>` span with the gen_ai model call nested under it; a delegated child nests under its
  parent in the same trace; prompt content is NOT exported unless the capture flag opts in.
- **End-to-end** (real subscription model → OTLP → LangSmith, viewed in Chrome): the `run root` span
  landed with 8.2K tokens / $0.0416, nesting `ai.streamText` → `ai.streamText.doStream` (gpt-5.5),
  carrying `service.name=taicho`, `service.version=0.0.1`, model + provider, and real `OTEL_TRACE_ID`.
- `bun run typecheck`, full `bun test` (1131 pass), and `bun run build` all green.

## Config surface

```
OTEL_EXPORTER_OTLP_ENDPOINT   # the on-switch (standard OTel var; e.g. http://localhost:4318)
OTEL_EXPORTER_OTLP_HEADERS    # standard; e.g. x-api-key=…,Langsmith-Project=…
OTEL_SERVICE_NAME             # defaults to "taicho"
OTEL_TAICHO_CAPTURE_CONTENT   # opt in to shipping prompt/completion text (default: false)
```

## Follow-ups (Phases 2–3, not in this change)

- **Phase 2:** repoint `deriveTrace` / `/trace` at an in-process span collector so the terminal
  waterfall renders OTel spans; keep transcript as a fallback + diff oracle.
- **Phase 3:** retire the transcript-derived span path; `spans.jsonl` (OTLP-file exporter) becomes the
  on-disk record, `RunTrace` stays for `/costs` + coaching.
- **Gap:** the coaching distiller (`draftPolicy`) makes a model call outside `executeRun` and is not yet
  spanned — matches its exclusion from `/costs`. Instrument when convenient.
