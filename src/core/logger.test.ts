import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, redact, configureLogger, log } from "./logger";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "taicho-log-")), "taicho.log");
}

test("captures messages to the file with an ISO timestamp + level tag", () => {
  const file = tmpFile();
  const logger = createLogger({ file, level: "debug" });
  logger.info("hello world");
  const contents = readFileSync(file, "utf8");
  expect(contents).toContain("INFO");
  expect(contents).toContain("hello world");
  expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp prefix
});

test("level threshold suppresses lower-severity lines", () => {
  const lines: string[] = [];
  const logger = createLogger({ level: "warn", sink: (l) => lines.push(l) });
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  const joined = lines.join("");
  expect(joined).not.toContain(" d");
  expect(joined).not.toContain(" i");
  expect(joined).toContain("w");
  expect(joined).toContain("e");
});

test("debug level lets everything through", () => {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => lines.push(l) });
  logger.debug("d1");
  logger.error("e1");
  expect(lines.length).toBe(2);
});

test("silent level suppresses everything", () => {
  const lines: string[] = [];
  const logger = createLogger({ level: "silent", sink: (l) => lines.push(l) });
  logger.error("nope");
  expect(lines.length).toBe(0);
});

test("redacts bearer tokens", () => {
  expect(redact("Authorization: Bearer abc123.def-456")).toBe("Authorization: Bearer ***");
});

test("redacts sk- API keys", () => {
  expect(redact("key=sk-ant-api03-abcdef123456")).toBe("key=sk-***");
  expect(redact("OPENAI sk-proj-ZZZZZZZZ9999")).toBe("OPENAI sk-***");
});

test("redacts token fields in serialized JSON", () => {
  const out = redact('{"access_token":"secret-value","account_id":"acc_1"}');
  expect(out).toContain('"access_token":"***"');
  expect(out).toContain("acc_1"); // non-secret fields survive
});

test("redacts GitHub tokens (classic prefixes + fine-grained PAT)", () => {
  const classic = redact("gh push token=ghp_0123456789ABCDEFabcdef0123456789ABCD done");
  expect(classic).toContain("ghp_***");
  expect(classic).not.toContain("0123456789ABCDEF");
  expect(redact("oauth gho_ABCdef0123456789ABCdef0123456789ABCD")).toContain("gho_***");
  const pat = "github_pat_11ABCDEFG0abcdefghij_KLMNOPqrstuvwxyz0123456789ABCDEFGHIJ";
  const patOut = redact(`GITHUB_TOKEN=${pat}`);
  expect(patOut).toBe("GITHUB_TOKEN=github_pat_***");
});

test("redacts a bare JWT (header.payload.signature)", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  expect(redact(`session=${jwt}`)).toBe("session=eyJ***");
});

test("redacts Slack tokens (xox* prefixes)", () => {
  // Built at runtime so no scannable Slack-token literal sits in source (GitHub push protection).
  const body = "EXAMPLE00example00";
  const out = redact(`slack xoxb-${body}`);
  expect(out).toContain("xoxb-***");
  expect(out).not.toContain(body);
});

test("redacts secrets embedded in a URL query string (value under an innocuous key)", () => {
  // The value here is NOT sk-/gh/JWT shaped, so ONLY the URL-param rule can catch it.
  const out = redact("GET https://api.example.com/x?api_key=deadbeefcafef00d1234&page=2");
  expect(out).not.toContain("deadbeefcafef00d1234");
  expect(out).toContain("api_key=***");
  expect(out).toContain("page=2"); // non-secret query survives
  expect(redact("open https://h/cb?token=OPAQUErandomVALUE987#frag")).toContain("token=***");
});

test("redact leaves ordinary prose untouched (no over-redaction)", () => {
  const s = "The gh command staged 20 files; check the api overview in README before you push skills.";
  expect(redact(s)).toBe(s);
});

test("never writes an auth token to the log file even when handed one as data", () => {
  const file = tmpFile();
  const logger = createLogger({ file, level: "debug" });
  logger.error("codex 401", { authorization: "Bearer super-secret-token-value" });
  const contents = readFileSync(file, "utf8");
  expect(contents).not.toContain("super-secret-token-value");
  expect(contents).toContain("***");
});

test("serializes an Error payload as name: message", () => {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => lines.push(l) });
  logger.error("run failed", new Error("boom"));
  expect(lines[0]).toContain("run failed :: Error: boom");
});

test("configureLogger re-points the default logger at a workspace file and raises the level", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-log-ws-"));
  configureLogger({ ws, level: "debug" });
  log.debug("configured-line");
  const file = join(ws, "taicho.log");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toContain("configured-line");
  // restore a quiet default so later tests in this process aren't affected
  configureLogger({ level: "info", sink: () => {} });
});

test("Plan 17: log lines carry the active OTel trace_id/span_id (execution-log correlation)", async () => {
  const { InMemorySpanExporter } = await import("@opentelemetry/sdk-trace-node");
  const { InMemoryMetricExporter, AggregationTemporality, PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
  const { trace, context } = await import("@opentelemetry/api");
  const { initTelemetry } = await import("./otel");
  const telemetry = initTelemetry({
    spanExporter: new InMemorySpanExporter(),
    metricReader: new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 60_000 }),
  })!;
  const lines: string[] = [];
  const logger = createLogger({ level: "info", sink: (l) => lines.push(l) });

  const span = telemetry.tracerFor("someagent").startSpan("op");
  context.with(trace.setSpan(context.active(), span), () => logger.info("inside a span"));
  span.end();
  logger.info("outside any span");

  // Inside an active span → the line is stamped with the span's ids (correlates with the trace).
  expect(lines[0]).toMatch(/trace_id=[a-f0-9]{32} span_id=[a-f0-9]{16}/);
  // Outside a span → no correlation appended (a plain app-log line).
  expect(lines[1]).not.toContain("trace_id");
  await telemetry.shutdown();
});
