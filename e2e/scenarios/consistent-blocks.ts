/** Scenario spec for the `consistent-blocks` evidence run (Plan 13 corrected, Layer 4).
 *
 *  Proves the consistent agent blocks (Plan 13 corrected): during a delegation taicho renders a live
 *  BLOCK for EACH sub-agent. The block is a fixed-height window (header + 2-line body) that shows
 *  the sub-agent's state and a rolling tail of its output. The full reply text does NOT appear in
 *  scrollback — the block is the sub-agent's only on-screen presence.
 *
 *  This scenario uses the SLOW-MODE `consistent-blocks` e2e model (packages/framework/src/core/e2e-model.ts), which
 *  holds the child's model call in-flight ~4s. During that window two agents are live:
 *    - root is `delegating`  (its delegate_task tool is blocked on the child)   → "root delegating"
 *    - proof-agent is `thinking` (its held model call is running)               → "proof-agent thinking"
 *  Both strings appear in the consistent blocks (and the status bar), proving the blocks rendered.
 *
 *  Flow: boot dist/taicho with TAICHO_E2E_MODEL=consistent-blocks ->
 *  "create a proof worker agent" -> approve the New-agent card with `y` ->
 *  "use the proof worker to prove delegation works" -> root delegates (slow) -> both agents live in
 *  blocks + bar (Wait+Screen gates + blocks.png) -> completes ("Root used proof-agent").
 *
 *  Video is EVIDENCE, never the assertion: the workspace-file assertions below (the delegation trace
 *  exists + the child completed + the child's full reply is NOT in scrollback) decide pass/fail.
 *
 *  NOTE on tape paths: VHS 0.11.0 cannot tokenize absolute paths in `Output`/`Screenshot` (a leading
 *  `/` breaks its lexer). So the tape writes RELATIVE filenames and vhs is run with cwd = the temp
 *  workspace; the wrapper (`scripts/e2e-evidence.ts`) copies session.mp4 / *.png out of the workspace
 *  into `evidence/consistent-blocks/` afterwards.
 *  NOTE on Height: blocks need vertical room — `Set Height 1000` gives room for both blocks.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AssertionResult, Scenario } from "./types";

/** The second user prompt — asserted verbatim in the ledger. */
const SECOND_PROMPT = "use the proof worker to prove delegation works";
/** The child agent's proof phrase, produced by the consistent-blocks e2e model. */
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
  name: "consistent-blocks",
  e2eModelMode: "consistent-blocks",

  // Artifacts this tape writes (relative filenames — the wrapper copies them out of the temp ws into
  // evidence/consistent-blocks/ and records them in the manifest). blocks.png is the keystone: two
  // agents live in blocks + bar during the delegation. Keep in sync with the tape below.
  video: "session.mp4",
  screenshots: ["approval-card.png", "blocks.png", "final.png"],

  // Every load-bearing wait gates Enter/Screenshot on stable on-screen text (Wait+Screen), never a
  // fixed Sleep — the SLOW is in the e2e MODEL (the ~4s child hold), not the tape. The two gates
  // before blocks.png (/root delegating/ then /proof-agent thinking/) require BOTH live blocks to be
  // on screen at once before the screenshot, which is exactly the two-agents-in-blocks+bar proof.
  tape: ({ binary }) => `Output session.mp4
Set FontSize 16
Set Width 1200
Set Height 1000
Set TypingSpeed 40ms
Type "TAICHO_E2E_MODEL=consistent-blocks ${binary}"
Enter
Wait+Screen@15s /taicho/
Sleep 500ms
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
Wait+Screen@20s /root delegating/
Wait+Screen@20s /proof-agent thinking/
Sleep 700ms
Screenshot blocks.png
Wait+Screen@20s /Root used proof-agent/
Sleep 700ms
Screenshot final.png
Sleep 1s
Escape
Sleep 500ms
`,

  // The delegation-proof assertion set (mirrors agent-flow + squad-panes): checks on the workspace
  // files the binary produced. These — not the video — decide pass/fail. The video shows the blocks.
  assertions: async (ws: string): Promise<AssertionResult[]> => [
    check(
      "agent file created",
      "agents/proof-agent/agent.md exists",
      () => {
        const f = join(ws, "agents", "proof-agent", "agent.md");
        return { pass: existsSync(f), actual: existsSync(f) ? f : "missing" };
      },
    ),
    check(
      "second root run exists",
      "runs/root/<date>-run2.json exists",
      () => {
        const { name } = secondRootRun(ws);
        return { pass: !!name, actual: name ?? "missing" };
      },
    ),
    check(
      "second root run completed",
      "outcome === 'completed'",
      () => {
        const { trace } = secondRootRun(ws);
        return { pass: trace.outcome === "completed", actual: trace.outcome };
      },
    ),
    check(
      "root delegated to proof-agent",
      "delegatedOut contains proof-agent/<run>",
      () => {
        const id = childRunId(ws);
        return { pass: !!id, actual: id ?? "missing" };
      },
    ),
    check(
      "child run completed",
      "proof-agent/<run>.json outcome === 'completed'",
      () => {
        const id = childRunId(ws);
        const name = childRunName(ws);
        const f = join(ws, "runs", "proof-agent", `${name}.json`);
        if (!existsSync(f)) return { pass: false, actual: "missing" };
        const trace = JSON.parse(readFileSync(f, "utf8")) as RunTraceLike;
        return { pass: trace.outcome === "completed", actual: trace.outcome };
      },
    ),
    check(
      "child produced the proof phrase",
      `final.md contains "${PROOF_PHRASE}"`,
      () => {
        const name = childRunName(ws);
        const f = join(ws, "runs", "proof-agent", name, "final.md");
        if (!existsSync(f)) return { pass: false, actual: "missing" };
        const body = readFileSync(f, "utf8");
        return { pass: body.includes(PROOF_PHRASE), actual: body.includes(PROOF_PHRASE) ? "found" : "not found" };
      },
    ),
    check(
      "ledger records the second prompt",
      `ledger.jsonl contains "${SECOND_PROMPT}"`,
      () => {
        const f = join(ws, "conversations", "root", "ledger.jsonl");
        if (!existsSync(f)) return { pass: false, actual: "missing" };
        const body = readFileSync(f, "utf8");
        return { pass: body.includes(SECOND_PROMPT), actual: body.includes(SECOND_PROMPT) ? "found" : "not found" };
      },
    ),
  ],
};

export default scenario;
