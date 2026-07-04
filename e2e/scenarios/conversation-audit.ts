/** Scenario spec for the `conversation-audit` evidence run (Plan 11 Phase 3, Layer 4).
 *
 *  A scenario = a VHS tape (drives the compiled binary through a real user flow) + a set of
 *  workspace-file assertions (decide pass/fail; the video is evidence, never the assertion).
 *
 *  Flow (ports e2e/conversation-audit.tui.ts): boot dist/taicho with
 *  TAICHO_E2E_MODEL=conversation-audit -> submit a chat turn -> the deterministic e2e model HANGS
 *  the model call, so the run is genuinely in-flight -> press Esc to cancel mid-run -> the run is
 *  recorded as `interrupted` and its audit trail (ledger, context decision, transcript, failure.md,
 *  task) is preserved. The assertions read those workspace files; the video shows the interruption.
 *
 *  NOTE on tape paths: VHS 0.11.0 cannot tokenize absolute paths in `Output`/`Screenshot`
 *  (a leading `/` breaks its lexer). So the tape writes RELATIVE filenames and vhs is run with
 *  cwd = the temp workspace; the wrapper (`scripts/e2e-evidence.ts`) copies session.mp4 /
 *  run-in-flight.png / interrupted.png out of the workspace into `evidence/conversation-audit/`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AssertionResult, Scenario } from "./types";

/** The chat prompt — asserted verbatim in input.json + the ledger (matches the tui-test's prompt). */
const PROMPT = "please start a real cli run, then I will cancel it";

// ── run-id discovery (run ids are date-stamped, e.g. 2026-07-04-run1 — never hardcode) ──

function rootTraceFiles(ws: string): string[] {
  const dir = join(ws, "runs", "root");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

interface RunTraceLike {
  id: string;
  outcome: string;
  task: string;
}

/** The single root run of this scenario (one chat turn) + its parsed trace. Throws if absent. */
function rootRun(ws: string): { name: string; trace: RunTraceLike } {
  const files = rootTraceFiles(ws).sort();
  if (files.length === 0) throw new Error("no root trace .json written yet");
  // One chat turn ⇒ one root trace; take the last by name for robustness if a placeholder lingers.
  const file = files.at(-1)!;
  const name = file.replace(/\.json$/, "");
  const trace = JSON.parse(readFileSync(join(ws, "runs", "root", file), "utf8")) as RunTraceLike;
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
  name: "conversation-audit",
  e2eModelMode: "conversation-audit",

  // Artifacts this tape writes (relative filenames — the wrapper copies them out of the temp ws
  // into evidence/conversation-audit/ and records them in the manifest). Keep in sync with the tape.
  video: "session.mp4",
  screenshots: ["run-in-flight.png", "interrupted.png"],

  // Every load-bearing wait is gated on stable on-screen text (Wait+Screen), never a fixed Sleep:
  //  - the typed prompt before Enter (dodges the Ink TextInput submit race),
  //  - "root → find_skills()" — the tool breadcrumb the e2e model emits on its first cycle. It only
  //    prints once the run has moved past first-turn workspace setup into a hanging model call, and
  //    the transcript already has that cycle's events. Gating the Esc on it makes the interrupt land
  //    while the model is genuinely in-flight (not during setup) WITHOUT a load-bearing fixed sleep.
  //  - "interrupted" — the post-run trace breadcrumb, which only prints once the run settled as
  //    interrupted and its audit files are on disk.
  tape: ({ binary }) => `Output session.mp4
Set FontSize 16
Set Width 1200
Set Height 700
Set TypingSpeed 40ms
Type "TAICHO_E2E_MODEL=conversation-audit ${binary}"
Enter
Wait+Screen@15s /taicho/
Sleep 500ms
Type "${PROMPT}"
Wait+Screen@10s /please start a real cli run/
Enter
Wait+Screen@15s /find_skills/
Sleep 700ms
Screenshot run-in-flight.png
Escape
Wait+Screen@15s /interrupted/
Sleep 1s
Screenshot interrupted.png
Escape
Sleep 500ms
`,

  // Ported from e2e/conversation-audit.tui.ts. Seven assertions on the workspace files the binary
  // produced for the interrupted turn; these — not the video — decide pass/fail.
  assertions: async (ws: string): Promise<AssertionResult[]> => [
    check(
      "root run recorded as interrupted",
      "exactly 1 root trace; outcome=interrupted",
      () => {
        const files = rootTraceFiles(ws);
        const { trace } = rootRun(ws);
        return {
          pass: files.length === 1 && trace.outcome === "interrupted",
          actual: `${files.length} trace(s); outcome=${trace.outcome}`,
        };
      },
    ),
    check(
      "run input.json has the prompt",
      `runs/root/<runId>/input.json contains "${PROMPT}"`,
      () => {
        const { name } = rootRun(ws);
        const input = readFileSync(join(ws, "runs", "root", name, "input.json"), "utf8");
        return { pass: input.includes(PROMPT), actual: input.includes(PROMPT) ? "contains prompt" : "<prompt missing>" };
      },
    ),
    check(
      "ledger has the interrupted turn's prompt",
      `conversations/root/ledger.jsonl contains "${PROMPT}"`,
      () => {
        const led = readFileSync(join(ws, "conversations", "root", "ledger.jsonl"), "utf8");
        return { pass: led.includes(PROMPT), actual: led.includes(PROMPT) ? "contains prompt" : "<prompt missing>" };
      },
    ),
    check(
      "context marks the interrupted run unsafe to replay",
      `conversations/root/context.json contains "interrupted_run_not_safe_as_context"`,
      () => {
        const ctx = readFileSync(join(ws, "conversations", "root", "context.json"), "utf8");
        const marker = "interrupted_run_not_safe_as_context";
        return { pass: ctx.includes(marker), actual: ctx.includes(marker) ? "contains marker" : "<marker missing>" };
      },
    ),
    check(
      "run transcript persisted",
      "runs/root/<runId>/transcript.jsonl exists",
      () => {
        const { name } = rootRun(ws);
        const exists = existsSync(join(ws, "runs", "root", name, "transcript.jsonl"));
        return { pass: exists, actual: exists ? "exists" : "<file missing>" };
      },
    ),
    check(
      "failure evidence written",
      "runs/root/<runId>/failure.md exists",
      () => {
        const { name } = rootRun(ws);
        const exists = existsSync(join(ws, "runs", "root", name, "failure.md"));
        return { pass: exists, actual: exists ? "exists" : "<file missing>" };
      },
    ),
    check(
      "task state recorded for the run",
      "a tasks/*.json file references the run id",
      () => {
        const { name } = rootRun(ws);
        const dir = join(ws, "tasks");
        const has = existsSync(dir) && readdirSync(dir).some((f) => f.includes(name));
        return { pass: has, actual: has ? "task references run" : "<no task for run>" };
      },
    ),
  ],
};

export default scenario;
