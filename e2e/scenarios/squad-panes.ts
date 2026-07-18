/** Scenario spec for the `squad-panes` evidence run (Plan 10 Phase 5, Layer 4).
 *
 *  Proves the Squad UI split-pane view (Plan 10 Phase 4): during a delegation taicho renders a live
 *  PANE + status-bar segment for EACH live agent at once. The blocker Phase 4 hit was timing — the
 *  `agent-flow` delegation returns sub-second, so a child's pane "flashes faster than a recorded
 *  frame." This scenario uses the SLOW-MODE `squad-panes` e2e model (packages/framework/src/core/e2e-model.ts), which
 *  holds the child's model call in-flight ~4s. During that window the DELEGATED CHILD renders its
 *  live pane + bar segment: proof-agent is `thinking` (its held model call is running) → the string
 *  "proof-agent thinking" appears ONLY on the live surfaces (bar + panes), never in the scrollback
 *  breadcrumb — so the tape's `Wait+Screen /proof-agent thinking/` gate PROVES the pane rendered
 *  before panes.png. (Root — the FOREGROUND run — is deliberately NOT in the squad panes/bar; its
 *  "delegating" state is carried by the busy spinner, so the squad surfaces show the SQUAD, not the
 *  turn's own root run. That's the same rule the consistent blocks already apply.)
 *
 *  Flow: boot dist/taicho with TAICHO_E2E_MODEL=squad-panes -> `/view both` (panes + bar) ->
 *  "create a proof worker agent" -> approve the New-agent card with `y` ->
 *  "use the proof worker to prove delegation works" -> root delegates (slow) -> both agents live in
 *  panes + bar (Wait+Screen gates + panes.png) -> completes ("Root used proof-agent").
 *
 *  Video is EVIDENCE, never the assertion: the workspace-file assertions below (the delegation trace
 *  exists + the child completed) decide pass/fail — same delegation proof set as agent-flow.
 *
 *  NOTE on tape paths: VHS 0.11.0 cannot tokenize absolute paths in `Output`/`Screenshot` (a leading
 *  `/` breaks its lexer). So the tape writes RELATIVE filenames and vhs is run with cwd = the temp
 *  workspace; the wrapper (`scripts/e2e-evidence.ts`) copies session.mp4 / *.png out of the workspace
 *  into `evidence/squad-panes/` afterwards.
 *  NOTE on Height: panes need vertical room (SquadPanes degrades to bar-only below MIN_PANE_ROWS, and
 *  budgets pane count by terminal height) — `Set Height 1000` gives room for both panes, matching the
 *  trace-inspector scenario's fix for Ink vertical clipping under VHS.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AssertionResult, Scenario } from "./types";

/** The second user prompt — asserted verbatim in the ledger. */
const SECOND_PROMPT = "use the proof worker to prove delegation works";
/** The child agent's proof phrase, produced by the squad-panes e2e model. */
const PROOF_PHRASE = "proof-agent completed delegated work";

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

/** The second root run (by run number) + its parsed trace. Throws if it isn't there yet. */
function secondRootRun(ws: string): { name: string; trace: RunTraceLike } {
  const files = rootTraceFiles(ws).sort((a, b) => runNumber(a) - runNumber(b));
  const second = files.find((f) => runNumber(f) === 2) ?? files[1];
  if (!second) throw new Error(`expected a 2nd root run, found ${files.length}: [${files.join(", ")}]`);
  const name = second.replace(/\.json$/, "");
  const trace = JSON.parse(readFileSync(join(ws, "runs", "root", second), "utf8")) as RunTraceLike;
  return { name, trace };
}

interface RunTraceLike {
  id: string;
  outcome: string;
  delegatedOut: string[];
}

/** The child run id the root delegated to (with the `proof-agent/` prefix). Throws if absent. */
function childRunId(ws: string): string {
  const { trace } = secondRootRun(ws);
  const id = (trace.delegatedOut ?? []).find((d) => d.startsWith("proof-agent/"));
  if (!id) throw new Error(`no proof-agent/ id in delegatedOut: [${(trace.delegatedOut ?? []).join(", ")}]`);
  return id;
}

/** Bare child run name (id without the `proof-agent/` prefix). */
function childRunName(ws: string): string {
  const id = childRunId(ws);
  return id.slice(id.indexOf("/") + 1);
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
  name: "squad-panes",
  e2eModelMode: "squad-panes",

  // Artifacts this tape writes (relative filenames — the wrapper copies them out of the temp ws into
  // evidence/squad-panes/ and records them in the manifest). panes.png is the keystone: two agents
  // live in panes + bar during the delegation. Keep in sync with the tape below.
  video: "session.mp4",
  screenshots: ["approval-card.png", "panes.png", "final.png"],

  // Every load-bearing wait gates Enter/Screenshot on stable on-screen text (Wait+Screen), never a
  // fixed Sleep — the SLOW is in the e2e MODEL (the ~4s child hold), not the tape. The gate before
  // panes.png (/proof-agent thinking/) requires the live CHILD pane to be on screen before the
  // screenshot — the delegated-agent-in-panes+bar proof (root is excluded from the squad surfaces).
  tape: ({ binary }) => `Output session.mp4
Set FontSize 16
Set Width 1200
Set Height 1000
Set TypingSpeed 40ms
Type "TAICHO_E2E_MODEL=squad-panes ${binary}"
Enter
Wait+Screen@15s /taicho/
Sleep 500ms
Type "/view both"
Wait+Screen@10s /view both/
Enter
Wait+Screen@10s /live view/
Sleep 400ms
Type "create a proof worker agent"
Wait+Screen@10s /create a proof worker agent/
Enter
Wait+Screen@15s /New agent/
Sleep 700ms
Screenshot approval-card.png
Type "y"
Wait+Screen@15s /Created proof-agent/
Sleep 500ms
Type "${SECOND_PROMPT}"
Wait+Screen@10s /use the proof worker to prove delegation works/
Enter
Wait+Screen@20s /proof-agent thinking/
Sleep 700ms
Screenshot panes.png
Wait+Screen@20s /Root used proof-agent/
Sleep 700ms
Screenshot final.png
Sleep 1s
Escape
Sleep 500ms
`,

  // The delegation-proof assertion set (mirrors agent-flow): seven checks on the workspace files the
  // binary produced. These — not the video — decide pass/fail. The video shows the two panes.
  assertions: async (ws: string): Promise<AssertionResult[]> => [
    check(
      "agent file created",
      "agents/proof-agent/agent.md exists",
      () => {
        const exists = existsSync(join(ws, "agents", "proof-agent", "agent.md"));
        return { pass: exists, actual: exists ? "exists" : "<file missing>" };
      },
    ),
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
      "child run completed",
      "child trace outcome=completed",
      () => {
        const name = childRunName(ws);
        const child = JSON.parse(
          readFileSync(join(ws, "runs", "proof-agent", `${name}.json`), "utf8"),
        ) as RunTraceLike;
        return { pass: child.outcome === "completed", actual: `outcome=${child.outcome}` };
      },
    ),
    check(
      "child final.md has proof phrase",
      `child final.md contains "${PROOF_PHRASE}"`,
      () => {
        const name = childRunName(ws);
        const md = readFileSync(join(ws, "runs", "proof-agent", name, "final.md"), "utf8");
        return { pass: md.includes(PROOF_PHRASE), actual: md.includes(PROOF_PHRASE) ? "contains phrase" : md.slice(0, 120) };
      },
    ),
    check(
      "root child-runs.json has one entry",
      "root companion child-runs.json length=1",
      () => {
        const { name } = secondRootRun(ws);
        const arr = JSON.parse(readFileSync(join(ws, "runs", "root", name, "child-runs.json"), "utf8"));
        return { pass: Array.isArray(arr) && arr.length === 1, actual: `length=${Array.isArray(arr) ? arr.length : "not-array"}` };
      },
    ),
    check(
      "ledger has second prompt",
      `conversations/root/ledger.jsonl contains "${SECOND_PROMPT}"`,
      () => {
        const led = readFileSync(join(ws, "conversations", "root", "ledger.jsonl"), "utf8");
        return { pass: led.includes(SECOND_PROMPT), actual: led.includes(SECOND_PROMPT) ? "contains prompt" : "<prompt missing>" };
      },
    ),
  ],
};

export default scenario;
