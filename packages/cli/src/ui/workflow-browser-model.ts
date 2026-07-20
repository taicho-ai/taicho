/** Plan 25: the /workflows browser's PURE model — the rows each screen renders, read from the stores.
 *  No Ink here, so it's unit-testable (mirrors org-browser-model.ts). The component renders these. */
import { listTeams } from "@taicho-ai/framework/store/teams";
import { DEFAULT_TEAM_ID } from "@taicho-ai/contracts/team";
import { loadWorkflowDef, loadWorkflow } from "@taicho-ai/framework/store/workflows";
import { listWorkflowRunIds, foldWorkflowRun } from "@taicho-ai/graph";
import type { WorkflowDef } from "@taicho-ai/graph";

export type WorkflowKind = "structured" | "prose" | "none";

export interface WorkflowRow {
  team: string;
  kind: WorkflowKind;
  name?: string; // structured: the workflow name (def.id)
  steps: number; // structured: step count · prose: seat count · none: 0
  gates: number; // structured: human-gate count
  runs: number; // past run count
  lastStatus?: string; // last run's overall status
}

/** Run ids are `wr_<wf>_<n>`; sort by the numeric suffix (a lexical sort mis-orders _10 before _2). */
const runNumber = (id: string): number => Number(/_(\d+)$/.exec(id)?.[1] ?? 0);

/** One row per team (excluding `default`), classifying its workflow and summarizing its runs. */
export function listWorkflowRows(ws: string): WorkflowRow[] {
  return listTeams(ws)
    .filter((t) => t.id !== DEFAULT_TEAM_ID)
    .map((t): WorkflowRow => {
      const def = loadWorkflowDef(ws, t.id);
      if (def) {
        const runIds = listWorkflowRunIds(ws, def.id).sort((a, b) => runNumber(a) - runNumber(b));
        const last = runIds.length ? foldWorkflowRun(ws, def, runIds[runIds.length - 1]!) : null;
        return {
          team: t.id,
          kind: "structured",
          name: def.id,
          steps: def.steps.length,
          gates: def.steps.filter((s) => s.kind === "human").length,
          runs: runIds.length,
          lastStatus: last?.status,
        };
      }
      const prose = loadWorkflow(ws, t.id);
      if (prose) return { team: t.id, kind: "prose", steps: prose.sections.size, gates: 0, runs: 0 };
      return { team: t.id, kind: "none", steps: 0, gates: 0, runs: 0 };
    })
    .sort((a, b) => a.team.localeCompare(b.team));
}

export interface RunRow {
  runId: string;
  status: string;
  done: number;
  total: number;
}

/** Past runs of a workflow, newest-first, with folded status + counts. */
export function workflowRunRows(ws: string, def: WorkflowDef): RunRow[] {
  return listWorkflowRunIds(ws, def.id)
    .sort((a, b) => runNumber(b) - runNumber(a)) // newest first
    .map((runId): RunRow => {
      const s = foldWorkflowRun(ws, def, runId);
      return { runId, status: s.status, done: s.counts.done, total: s.counts.total };
    });
}
