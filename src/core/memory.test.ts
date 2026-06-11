import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTrace } from "../store/trace";
import { recentRunsDigest } from "./memory";
import { RunTrace } from "../schemas/trace";

function tr(id: string, task: string, started: string, artifacts: string[] = []): RunTrace {
  return RunTrace.parse({
    id, agent: "w", task, triggeredBy: "user", ledger: { retrieved: [], applied: [], skipped: [] },
    toolCalls: [], artifacts, delegatedOut: [], outcome: "completed", tokens: 1, costUsd: 0, notes: [],
    durationMs: 1, started,
  });
}

test("digest is undefined with no runs", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-mem-"));
  expect(recentRunsDigest(ws, "w")).toBeUndefined();
});

test("digest lists recent runs newest-first with artifacts", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-mem-"));
  writeTrace(ws, tr("w/2026-06-11-run1", "first task", "2026-06-11T00:00:01.000Z", ["a.md"]));
  writeTrace(ws, tr("w/2026-06-11-run2", "second task", "2026-06-11T00:00:02.000Z"));
  const d = recentRunsDigest(ws, "w")!;
  expect(d).toContain("Your recent runs");
  expect(d).toContain("first task");
  expect(d).toContain("second task");
  expect(d).toContain("a.md");
  expect(d.indexOf("second task")).toBeLessThan(d.indexOf("first task")); // newest first
});
