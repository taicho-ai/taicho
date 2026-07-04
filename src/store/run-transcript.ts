/** Per-run evidence files. Trace JSON remains the summary; this directory keeps debuggable context. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { paths } from "./files";
import type { RunTrace } from "../schemas/trace";

export interface RunTranscriptEvent {
  ts: string;
  kind: string;
  iteration?: number;
  data?: unknown;
}

export function writeRunInput(ws: string, runId: string, input: {
  runId: string;
  triggeredBy: string;
  agent: string;
  task: string;
  messagesPassedToModel: ModelMessage[];
  parentRunId?: string;
}): void {
  const dir = paths.runRecordDir(ws, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "input.json"), JSON.stringify(input, null, 2));
}

export function appendRunTranscript(ws: string, runId: string, event: RunTranscriptEvent): void {
  const dir = paths.runRecordDir(ws, runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "transcript.jsonl"), JSON.stringify(event) + "\n");
}

/** Plan 04 Phase 5: overwrite the resume checkpoint each iteration with the loop's message array
 *  (its only real state) + the iteration index. A crashed run's last checkpoint is where a future
 *  resume would restart. Overwritten (not appended) — only the latest matters. */
export function writeRunCheckpoint(ws: string, runId: string, state: { iteration: number; messages: ModelMessage[] }): void {
  const dir = paths.runRecordDir(ws, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "checkpoint.json"), JSON.stringify({ runId, ...state, updated: new Date().toISOString() }, null, 2));
}

export function writeRunFinal(ws: string, runId: string, text: string): void {
  const dir = paths.runRecordDir(ws, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "final.md"), text);
}

export function writeRunFailure(ws: string, runId: string, trace: RunTrace, text: string): void {
  if (trace.outcome === "completed") return;
  const dir = paths.runRecordDir(ws, runId);
  mkdirSync(dir, { recursive: true });
  const childLines = trace.delegatedOut.length ? trace.delegatedOut.map((id) => `- ${id}`).join("\n") : "none";
  writeFileSync(join(dir, "failure.md"), [
    `# ${runId} failed evidence`,
    "",
    `outcome: ${trace.outcome}`,
    `agent: ${trace.agent}`,
    `task: ${trace.task}`,
    `triggeredBy: ${trace.triggeredBy}`,
    `tokens: ${trace.tokens}`,
    `durationMs: ${trace.durationMs}`,
    "",
    "## Final text",
    text || "(none)",
    "",
    "## Child runs",
    childLines,
    "",
    "## Notes",
    trace.notes.length ? trace.notes.map((n) => `- ${n}`).join("\n") : "none",
    "",
  ].join("\n"));
}

export function writeChildRuns(ws: string, runId: string, childRuns: RunTrace[]): void {
  const dir = paths.runRecordDir(ws, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "child-runs.json"), JSON.stringify(childRuns.map((t) => ({
    runId: t.id,
    agent: t.agent,
    task: t.task,
    outcome: t.outcome,
    usableOutput: t.outcome === "completed",
    tokens: t.tokens,
    aggregate: t.aggregate,
    artifacts: t.artifacts,
    delegatedOut: t.delegatedOut,
  })), null, 2));
}
