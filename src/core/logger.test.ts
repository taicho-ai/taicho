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
