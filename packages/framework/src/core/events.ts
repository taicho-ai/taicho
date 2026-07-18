/** Reader-side helpers for the on-disk run event stream — the observable surface a headless or
 *  external observer watches (documented in `docs/events.md`).
 *
 *  Each run writes `runs/<agent>/<recordId>/transcript.jsonl`: one JSON object per line, appended in
 *  order. This module reads that stream, finds the latest run, formats an event as a single human
 *  line, and provides a simple *tail* (print-then-follow) so an observer no longer has to poll files
 *  by hand. All output is passed through `redact()` so a tail can never leak auth material. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../store/files";
import type { RunTranscriptEvent } from "../store/run-transcript";
import { redact } from "./logger";

export type { RunTranscriptEvent } from "../store/run-transcript";

/** Parse a run's transcript.jsonl into events (skips blank/half-written trailing lines). */
export function readTranscript(ws: string, runId: string): RunTranscriptEvent[] {
  const file = join(paths.runRecordDir(ws, runId), "transcript.jsonl");
  if (!existsSync(file)) return [];
  const out: RunTranscriptEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as RunTranscriptEvent); } catch { /* skip a partially-flushed line */ }
  }
  return out;
}

/** All known run ids (`<agent>/<recordId>`), discovered from the per-agent trace JSON files. */
export function listRunIds(ws: string): string[] {
  const runsDir = join(ws, "runs");
  if (!existsSync(runsDir)) return [];
  const ids: string[] = [];
  for (const agent of readdirSync(runsDir)) {
    const agentDir = join(runsDir, agent);
    let entries: string[];
    try { entries = readdirSync(agentDir); } catch { continue; }
    for (const f of entries) {
      if (f.endsWith(".json")) ids.push(`${agent}/${f.slice(0, -".json".length)}`);
    }
  }
  return ids;
}

/** The most recently written run id, by trace-file mtime. Undefined when there are no runs. */
export function latestRunId(ws: string): string | undefined {
  let best: { id: string; mtime: number } | undefined;
  for (const id of listRunIds(ws)) {
    const i = id.indexOf("/");
    const traceFile = join(ws, "runs", id.slice(0, i), `${id.slice(i + 1)}.json`);
    let mtime = 0;
    try { mtime = statSync(traceFile).mtimeMs; } catch { /* ignore */ }
    if (!best || mtime > best.mtime) best = { id, mtime };
  }
  return best?.id;
}

/** One truncated, redacted line for an event (used by the tail). Never assumes a payload shape. */
export function formatEvent(event: RunTranscriptEvent): string {
  const iter = event.iteration != null ? ` iter ${event.iteration}` : "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = event.data as any;
  let detail = "";
  switch (event.kind) {
    case "model_request":
      detail = [d?.messageCount != null ? `${d.messageCount} msgs` : "", d?.contextTokens != null ? `~${d.contextTokens} tok` : "", d?.compacted ? "compacted" : ""].filter(Boolean).join(" · ");
      break;
    case "compaction":
      detail = `folded ${d?.foldedRoundTrips ?? "?"} round-trip(s) / ${d?.foldedMessages ?? "?"} msgs · ${d?.before ?? "?"}→${d?.after ?? "?"} tok`;
      break;
    case "model_response": {
      const text = typeof d?.text === "string" ? d.text.replace(/\s+/g, " ").trim() : "";
      const calls = Array.isArray(d?.toolCalls) ? d.toolCalls.length : 0;
      detail = [text ? `"${truncate(text, 60)}"` : "", calls ? `${calls} tool call(s)` : ""].filter(Boolean).join(" · ");
      break;
    }
    case "model_error":
      detail = typeof d?.error === "string" ? d.error : "";
      break;
    case "tool_call":
      detail = d?.toolName ? `${d.toolName}(${truncate(JSON.stringify(d.input ?? {}), 60)})` : "";
      break;
    case "verification":
      detail = d?.verdict ? `${d.verdict.pass ? "pass" : "FAIL"}${d.criteria ? ` — ${truncate(d.criteria, 50)}` : ""}` : "";
      break;
    default:
      detail = d ? truncate(JSON.stringify(d), 60) : "";
  }
  return redact(`[${event.ts}]${iter} ${event.kind}${detail ? `: ${detail}` : ""}`);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Print a run's events then (optionally) follow appends. Returns when done (non-follow) or when the
 *  signal aborts (follow). Polls rather than fs.watch — robust on macOS and fine for a human tail. */
export async function tailRun(opts: {
  ws: string;
  runId?: string;
  follow?: boolean;
  out?: (line: string) => void;
  intervalMs?: number;
  signal?: AbortSignal;
  /** In follow mode, wait up to this long for a not-yet-created transcript to appear. */
  waitForMs?: number;
}): Promise<void> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const interval = opts.intervalMs ?? 250;
  const runId = opts.runId ?? latestRunId(opts.ws);
  if (!runId) { out("(no runs found)"); return; }

  let printed = 0;
  const flush = () => {
    const events = readTranscript(opts.ws, runId);
    for (const e of events.slice(printed)) out(formatEvent(e));
    printed = events.length;
  };

  flush();
  if (!opts.follow) return;

  const deadline = Date.now() + (opts.waitForMs ?? 0);
  while (!opts.signal?.aborted) {
    await sleep(interval);
    flush();
    // If we've never seen an event and the grace window for a pending run elapsed, stop waiting.
    if (printed === 0 && opts.waitForMs != null && Date.now() > deadline) break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
