# Observability — bring your own OpenTelemetry backend

taicho emits **standard OpenTelemetry over OTLP/HTTP**. It ships **no bundled observability UI** — you
point it at whatever backend you already use by setting the standard `OTEL_*` environment variables.
Nothing in taicho's code knows or cares which backend it's talking to, so switching between LangSmith,
Langfuse, Jaeger, Grafana Tempo, Honeycomb, Datadog, or any OTLP collector is a config change, never a
code change.

**Off by default.** With no `OTEL_EXPORTER_OTLP_ENDPOINT` set, telemetry is a complete no-op — no
provider, no network, zero overhead. Setting the endpoint is the on-switch.

---

## What taicho exports

- **Traces.** One OTel **service per agent** (`service.name=<agent>`, namespaced under `service.namespace=taicho`),
  so a service-aware backend groups and colors by agent and can draw the delegation graph. Span shapes:
  - `run` — `"<agent> · user turn"` / `"<agent> · delegated"`
  - `llm` — `"chat <model> · iter N"`, with GenAI semantic-convention attributes (`gen_ai.system`,
    `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.response.finish_reasons`)
  - `tool` — `"<tool> · <args-preview>"` (built-in **and** MCP tools) — a delegated child run nests under
    the `delegate_task` tool span
  - `verify` — `"checker · criteria pass/fail"`
  - Chat spans carry the prompt/completion as a proper GenAI **message list** (`gen_ai.prompt.<i>.role/content`),
    which backends render as System / User / AI messages.
- **Metrics.** `gen_ai.client.token.usage` (histogram), `gen_ai.client.operation.duration` (histogram),
  `taicho.cost.usd` (counter), `taicho.run.active` (up-down gauge), `taicho.run.duration` (histogram).
  A **traces-only** backend (e.g. Jaeger) ignores these; a full-signal backend surfaces them as dashboards.
- **Execution-log correlation.** Each line in `taicho.log` is stamped with the active `trace_id`/`span_id`,
  so a log line lines up with the exact span in your backend.

---

## The knobs (standard OTel env vars)

| Variable | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | **The on-switch.** Your collector/backend base URL (e.g. `http://localhost:4318`). |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth + routing headers, `k=v,k=v` (e.g. an API key). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) or `http/json`. |
| `OTEL_SERVICE_NAME` | The base/namespace service name. Defaults to `taicho`. |
| `OTEL_TAICHO_CAPTURE_CONTENT` | Opt in to shipping **prompt/completion + tool args/results** onto spans. **Off by default** (see Privacy). |

> **Secrets stay in the environment**, never in `taicho.yaml`. Put API keys in your shell env, a `.env`
> file, or your secret manager — the same rule taicho uses for model credentials.

---

## Drop-in configs

### LangSmith  *(validated with taicho)*

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.smith.langchain.com/otel"
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=${LANGSMITH_API_KEY},Langsmith-Project=taicho"
export OTEL_SERVICE_NAME="taicho"
```

LangSmith auto-creates the project on first ingest and renders the run→llm→tool→delegation waterfall with
per-message System/User/AI I/O and token/cost roll-ups. (EU data region: use
`https://eu.api.smith.langchain.com/otel`.)

### Langfuse

Langfuse ingests OTLP with **HTTP Basic auth** built from your public + secret keys.

```bash
# Build the Basic auth header from your Langfuse keys:
export LANGFUSE_AUTH="$(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64)"

export OTEL_EXPORTER_OTLP_ENDPOINT="https://cloud.langfuse.com/api/public/otel"   # US: https://us.cloud.langfuse.com/... ; self-host: https://<your-host>/api/public/otel
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic ${LANGFUSE_AUTH}"
export OTEL_SERVICE_NAME="taicho"
```

Langfuse reads the GenAI conventions, so the chat spans show as message threads with model/token/cost.

### Jaeger (local, traces-only, zero infra)

```bash
docker run -d --name jaeger -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:1.60
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_SERVICE_NAME="taicho"
# UI at http://localhost:16686  (traces only — metrics are dropped)
```

### Grafana Tempo / Grafana Cloud

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp-gateway-<region>.grafana.net/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64(instanceID:apiToken)>"
```

### Honeycomb

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.honeycomb.io"
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=${HONEYCOMB_API_KEY}"
```

### Datadog

Datadog ingests OTLP via the Datadog Agent (run the agent with an OTLP receiver on `:4318`), then:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
```

### Any OTLP collector (self-hosted, e.g. OpenTelemetry Collector / OpenObserve / Uptrace / SigNoz)

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://<collector-host>:4318"
# add OTEL_EXPORTER_OTLP_HEADERS if your collector requires auth
```

Route from the collector to as many backends as you like — that's the collector's job, not taicho's.

---

## Privacy — content capture

By default taicho exports span **structure** (names, timings, token/cost, model, finish reason) but **not**
the prompt/completion text or tool arguments/results. To include that content — e.g. to see the actual
messages in LangSmith/Langfuse — opt in:

```bash
export OTEL_TAICHO_CAPTURE_CONTENT=1
```

Only enable this when you're comfortable with your prompts and tool I/O leaving the process for your
backend. It's all-or-nothing across llm/tool/run spans, and gated behind this single flag.

---

## Verifying it works

Run anything with the endpoint set and check your backend:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318" OTEL_SERVICE_NAME="taicho" \
  taicho run "Say hello in one sentence." --approve reject
```

A trace named `<agent> · user turn` should appear within a few seconds, with the `chat <model>` span
nested under it. Turn on `OTEL_TAICHO_CAPTURE_CONTENT=1` to see the messages. No trace showing up? Confirm
the endpoint is reachable and any required auth header is set — export failures are swallowed (they never
crash a run), so a wrong endpoint fails silently.
