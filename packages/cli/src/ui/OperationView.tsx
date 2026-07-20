/** Plan 13 — the operation view (drill-in). Opening a focused block gives it the full screen — this
 *  is where "see the whole thing" lives, so the squad surface can stay two lines.
 *
 *  ← esc   / <name>
 *  <name> · ✓ done · 19s · 4.5k tok · via <parent>
 *
 *  BRIEF     <the goal/brief this agent was given>
 *  OUTPUT    <the agent's FULL, untrimmed output — scrollable>
 *            ↑↓ scroll · N more lines
 *  TOOLS     <tools it ran, e.g. use_skill(...) · save_artifact>
 *  ARTIFACT  <artifact@vN> → handed to <consumers>
 *
 *  Data source: reuses the per-run evidence the /trace inspector already reads — the run's input.json
 *  (brief), transcript.jsonl / final.md (full output), trace.artifacts (artifact + consumers). Owns
 *  the keyboard while open via the cardKeyRef pattern (same as TraceInspector). */
import { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { readTrace } from "@taicho-ai/framework/store/trace";
import { readRunTranscript, type RunTranscriptEvent } from "@taicho-ai/framework/store/run-transcript";
import { readArtifact } from "@taicho-ai/framework/store/artifacts";
import { artifactHandle } from "@taicho-ai/contracts/artifact";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@taicho-ai/framework/store/files";
import type { CardKeyHandler } from "./ProposalCard";

interface OperationData {
  runId: string;
  agent: string;
  brief: string;
  output: string;
  tools: string[];
  artifact?: string;
  tokens: number;
  durationMs: number;
  outcome: string;
  parentAgent?: string;
}

function readFinalOutput(ws: string, runId: string): string {
  const file = join(paths.runRecordDir(ws, runId), "final.md");
  if (!existsSync(file)) return "";
  try { return readFileSync(file, "utf8").trim(); }
  catch { return ""; }
}

function readBrief(ws: string, runId: string): string {
  const file = join(paths.runRecordDir(ws, runId), "input.json");
  if (!existsSync(file)) return "";
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { brief?: { goal?: string } };
    return data.brief?.goal ?? "";
  }
  catch { return ""; }
}

function extractTools(events: RunTranscriptEvent[]): string[] {
  const tools: string[] = [];
  for (const e of events) {
    if (e.kind === "tool_start") {
      const data = e.data as { tool?: string; argsPreview?: string } | undefined;
      if (data?.tool) {
        const args = data.argsPreview ? `(${data.argsPreview})` : "";
        tools.push(`${data.tool}${args}`);
      }
    }
  }
  return tools;
}

export function loadOperationData(ws: string, runId: string): OperationData | null {
  const trace = readTrace(ws, runId);
  if (!trace) return null;

  const events = readRunTranscript(ws, runId);
  const output = readFinalOutput(ws, runId);
  const brief = readBrief(ws, runId);

  let artifact: string | undefined;
  if (trace.artifacts.length > 0) {
    const handle = trace.artifacts[0];
    artifact = typeof handle === "string" ? handle : artifactHandle(handle);
  }

  // Duration is not stored on the trace; compute from transcript events if available
  let durationMs = 0;
  if (events.length >= 2) {
    const first = Date.parse(events[0].ts);
    const last = Date.parse(events[events.length - 1].ts);
    if (!isNaN(first) && !isNaN(last)) durationMs = last - first;
  }

  return {
    runId,
    agent: trace.agent,
    brief,
    output,
    tools: extractTools(events),
    artifact,
    tokens: trace.tokens ?? 0,
    durationMs,
    outcome: trace.outcome ?? "unknown",
    parentAgent: undefined, // parentAgent is not stored on the trace
  };
}

const MAX_OUTPUT_LINES = 50;

export function OperationView({
  ws,
  runId,
  width,
  keyHandlerRef,
  onClose,
}: {
  ws: string;
  runId: string;
  width: number;
  keyHandlerRef: React.MutableRefObject<CardKeyHandler | null>;
  onClose: () => void;
}) {
  const [scroll, setScroll] = useState(0);
  const data = loadOperationData(ws, runId);

  const outputLines = data?.output.split("\n") ?? [];
  const visibleLines = Math.min(MAX_OUTPUT_LINES, outputLines.length);
  const maxScroll = Math.max(0, outputLines.length - visibleLines);

  const handler = (input: string, key: { escape: boolean; upArrow: boolean; downArrow: boolean; return: boolean; tab?: boolean }) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { setScroll((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setScroll((s) => Math.min(maxScroll, s + 1)); return; }
  };

  useEffect(() => {
    keyHandlerRef.current = handler;
    return () => { if (keyHandlerRef.current === handler) keyHandlerRef.current = null; };
  }, [keyHandlerRef, maxScroll]);

  if (!data) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>no data for run {runId}</Text>
        <Text dimColor>esc to close</Text>
      </Box>
    );
  }

  const secs = (data.durationMs / 1000).toFixed(1);
  const outcomeIcon = data.outcome === "completed" ? "✓" : data.outcome === "failed" ? "✗" : "·";
  const outcomeColor = data.outcome === "completed" ? "green" : data.outcome === "failed" ? "red" : "gray";
  const via = data.parentAgent ? ` via ${data.parentAgent}` : "";
  const headerLine = `${data.agent} · ${outcomeIcon} ${data.outcome} · ${secs}s · ${data.tokens} tok${via}`;

  const visibleOutput = outputLines.slice(scroll, scroll + visibleLines);
  const moreLines = outputLines.length - visibleLines;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
      <Text dimColor>← esc   / {data.agent}</Text>
      <Text color={outcomeColor}>{headerLine}</Text>
      <Text> </Text>
      <Text color="cyan" bold>BRIEF</Text>
      <Text dimColor>{data.brief || "(no brief)"}</Text>
      <Text> </Text>
      <Text color="cyan" bold>OUTPUT</Text>
      {visibleOutput.map((line, i) => (
        <Text key={i}>{line || " "}</Text>
      ))}
      {moreLines > 0 && <Text dimColor>  ↑↓ scroll · {moreLines} more lines</Text>}
      <Text> </Text>
      <Text color="cyan" bold>TOOLS</Text>
      <Text dimColor>{data.tools.length > 0 ? data.tools.join(" · ") : "(no tools)"}</Text>
      {data.artifact && (
        <>
          <Text> </Text>
          <Text color="cyan" bold>ARTIFACT</Text>
          <Text>{data.artifact}</Text>
        </>
      )}
      <Text> </Text>
      <Text dimColor>esc to close</Text>
    </Box>
  );
}
