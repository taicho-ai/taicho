/** Scenario spec for the `trace-inspector` evidence run (Plan 02 Phase 5, Layer 4).
 *
 *  A scenario = a VHS tape (drives the compiled binary through a real user flow) + a set of
 *  workspace-file assertions (decide pass/fail; the video is evidence, never the assertion).
 *
 *  Flow (reuses the `agent-flow` e2e model, which already produces a delegation trace):
 *    boot dist/taicho with TAICHO_E2E_MODEL=agent-flow
 *    -> "create a proof worker agent" -> approve the New-agent card with `y`
 *    -> "use the proof worker to prove delegation works" -> root delegates to proof-agent
 *    -> a real delegation trace now exists on disk
 *    -> type `/trace` (no arg = latest run) -> the waterfall inspector opens
 *    -> `⏎` on the root run span -> its detail view (outcome / rolled-up cost / coaching ledger)
 *  Screenshots capture the waterfall tree and the drilled-in detail.
 *
 *  Pass/fail is decided by the workspace-file assertions below (video is evidence, not assertion):
 *  the delegation trace files exist AND `deriveTrace` — the exact pure derivation the inspector
 *  renders from — yields the delegation tree (root run span, a `delegate_task` tool span linked to a
 *  nested proof-agent run span). If the tape's `Wait+Screen` gates never see the tree/detail, vhs
 *  times out -> the wrapper's `vhsOk` is false -> the scenario fails.
 *
 *  Screen-gating is deterministic (never a load-bearing fixed Sleep):
 *   - the two prompt submits gate Enter on the typed text (dodges the Ink TextInput submit race);
 *   - the `/trace` submit gates Enter on "waterfall inspector" — the /trace command's summary in the
 *     live suggester, which appears ONLY once `/trace` is fully typed and (unlike the bare word
 *     "trace", which is already on screen in the post-run `· /trace to inspect` hint) is unambiguous;
 *   - the tree render gates on "TRACE" — the inspector's header, which appears nowhere else;
 *   - the drill-in gates on "coaching ledger" — a line rendered only in the run-span detail view.
 *
 *  NOTE on tape paths: VHS 0.11.0 cannot tokenize absolute paths in `Output`/`Screenshot`
 *  (a leading `/` breaks its lexer). So the tape writes RELATIVE filenames and vhs is run with
 *  cwd = the temp workspace; the wrapper (`scripts/e2e-evidence.ts`) copies session.mp4 /
 *  trace-tree.png / trace-detail.png out of the workspace into `evidence/trace-inspector/`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveTrace, type Span } from "../../src/core/trace-tree";
import type { AssertionResult, Scenario } from "./types";

/** The second user prompt — it triggers the delegation whose trace we open. */
const SECOND_PROMPT = "use the proof worker to prove delegation works";

// ── run-id discovery (run ids are date-stamped, e.g. 2026-07-04-run2 — never hardcode) ──

function rootTraceFiles(ws: string): string[] {
  const dir = join(ws, "runs", "root");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

function runNumber(file: string): number {
  const m = file.match(/-run(\d+)\.json$/);
  return m ? Number(m[1]) : NaN;
}

interface RunTraceLike {
  id: string;
  outcome: string;
  delegatedOut: string[];
}

/** The second root run (the delegating turn, by run number) + its parsed trace. Throws if absent. */
function secondRootRun(ws: string): { name: string; trace: RunTraceLike } {
  const files = rootTraceFiles(ws).sort((a, b) => runNumber(a) - runNumber(b));
  const second = files.find((f) => runNumber(f) === 2) ?? files[1];
  if (!second) throw new Error(`expected a 2nd root run, found ${files.length}: [${files.join(", ")}]`);
  const name = second.replace(/\.json$/, "");
  const trace = JSON.parse(readFileSync(join(ws, "runs", "root", second), "utf8")) as RunTraceLike;
  return { name, trace };
}

// ── assertion runner: each assertion catches its own error so one failure never hides the rest ──

function check(name: string, expected: string, fn: () => { pass: boolean; actual: string }): AssertionResult {
  try {
    const { pass, actual } = fn();
    return { name, pass, expected, actual };
  } catch (e) {
    return { name, pass: false, expected, actual: `<error: ${(e as Error).message}>` };
  }
}

const scenario: Scenario = {
  name: "trace-inspector",
  e2eModelMode: "agent-flow", // reuse the delegation-producing model; we open the trace it leaves

  // Artifacts this tape writes (relative filenames — the wrapper copies them out of the temp ws into
  // evidence/trace-inspector/ and records them in the manifest). Keep in sync with the tape below.
  video: "session.mp4",
  screenshots: ["trace-tree.png", "trace-detail.png"],

  tape: ({ binary }) => `Output session.mp4
Set FontSize 16
Set Width 1200
Set Height 1000
Set TypingSpeed 40ms
Type "TAICHO_E2E_MODEL=agent-flow ${binary}"
Enter
Wait+Screen@15s /taicho/
Sleep 500ms
Type "create a proof worker agent"
Wait+Screen@10s /create a proof worker agent/
Enter
Wait+Screen@15s /New agent/
Sleep 700ms
Type "y"
Wait+Screen@15s /Created proof-agent/
Sleep 500ms
Type "${SECOND_PROMPT}"
Wait+Screen@10s /use the proof worker to prove delegation works/
Enter
Wait+Screen@20s /Root used proof-agent/
Sleep 700ms
Type "/trace"
Wait+Screen@10s /waterfall inspector/
Enter
Wait+Screen@15s /TRACE/
Sleep 700ms
Screenshot trace-tree.png
Enter
Wait+Screen@10s /coaching ledger/
Sleep 700ms
Screenshot trace-detail.png
Escape
Sleep 400ms
Escape
Sleep 400ms
Escape
Sleep 500ms
`,

  // File assertions on the workspace the binary produced. These — not the video — decide pass/fail.
  // The first three prove the delegation trace exists; the last three prove the exact inputs the
  // waterfall renders from are on disk AND that `deriveTrace` (the pure derivation the inspector uses)
  // yields the delegation tree the video shows.
  assertions: async (ws: string): Promise<AssertionResult[]> => [
    check(
      "second root run completed",
      "exactly 2 root traces; 2nd outcome=completed",
      () => {
        const files = rootTraceFiles(ws);
        const { trace } = secondRootRun(ws);
        return {
          pass: files.length === 2 && trace.outcome === "completed",
          actual: `${files.length} traces; 2nd outcome=${trace.outcome}`,
        };
      },
    ),
    check(
      "root delegated to proof-agent",
      "delegatedOut[0] starts with proof-agent/",
      () => {
        const { trace } = secondRootRun(ws);
        const d0 = (trace.delegatedOut ?? [])[0] ?? "";
        return { pass: d0.startsWith("proof-agent/"), actual: d0 || "<empty delegatedOut>" };
      },
    ),
    check(
      "root run transcript present (llm/tool span source)",
      "runs/root/<runId>/transcript.jsonl exists",
      () => {
        const { name } = secondRootRun(ws);
        const exists = existsSync(join(ws, "runs", "root", name, "transcript.jsonl"));
        return { pass: exists, actual: exists ? "exists" : "<file missing>" };
      },
    ),
    check(
      "root run input.json present (run-detail source)",
      "runs/root/<runId>/input.json exists",
      () => {
        const { name } = secondRootRun(ws);
        const exists = existsSync(join(ws, "runs", "root", name, "input.json"));
        return { pass: exists, actual: exists ? "exists" : "<file missing>" };
      },
    ),
    check(
      "deriveTrace yields the delegation tree",
      "root run span + delegate_task tool span (with childRunId) + nested proof-agent run span",
      () => {
        const { trace } = secondRootRun(ws);
        const spans: Span[] = deriveTrace(ws, trace.id);
        const rootRun = spans.find((s) => s.kind === "run" && s.parentId == null);
        const delegTool = spans.find(
          (s) => s.kind === "tool" && s.detail.kind === "tool" && s.detail.tool === "delegate_task" && !!s.detail.childRunId,
        );
        const childRun = spans.find((s) => s.kind === "run" && s.agent === "proof-agent");
        const childUnderTool = !!(delegTool && childRun && childRun.parentId === delegTool.id);
        const pass = !!rootRun && !!delegTool && !!childRun && childUnderTool;
        return {
          pass,
          actual: `spans=${spans.length}; rootRun=${!!rootRun}; delegateTool=${!!delegTool}; childRun=${!!childRun}; childUnderTool=${childUnderTool}`,
        };
      },
    ),
    check(
      "deriveTrace exposes the run-span coaching ledger (drill-in source)",
      "root run span detail carries a ledger object",
      () => {
        const { trace } = secondRootRun(ws);
        const spans: Span[] = deriveTrace(ws, trace.id);
        const rootRun = spans.find((s) => s.kind === "run" && s.parentId == null);
        const hasLedger = !!(rootRun && rootRun.detail.kind === "run" && rootRun.detail.ledger);
        return { pass: hasLedger, actual: hasLedger ? "ledger present" : "<no ledger on root run span>" };
      },
    ),
  ],
};

export default scenario;
