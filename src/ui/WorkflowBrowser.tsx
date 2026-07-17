/** Plan 25 — the /workflows browser. A docked, read-only inspection mode over the chat, mirroring the Org
 *  browser's grammar (round cyan border, ▸ selection, dim ·-separated footer). Three screens: the LIST of
 *  teams and their workflow status, a team's STEPS (the graph), and a workflow's past RUNS. Running and
 *  proposing stay conversational (root's run_workflow / propose_workflow tools); this surface is for
 *  seeing what a team's process is and how its runs went. Display-only — the REPL owns the keyboard; this
 *  component just publishes a key handler on props.keyRef, exactly like OrgBrowser. */
import { Box, Text } from "ink";
import { useEffect, type MutableRefObject } from "react";
import type { CardKeyHandler } from "./ProposalCard";
import { listWorkflowRows, workflowRunRows, type WorkflowRow } from "./workflow-browser-model";
import { loadWorkflowDef } from "../store/workflows";
import type { WorkflowNode } from "../schemas/workflow";

export interface WorkflowUiState {
  sel: number; // selected team index in the list
  view?: string; // team id whose steps are shown (drill-in)
  runsFor?: string; // team id whose past runs are shown
}

export function initialWorkflowUi(): WorkflowUiState {
  return { sel: 0 };
}

export interface WorkflowBrowserProps {
  ws: string;
  width: number;
  st: WorkflowUiState;
  onChange: (next: WorkflowUiState | ((s: WorkflowUiState) => WorkflowUiState)) => void;
  keyRef: MutableRefObject<CardKeyHandler | null>;
  onClose: () => void;
  bump?: number; // bump to force a re-read after a mutation elsewhere
}

const clamp = (i: number, len: number): number => (len === 0 ? 0 : Math.max(0, Math.min(i, len - 1)));

const runGlyph = (status: string): { g: string; color: string } =>
  status === "done" ? { g: "✓", color: "green" }
  : status === "failed" ? { g: "✗", color: "red" }
  : status === "interrupted" ? { g: "?", color: "yellow" }
  : status === "parked" ? { g: "✋", color: "red" }
  : { g: "◐", color: "yellow" };

/** A compact one-line label for a step in the graph view. */
function stepLabel(s: WorkflowNode): { glyph: string; color: string; who: string; io: string } {
  switch (s.kind) {
    case "agent": return { glyph: "▸", color: "cyan", who: s.run, io: [s.consumes.length ? s.consumes.join(",") : "", s.produces ? `→ ${s.produces}` : ""].filter(Boolean).join("  ") };
    case "check": return { glyph: "✓", color: "green", who: `check`, io: s.check };
    case "human": return { glyph: "✋", color: "red", who: `you`, io: s.choices.join(" │ ") };
    case "branch": return { glyph: "⑂", color: "yellow", who: s.branch, io: Object.keys(s.routes).join(" / ") };
    case "parallel": return { glyph: "⇉", color: "magenta", who: "parallel", io: s.produces ? `→ ${s.produces}` : "" };
  }
}

export function WorkflowBrowser(props: WorkflowBrowserProps): React.ReactElement {
  const rows = listWorkflowRows(props.ws);
  const st = props.st;

  const handler: CardKeyHandler = (input, key) => {
    if (st.view || st.runsFor) {
      if (key.escape) props.onChange((s) => ({ ...s, view: undefined, runsFor: undefined }));
      return;
    }
    if (key.escape) { props.onClose(); return; }
    if (key.upArrow) { props.onChange((s) => ({ ...s, sel: clamp(s.sel - 1, rows.length) })); return; }
    if (key.downArrow) { props.onChange((s) => ({ ...s, sel: clamp(s.sel + 1, rows.length) })); return; }
    const row = rows[clamp(st.sel, rows.length)];
    if (key.return) { if (row?.kind === "structured") props.onChange((s) => ({ ...s, view: row.team })); return; }
    if (input === "h") { if (row?.kind === "structured") props.onChange((s) => ({ ...s, runsFor: row.team })); return; }
  };
  props.keyRef.current = handler;
  useEffect(() => () => { props.keyRef.current = null; }, []); // publish during render; clear on unmount

  // ── STEPS view ──────────────────────────────────────────────────────────────────────────────────
  if (st.view) {
    const def = loadWorkflowDef(props.ws, st.view);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
        <Text color="cyan" bold>WORKFLOW · {st.view} <Text dimColor>— {def ? `${def.id} · ${def.steps.length} steps` : "no structured workflow"}</Text></Text>
        <Box height={1} />
        {def?.steps.map((s, i) => {
          const l = stepLabel(s);
          return (
            <Text key={s.id}>
              <Text color={l.color}>{l.glyph}</Text> {String(i + 1).padStart(2)} <Text color="cyan">{s.id}</Text>  <Text dimColor>{l.who}{l.io ? `  ${l.io}` : ""}</Text>
            </Text>
          );
        })}
        <Box height={1} />
        <Text dimColor>← esc back{def ? " · h past runs" : ""}</Text>
      </Box>
    );
  }

  // ── RUNS view ───────────────────────────────────────────────────────────────────────────────────
  if (st.runsFor) {
    const def = loadWorkflowDef(props.ws, st.runsFor);
    const runs = def ? workflowRunRows(props.ws, def) : [];
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
        <Text color="cyan" bold>WORKFLOWS · {st.runsFor} runs <Text dimColor>— {runs.length} run{runs.length === 1 ? "" : "s"}</Text></Text>
        <Box height={1} />
        {runs.length === 0 && <Text dimColor>never run</Text>}
        {runs.map((r) => {
          const g = runGlyph(r.status);
          return <Text key={r.runId}><Text color={g.color}>{g.g}</Text> <Text color="cyan">{r.runId}</Text>  <Text dimColor>{r.status} · {r.done}/{r.total}</Text></Text>;
        })}
        <Box height={1} />
        <Text dimColor>← esc back</Text>
      </Box>
    );
  }

  // ── LIST screen ─────────────────────────────────────────────────────────────────────────────────
  const structured = rows.filter((r) => r.kind === "structured").length;
  const sel = clamp(st.sel, rows.length);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
      <Text><Text color="cyan" bold>WORKFLOWS </Text><Text dimColor>  {rows.length} team{rows.length === 1 ? "" : "s"} · {structured} structured</Text></Text>
      <Box height={1} />
      {rows.length === 0 && <Text dimColor>no teams yet — create one, then propose a workflow for it</Text>}
      {rows.map((r, i) => <WorkflowListRow key={r.team} row={r} on={i === sel} />)}
      <Box height={1} />
      <Text dimColor>↑↓ · ⏎ steps · h past runs · esc · (run/propose via root)</Text>
    </Box>
  );
}

function WorkflowListRow({ row, on }: { row: WorkflowRow; on: boolean }): React.ReactElement {
  const summary =
    row.kind === "structured" ? `${row.steps} steps${row.gates ? ` · ${row.gates} gate${row.gates === 1 ? "" : "s"}` : ""}`
    : row.kind === "prose" ? "prose (runs on the agentic brief)"
    : "— no workflow";
  const last = row.kind === "structured" && row.runs > 0 ? runGlyph(row.lastStatus ?? "") : null;
  return (
    <Text>
      <Text color={on ? "cyan" : undefined} bold={on}>{on ? "▸ " : "  "}{row.team.padEnd(14)}</Text>
      <Text dimColor>{summary}</Text>
      {last && <Text> <Text color={last.color}>{last.g}</Text><Text dimColor> {row.runs} run{row.runs === 1 ? "" : "s"}</Text></Text>}
    </Text>
  );
}
