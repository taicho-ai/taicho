import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRunId, writeTrace, listTraces, readTrace } from "./trace";
import { ensureWorkspace } from "./files";
import { RunTrace } from "../schemas/trace";

function trace(id: string, agent: string): RunTrace {
  return RunTrace.parse({
    id, agent, task: "do a thing", triggeredBy: "user",
    ledger: { retrieved: [], applied: [], skipped: [] },
    toolCalls: [{ tool: "write_artifact", count: 1 }],
    artifacts: ["artifacts/x.md"], delegatedOut: [], outcome: "completed",
    tokens: 42, durationMs: 5, started: "2026-06-11T00:00:00.000Z",
  });
}

test("nextRunId increments per agent per day", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-"));
  await ensureWorkspace(ws);
  const id1 = nextRunId(ws, "researcher");
  expect(id1).toMatch(/^researcher\/\d{4}-\d{2}-\d{2}-run1$/);
  writeTrace(ws, trace(id1, "researcher"));
  const id2 = nextRunId(ws, "researcher");
  expect(id2.endsWith("-run2")).toBe(true);
});

test("write -> read round-trips, list filters by agent", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-"));
  await ensureWorkspace(ws);
  writeTrace(ws, trace("researcher/2026-06-11-run1", "researcher"));
  writeTrace(ws, trace("writer/2026-06-11-run1", "writer"));
  expect(readTrace(ws, "researcher/2026-06-11-run1").tokens).toBe(42);
  expect(listTraces(ws, "researcher").length).toBe(1);
  expect(listTraces(ws).length).toBe(2);
});
