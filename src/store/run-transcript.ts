/** Per-run evidence files. Trace JSON remains the summary; this directory keeps debuggable context. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Read a run's transcript.jsonl back as parsed events (the waterfall reader; returns [] if absent).
 *  Unparseable lines are skipped so a truncated/in-progress file never throws. */
export function readRunTranscript(ws: string, runId: string): RunTranscriptEvent[] {
  const file = join(paths.runRecordDir(ws, runId), "transcript.jsonl");
  if (!existsSync(file)) return [];
  const out: RunTranscriptEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as RunTranscriptEvent); } catch { /* skip a partial line */ }
  }
  return out;
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
