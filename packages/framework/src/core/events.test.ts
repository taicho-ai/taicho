import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunTranscript } from "../store/run-transcript";
import { paths } from "../store/files";
import { readTranscript, listRunIds, latestRunId, formatEvent, tailRun } from "./events";

/** Write a minimal run record (trace json + a transcript with the given events). */
function writeRun(ws: string, runId: string, events: { ts: string; kind: string; iteration?: number; data?: unknown }[]) {
  const [agent, record] = runId.split("/");
  mkdirSync(join(ws, "runs", agent), { recursive: true });
  writeFileSync(join(ws, "runs", agent, `${record}.json`), JSON.stringify({ id: runId }));
  for (const e of events) appendRunTranscript(ws, runId, e);
}

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), "taicho-events-"));
}

test("readTranscript parses the appended JSONL events", () => {
  const ws = tmpWs();
  writeRun(ws, "root/2026-07-04-run1", [
    { ts: "2026-07-04T00:00:00.000Z", kind: "model_request", iteration: 1, data: { messageCount: 2 } },
    { ts: "2026-07-04T00:00:01.000Z", kind: "model_response", iteration: 1, data: { text: "hi", toolCalls: [] } },
  ]);
  const events = readTranscript(ws, "root/2026-07-04-run1");
  expect(events.length).toBe(2);
  expect(events[0].kind).toBe("model_request");
});

test("listRunIds and latestRunId discover runs by trace file", () => {
  const ws = tmpWs();
  writeRun(ws, "root/2026-07-04-run1", [{ ts: "t", kind: "model_request" }]);
  // ensure a strictly later mtime on the second trace
  const [agent, record] = ["root", "2026-07-04-run2"];
  mkdirSync(join(ws, "runs", agent), { recursive: true });
  const later = join(ws, "runs", agent, `${record}.json`);
  writeFileSync(later, JSON.stringify({ id: "root/2026-07-04-run2" }));
  const now = Date.now() / 1000;
  // bump mtime forward so latest is deterministic regardless of write speed
  require("node:fs").utimesSync(later, now + 10, now + 10);
  appendRunTranscript(ws, "root/2026-07-04-run2", { ts: "t", kind: "model_request" });

  expect(listRunIds(ws).sort()).toEqual(["root/2026-07-04-run1", "root/2026-07-04-run2"]);
  expect(latestRunId(ws)).toBe("root/2026-07-04-run2");
});

test("latestRunId is undefined with no runs", () => {
  expect(latestRunId(tmpWs())).toBeUndefined();
});

test("formatEvent renders a one-line, truncated, redacted summary", () => {
  const line = formatEvent({ ts: "2026-07-04T00:00:00.000Z", kind: "model_response", iteration: 3, data: { text: "the answer is 42", toolCalls: [{}] } });
  expect(line).toContain("model_response");
  expect(line).toContain("iter 3");
  expect(line).toContain("the answer is 42");
  expect(line).toContain("1 tool call");
});

test("formatEvent redacts auth material that leaked into an event", () => {
  const line = formatEvent({ ts: "t", kind: "model_error", data: { error: "401 Authorization: Bearer sekret-token-1234567890" } });
  expect(line).not.toContain("sekret-token");
  expect(line).toContain("Bearer ***");
});

test("tailRun (non-follow) prints every event of the latest run", async () => {
  const ws = tmpWs();
  writeRun(ws, "root/2026-07-04-run1", [
    { ts: "t1", kind: "model_request", iteration: 1, data: { messageCount: 1 } },
    { ts: "t2", kind: "tool_call", iteration: 1, data: { toolName: "write_artifact", input: { topicSlug: "x" } } },
  ]);
  const out: string[] = [];
  await tailRun({ ws, out: (l) => out.push(l) });
  expect(out.length).toBe(2);
  expect(out[1]).toContain("write_artifact");
});
