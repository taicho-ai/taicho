/** Plan 02 — the waterfall reader. Pure derivation (files in → Span[] out; no Ink) so it is
 *  unit-testable over fixture traces + transcripts. A "trace" = one root run plus its delegation
 *  subtree (exactly like a LangSmith trace = one top-level invocation). Every row the inspector
 *  draws — run / llm / tool / approval — is one Span on a shared absolute-time axis. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../store/files";
import { readTrace } from "../store/trace";
import { readRunTranscript, type RunTranscriptEvent } from "../store/run-transcript";
import type { RunTrace } from "../schemas/trace";

export type SpanKind = "run" | "llm" | "tool" | "approval";
export type SpanStatus = "ok" | "error" | "running" | "blocked" | "interrupted";

export type SpanDetail =
  | { kind: "run"; outcome: RunTrace["outcome"]; task: string; tokens: number; costUsd: number | null; aggregate?: RunTrace["aggregate"]; notes: string[]; ledger: RunTrace["ledger"]; verification: RunTrace["verification"]; inputMessages?: unknown }
  | { kind: "llm"; iteration: number; tokens?: number; finishReason?: string; responseText?: string; error?: string }
  | { kind: "tool"; tool: string; argsPreview?: string; args?: string; result?: string; error?: string; childRunId?: string }
  | { kind: "approval"; label: string; approvalKind: string };

export interface Span {
  id: string;
  parentId?: string;
  kind: SpanKind;
  name: string;
  agent: string;
  status: SpanStatus;
  startMs: number;
  endMs: number;
  tokens?: number;
  costUsd?: number | null;
  error?: string;
  detail: SpanDetail;
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function runStatus(outcome: RunTrace["outcome"]): SpanStatus {
  return outcome === "completed" ? "ok" : outcome === "failed" ? "error" : outcome; // blocked | interrupted map through
}

/** Read a run's initial input messages (best-effort; the "assembled prompt" for the drill-in). */
function readInputMessages(ws: string, runId: string): unknown {
  const file = join(paths.runRecordDir(ws, runId), "input.json");
  if (!existsSync(file)) return undefined;
  try { return (JSON.parse(readFileSync(file, "utf8")) as { messagesPassedToModel?: unknown }).messagesPassedToModel; }
  catch { return undefined; }
}

/** Tokens off a model_response usage payload (totalTokens, else in+out). */
function usageTokens(usage: unknown): number | undefined {
  const u = asObj(usage);
  const total = num(u.totalTokens);
  if (total != null) return total;
  const sum = (num(u.inputTokens) ?? 0) + (num(u.outputTokens) ?? 0);
  return sum || undefined;
}

/** Build the llm / tool / approval spans for ONE run from its transcript events. */
function childSpansOf(ws: string, trace: RunTrace): Span[] {
  const events = readRunTranscript(ws, trace.id);
  const spans: Span[] = [];
  const at = (ts: string) => Date.parse(ts);

  // ── llm spans: pair model_request(iter) → model_response|model_error(iter) ──
  const req = new Map<number, RunTranscriptEvent>();
  const resp = new Map<number, RunTranscriptEvent>();
  const err = new Map<number, RunTranscriptEvent>();
  for (const e of events) {
    if (e.iteration == null) continue;
    if (e.kind === "model_request") req.set(e.iteration, e);
    else if (e.kind === "model_response") resp.set(e.iteration, e);
    else if (e.kind === "model_error") err.set(e.iteration, e);
  }
  for (const [iter, r] of [...req.entries()].sort((a, b) => a[0] - b[0])) {
    const done = resp.get(iter) ?? err.get(iter);
    const errored = !resp.get(iter) && !!err.get(iter);
    const d = asObj(done?.data);
    const toolCalls = Array.isArray(d.toolCalls) ? d.toolCalls : [];
    spans.push({
      id: `${trace.id}#llm${iter}`,
      parentId: trace.id,
      kind: "llm",
      name: `llm #${iter}`,
      agent: trace.agent,
      status: errored ? "error" : "ok",
      startMs: at(r.ts),
      endMs: done ? at(done.ts) : at(r.ts),
      tokens: usageTokens(d.usage),
      error: errored ? str(d.error) : undefined,
      detail: {
        kind: "llm",
        iteration: iter,
        tokens: usageTokens(d.usage),
        finishReason: errored ? undefined : toolCalls.length ? "tool-calls" : "stop",
        responseText: str(d.text),
        error: errored ? str(d.error) : undefined,
      },
    });
  }

  // ── tool spans: pair tool_start(callId) → tool_end(callId) ──
  const tStart = new Map<string, RunTranscriptEvent>();
  const tEnd = new Map<string, RunTranscriptEvent>();
  for (const e of events) {
    const callId = str(asObj(e.data).callId);
    if (!callId) continue;
    if (e.kind === "tool_start") tStart.set(callId, e);
    else if (e.kind === "tool_end") tEnd.set(callId, e);
  }
  for (const [callId, s] of tStart) {
    const end = tEnd.get(callId);
    const sd = asObj(s.data);
    const ed = asObj(end?.data);
    const toolName = str(sd.tool) ?? "tool";
    const errored = end ? ed.ok === false : false;
    spans.push({
      id: `${trace.id}#tool:${callId}`,
      parentId: trace.id,
      kind: "tool",
      name: toolName,
      agent: trace.agent,
      status: end ? (errored ? "error" : "ok") : "running",
      startMs: at(s.ts),
      endMs: end ? at(end.ts) : at(s.ts),
      error: errored ? str(ed.error) : undefined,
      detail: {
        kind: "tool",
        tool: toolName,
        argsPreview: str(sd.argsPreview),
        args: str(sd.args),
        result: str(ed.result),
        error: errored ? str(ed.error) : undefined,
        childRunId: str(ed.childRunId),
      },
    });
  }

  // ── approval spans: FIFO-pair approval_start → approval_end (one card blocks at a time) ──
  const aStarts = events.filter((e) => e.kind === "approval_start");
  const aEnds = events.filter((e) => e.kind === "approval_end");
  aStarts.forEach((s, i) => {
    const end = aEnds[i];
    const sd = asObj(s.data);
    const label = str(sd.label) ?? "approval";
    spans.push({
      id: `${trace.id}#approval${i}`,
      parentId: trace.id,
      kind: "approval",
      name: label,
      agent: trace.agent,
      status: end ? "ok" : "running",
      startMs: at(s.ts),
      endMs: end ? at(end.ts) : at(s.ts),
      detail: { kind: "approval", label, approvalKind: str(sd.kind) ?? "" },
    });
  });

  return spans;
}

/** Walk the delegation subtree rooted at `rootRunId`, reading each run's trace + transcript into
 *  Spans on a shared time axis. Run spans nest by delegation; llm/tool/approval spans nest under
 *  their run; a `delegate_task` tool span adopts its child run span (via the captured childRunId). */
export function deriveTrace(ws: string, rootRunId: string): Span[] {
  const spans: Span[] = [];
  const seen = new Set<string>();

  const walk = (runId: string, parentSpanId?: string) => {
    if (seen.has(runId)) return;
    seen.add(runId);
    let trace: RunTrace;
    try { trace = readTrace(ws, runId); }
    catch { return; } // a missing/unparseable child never breaks the rest of the tree
    const startMs = Date.parse(trace.started);
    const runSpan: Span = {
      id: trace.id,
      parentId: parentSpanId,
      kind: "run",
      name: `${trace.agent}${trace.triggeredBy === "user" ? " · chat" : " · deleg"}`,
      agent: trace.agent,
      status: runStatus(trace.outcome),
      startMs,
      endMs: startMs + (trace.durationMs || 0),
      tokens: trace.aggregate?.tokens ?? trace.tokens,
      costUsd: trace.aggregate ? trace.aggregate.costUsd : trace.costUsd,
      detail: {
        kind: "run",
        outcome: trace.outcome,
        task: trace.task,
        tokens: trace.tokens,
        costUsd: trace.costUsd,
        aggregate: trace.aggregate,
        notes: trace.notes,
        ledger: trace.ledger,
        verification: trace.verification,
        inputMessages: readInputMessages(ws, trace.id),
      },
    };
    spans.push(runSpan);
    const kids = childSpansOf(ws, trace);
    for (const k of kids) spans.push(k);

    // Recurse into delegated child runs, nesting each under its delegate_task tool span when the
    // childRunId was captured; otherwise directly under this run.
    const delegSpans = kids.filter((k) => k.kind === "tool" && k.detail.kind === "tool" && (k.detail.childRunId != null));
    const linked = new Set<string>();
    for (const d of delegSpans) {
      const childId = d.detail.kind === "tool" ? d.detail.childRunId : undefined;
      if (childId && trace.delegatedOut.includes(childId)) { linked.add(childId); walk(childId, d.id); }
    }
    for (const childId of trace.delegatedOut) if (!linked.has(childId)) walk(childId, runSpan.id);
  };

  walk(rootRunId);
  return spans;
}

/** The single header summary for a derived trace (root run span). */
export function traceSummary(spans: Span[]): { durationMs: number; tokens: number; costUsd: number | null; status: SpanStatus } | null {
  const runs = spans.filter((s) => s.kind === "run");
  if (!runs.length) return null;
  const root = runs.find((s) => s.parentId == null) ?? runs[0];
  const start = Math.min(...spans.map((s) => s.startMs).filter(Number.isFinite));
  const end = Math.max(...spans.map((s) => s.endMs).filter(Number.isFinite));
  return { durationMs: Math.max(0, end - start), tokens: root.tokens ?? 0, costUsd: root.costUsd ?? null, status: root.status };
}
