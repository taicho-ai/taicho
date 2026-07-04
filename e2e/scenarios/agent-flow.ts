/** Scenario spec for the `agent-flow` evidence run (Plan 11, Layer 4).
 *
 *  A scenario = a VHS tape (drives the compiled binary through a real user flow) + a set of
 *  workspace-file assertions (decide pass/fail; the video is evidence, never the assertion).
 *
 *  Flow: boot dist/taicho with TAICHO_E2E_MODEL=agent-flow -> "create a proof worker agent" ->
 *  approve the New-agent card with `y` -> "use the proof worker to prove delegation works" ->
 *  root delegates to proof-agent and rolls the child's output back up.
 *
 *  NOTE on tape paths: VHS 0.11.0 cannot tokenize absolute paths in `Output`/`Screenshot`
 *  (a leading `/` breaks its lexer). So the tape writes RELATIVE filenames and vhs is run with
 *  cwd = the temp workspace; the wrapper (`scripts/e2e-evidence.ts`) copies session.mp4 /
 *  approval-card.png / final.png out of the workspace into `evidence/agent-flow/` afterwards.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface AssertionResult {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
}

export interface Scenario {
  name: string;
  e2eModelMode: string;
  /** Full .tape source. `binary` is the absolute path to dist/taicho (fine inside a Type string).
   *  Output/Screenshot paths are RELATIVE — see the file header for why. */
  tape: (p: { binary: string; evidenceDir: string }) => string;
  assertions: (ws: string) => Promise<AssertionResult[]>;
}

/** The second user prompt — asserted verbatim in the ledger. */
const SECOND_PROMPT = "use the proof worker to prove delegation works";
/** The child agent's proof phrase, produced by the agent-flow e2e model. */
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
  name: "agent-flow",
  e2eModelMode: "agent-flow",

  // The two prompt submits gate Enter on the typed text being on screen (Wait+Screen, not a
  // fixed Sleep) — same wait-for-render-before-Enter discipline as the Layer-1/2 tests, which
  // avoids the Ink TextInput submit race (Enter firing before the last keystroke commits).
  tape: ({ binary }) => `Output session.mp4
Set FontSize 16
Set Width 1200
Set Height 700
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
Screenshot approval-card.png
Type "y"
Wait+Screen@15s /Created proof-agent/
Sleep 500ms
Type "${SECOND_PROMPT}"
Wait+Screen@10s /use the proof worker to prove delegation works/
Enter
Wait+Screen@20s /Root used proof-agent/
Sleep 700ms
Screenshot final.png
Sleep 1s
Escape
Sleep 500ms
`,

  // Ported from e2e/agent-flow.tui.ts / CLI_TESTING.md. Seven assertions on the workspace files
  // the binary produced; these — not the video — decide pass/fail.
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
