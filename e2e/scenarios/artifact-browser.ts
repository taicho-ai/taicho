/** Scenario spec for the `artifact-browser` evidence run (Plan 21 Phase 1, Layer 4).
 *
 *  Proves the artifact BROWSER (Plan 21, replacing Plan 15's bar + viewer): when a foreground turn
 *  completes with artifacts, the browser DOCKS ITSELF over the chat (no bar, no command), ⏎ opens the
 *  full-screen reader with the markdown body, and esc chains reader → shelf → chat. The artifact body
 *  is NOT in root's transcript — the browser is the read surface.
 *
 *  This scenario uses the SLOW-MODE `artifact-viewer` e2e model (src/core/e2e-model.ts), which holds
 *  the child's model call in-flight ~4s (the save_artifact tool call). During that window the
 *  completion bar is visible long enough for VHS to freeze-frame it.
 *
 *  Flow: boot dist/taicho with TAICHO_E2E_MODEL=artifact-viewer ->
 *  "create a proof worker agent" -> approve the New-agent card with `y` ->
 *  "use the proof worker to save a proof document" -> root delegates -> child saves artifact ->
 *  the browser docks itself (Wait+Screen /ARTIFACTS/ + Screenshot dock.png) ->
 *  Enter opens the full-screen reader (Wait+Screen /Proof Document/, a reader-only string — the shelf
 *  shows handles, never titles + Screenshot reader.png) -> esc back to the shelf -> esc to chat.
 *
 *  Video is EVIDENCE, never the assertion: the workspace-file assertions below (the artifact exists,
 *  the body is in the artifact file, the body is NOT in root's transcript) decide pass/fail.
 *
 *  NOTE on tape paths: VHS 0.11.0 cannot tokenize absolute paths in `Output`/`Screenshot` (a leading
 *  `/` breaks its lexer). So the tape writes RELATIVE filenames and vhs is run with cwd = the temp
 *  workspace; the wrapper (`scripts/e2e-evidence.ts`) copies session.mp4 / *.png out of the workspace
 *  into `evidence/artifact-browser/` afterwards.
 *  NOTE on Height: the reader needs vertical room for the markdown body — `Set Height 1000` gives
 *  room, matching the trace-inspector scenario's fix for Ink vertical clipping under VHS.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AssertionResult, Scenario } from "./types";

/** The second user prompt — asserted verbatim in the ledger. */
const SECOND_PROMPT = "use the proof worker to save a proof document";
/** The artifact id the child saves. */
const ARTIFACT_ID = "proof-doc";
/** A distinctive line from the artifact body — must be in the artifact file, NOT in root's transcript. */
const BODY_MARKER = "This document proves the artifact viewer renders markdown bodies correctly";  // (marker text is baked into the artifact-viewer e2e model mode)

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
  artifacts: string[];
  outputArtifacts?: string[];
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
  name: "artifact-browser",
  e2eModelMode: "artifact-viewer",  // the model mode predates the browser and stays — the tape is what changed

  // Artifacts this tape writes (relative filenames — the wrapper copies them out of the temp ws into
  // evidence/artifact-browser/ and records them in the manifest). dock.png shows the self-docked
  // shelf over the chat; reader.png shows the full-screen reader. Keep in sync with the tape.
  video: "session.mp4",
  screenshots: ["approval-card.png", "dock.png", "reader.png", "annotate.png", "final.png"],

  // Every load-bearing wait gates Enter/Screenshot on stable on-screen text (Wait+Screen), never a
  // fixed Sleep — the SLOW is in the e2e MODEL (the ~4s child hold), not the tape.
  tape: ({ binary }) => `Output session.mp4
Set FontSize 16
Set Width 1200
Set Height 1000
Set TypingSpeed 40ms
Type "TAICHO_E2E_MODEL=artifact-viewer ${binary}"
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
Wait+Screen@10s /use the proof worker to save a proof document/
Enter
Wait+Screen@30s /ARTIFACTS/
Sleep 700ms
Screenshot dock.png
Enter
Wait+Screen@15s /Proof Document/
Sleep 700ms
Screenshot reader.png
Type "a"
Wait+Screen@10s /feedback/
Type "add a cost table"
Sleep 300ms
Enter
Wait+Screen@10s /feedback on proof-doc/
Sleep 500ms
Screenshot annotate.png
Escape
Sleep 500ms
Wait+Screen@10s /ARTIFACTS/
Escape
Sleep 500ms
Wait+Screen@10s /message root/
Sleep 500ms
Screenshot final.png
Sleep 1s
Escape
Sleep 500ms
`,

  // The artifact-viewer assertion set: proves the artifact exists, the body is in the artifact file,
  // and the body is NOT in root's transcript (the viewer is the read surface, not scrollback).
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
      "artifact exists in store",
      `artifacts/${ARTIFACT_ID}/v1.json exists`,
      () => {
        const exists = existsSync(join(ws, "artifacts", ARTIFACT_ID, "v1.json"));
        return { pass: exists, actual: exists ? "exists" : "<file missing>" };
      },
    ),
    check(
      "artifact body file has the body marker",
      `artifacts/${ARTIFACT_ID}/v1.md contains "${BODY_MARKER}"`,
      () => {
        const body = readFileSync(join(ws, "artifacts", ARTIFACT_ID, "v1.md"), "utf8");
        return { pass: body.includes(BODY_MARKER), actual: body.includes(BODY_MARKER) ? "contains marker" : "<marker missing>" };
      },
    ),
    check(
      "root transcript does NOT contain the body marker",
      `root transcript does NOT contain "${BODY_MARKER}" (the viewer is the read surface)`,
      () => {
        const { name } = secondRootRun(ws);
        const transcript = readFileSync(join(ws, "runs", "root", name, "transcript.jsonl"), "utf8");
        return { pass: !transcript.includes(BODY_MARKER), actual: transcript.includes(BODY_MARKER) ? "<body leaked into transcript>" : "body not in transcript" };
      },
    ),
    check(
      "the reader's `a` verb landed OPEN feedback on the viewed version",
      `artifacts/${ARTIFACT_ID}/annotations.jsonl contains the typed feedback`,
      () => {
        const f = join(ws, "artifacts", ARTIFACT_ID, "annotations.jsonl");
        if (!existsSync(f)) return { pass: false, actual: "<no annotations file>" };
        const log = readFileSync(f, "utf8");
        const pass = log.includes("add a cost table") && log.includes('"kind":"feedback"');
        return { pass, actual: pass ? "feedback annotation present" : "<feedback missing>" };
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
