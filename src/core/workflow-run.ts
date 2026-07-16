/** Plan 25: the integration layer — wire the pure workflow driver's injected seams to the real engine.
 *
 *  core/workflow.ts stays decoupled from run.ts (so the orchestration is unit-testable without a model);
 *  THIS module is where a workflow step becomes a real executeRun, a check becomes runChecker, and a human
 *  gate becomes a requestApproval. `runTeamWorkflow` loads a team's structured workflow and drives it.
 *
 *  The human gate reuses the EXISTING `ask_human` approval — the packet summary rides in the question, the
 *  choices are the options — so it works in the REPL and headless today with zero changes to the shared
 *  ApprovalRequest union. A rich workflow-gate card is a later (Phase 4) enhancement. */
import { executeRun, type RunDeps } from "./run";
import { runChecker } from "./verification";
import { executeWorkflow, type WorkflowExecDeps, type WorkflowInput } from "./workflow";
import { loadWorkflowDef } from "../store/workflows";
import { loadAgent } from "../store/roster";
import { readArtifactBody } from "../store/artifacts";
import type { WorkflowDef, WorkflowRunState } from "../schemas/workflow";

/** Adapt RunDeps → the driver's injected seams for a specific workflow. */
export function wireWorkflowDeps(deps: RunDeps, def: WorkflowDef): Omit<WorkflowExecDeps, "ws"> {
  return {
    signal: deps.signal,

    runAgent: async ({ step, brief, inputs, runId, triggeredBy }) => {
      const target = step.run.replace(/^@/, ""); // `@writer` in the file is the agent id `writer`
      const agent = await loadAgent(deps.ws, target);
      const child = await executeRun(deps, {
        agent,
        messages: [{ role: "user", content: brief || step.id }],
        brief: { from: `workflow:${def.id}`, goal: brief || step.id, fromRun: runId },
        inputArtifacts: inputs, // the edge state, by reference
        triggeredBy,
        viaTeam: def.team, // run UNDER the team, so it gets its Plan 23 lane if any
      });
      // The handle the step produced is the newest artifact THIS run wrote (trace.artifacts, id@vN).
      const produced = child.trace.artifacts[child.trace.artifacts.length - 1];
      return { childRunId: child.runId, outcome: child.trace.outcome, produced };
    },

    runCheck: async ({ node, target }) => {
      if (!target) return { pass: false, reasons: [`check "${node.id}" has no upstream artifact to verify`] };
      const body = readArtifactBody(deps.ws, target);
      if (body === null) return { pass: false, reasons: [`check "${node.id}": artifact ${target} is unreadable`] };
      const resolved = deps.resolveModel?.("root");
      const checkerAgent = await loadAgent(deps.ws, "root");
      const r = await runChecker({
        model: resolved?.model ?? deps.model,
        agent: checkerAgent,
        subscription: resolved?.subscription ?? false,
        priceUsd: deps.priceUsd,
        captureProviderCost: resolved?.captureCost,
        signal: deps.signal,
        spendLedger: deps.spendLedger,
        goal: `verify: ${node.check}`,
        criteria: node.check,
        output: body.toString("utf8"),
      });
      return { pass: r.verdict.pass, reasons: r.verdict.reasons };
    },

    requestGate: async ({ node, packet }) => {
      const summary = packet.items.map((i) => `${i.name} → ${i.handle}`).join(" · ") || "(no artifacts produced yet)";
      const question = `${node.human}\n\nreview packet: ${summary}`;
      const d = await deps.requestApproval({ kind: "ask_human", question, options: node.choices });
      return d.type === "answered" ? { choice: d.answer } : null;
    },

    classify: async ({ node, target }) => {
      const labels = Object.keys(node.routes);
      const agent = await loadAgent(deps.ws, node.branch.replace(/^@/, ""));
      const body = target ? (readArtifactBody(deps.ws, target)?.toString("utf8") ?? "") : "";
      const child = await executeRun(deps, {
        agent,
        messages: [{ role: "user", content: `Classify the input into exactly one of these labels: ${labels.join(", ")}.\nReply with ONLY the label.\n\n${body}` }],
        triggeredBy: `workflow:${def.id}:${node.id}`,
        viaTeam: def.team,
      });
      const text = child.text.toLowerCase();
      return labels.find((l) => text.includes(l.toLowerCase())) ?? labels[0] ?? "";
    },
  };
}

/** Load a team's structured workflow and run it deterministically. Null if the team has no `steps:` workflow. */
export async function runTeamWorkflow(
  deps: RunDeps,
  teamId: string,
  input?: WorkflowInput,
): Promise<WorkflowRunState | null> {
  const def = loadWorkflowDef(deps.ws, teamId);
  if (!def) return null;
  return executeWorkflow({ ws: deps.ws, ...wireWorkflowDeps(deps, def) }, def, input);
}
