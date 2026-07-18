/** Scenario spec for the `artifact-handoff` evidence run (Plan 01 Phase 6, Layer 4).
 *
 *  A scenario = a VHS tape (drives the compiled binary through a real user flow) + a set of
 *  workspace-file assertions (decide pass/fail; the video is evidence, never the assertion).
 *
 *  Flow: boot dist/taicho with TAICHO_E2E_MODEL=artifact-handoff ->
 *    1. "create a researcher agent"  -> approve the New-agent card with `y`   (agent A)
 *    2. "create a writer agent"      -> approve the New-agent card with `y`   (agent B)
 *    3. "have the researcher produce a dossier and the writer turn it into a brief, by reference"
 *       -> root delegates to researcher (A save_artifacts a dossier whose body carries a distinctive
 *          payload marker), then delegates to writer with inputArtifacts:[dossier@v1] — a HANDLE, not
 *          the body — and the writer read_artifacts it and save_artifacts a brief linked back.
 *
 *  The point this proves: A produces, B consumes BY REFERENCE, and the ORCHESTRATING PARENT's context
 *  stays thin — the dossier BODY payload never enters root's transcript. That last assertion is the
 *  heart of the plan (heavy content lives on disk as addressable artifacts, not in the context window).
 *
 *  NOTE on tape paths: VHS 0.11.0 cannot tokenize absolute paths in `Output`/`Screenshot` (a leading
 *  `/` breaks its lexer). The tape writes RELATIVE filenames and vhs runs with cwd = the temp
 *  workspace; the wrapper (`scripts/e2e-evidence.ts`) copies the outputs into `evidence/artifact-handoff/`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AssertionResult, Scenario } from "./types";
import { DOSSIER_PAYLOAD } from "@taicho/framework/core/e2e-model";

const THIRD_PROMPT = "have the researcher produce a dossier and the writer make a brief by reference";

// ── run-id discovery (run ids are date-stamped, e.g. 2026-07-04-run3 — never hardcode) ──

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
  outputArtifacts?: string[];
}

/** The hand-off root run (the 3rd, by run number) + its parsed trace. Throws if it isn't there yet. */
function handoffRootRun(ws: string): { name: string; trace: RunTraceLike } {
  const files = rootTraceFiles(ws).sort((a, b) => runNumber(a) - runNumber(b));
  const third = files.find((f) => runNumber(f) === 3) ?? files[2];
  if (!third) throw new Error(`expected a 3rd root run, found ${files.length}: [${files.join(", ")}]`);
  const name = third.replace(/\.json$/, "");
  const trace = JSON.parse(readFileSync(join(ws, "runs", "root", third), "utf8")) as RunTraceLike;
  return { name, trace };
}

function readArtifactEnvelope(ws: string, id: string, version: number): { producer: string; parents: string[]; location: { kind: string; path?: string } } {
  return JSON.parse(readFileSync(join(ws, "artifacts", id, `v${version}.json`), "utf8"));
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
  name: "artifact-handoff",
  e2eModelMode: "artifact-handoff",

  video: "session.mp4",
  screenshots: ["approval-card.png", "final.png"],

  // Each prompt submit gates Enter on the typed text being on screen (Wait+Screen, not a fixed Sleep)
  // — the same wait-for-render-before-Enter discipline the Layer-1/2 tests use to dodge the Ink
  // TextInput submit race (Enter firing before the last keystroke commits).
  tape: ({ binary }) => `Output session.mp4
Set FontSize 16
Set Width 1200
Set Height 700
Set TypingSpeed 40ms
Type "TAICHO_E2E_MODEL=artifact-handoff ${binary}"
Enter
Wait+Screen@15s /taicho/
Sleep 500ms
Type "create a researcher agent"
Wait+Screen@10s /create a researcher agent/
Enter
Wait+Screen@15s /New agent/
Sleep 700ms
Screenshot approval-card.png
Type "y"
Wait+Screen@15s /Created researcher/
Sleep 500ms
Type "create a writer agent"
Wait+Screen@10s /create a writer agent/
Enter
Wait+Screen@15s /New agent/
Sleep 700ms
Type "y"
Wait+Screen@15s /Created writer/
Sleep 500ms
Type "${THIRD_PROMPT}"
Wait+Screen@10s /by reference/
Enter
Wait+Screen@20s /brief@v1 from dossier@v1/
Sleep 700ms
Screenshot final.png
Sleep 1s
Escape
Sleep 500ms
`,

  // Eight assertions on the workspace files the binary produced; these — not the video — decide pass/fail.
  assertions: async (ws: string): Promise<AssertionResult[]> => [
    check("researcher (agent A) file created", "agents/researcher/agent.md exists", () => {
      const e = existsSync(join(ws, "agents", "researcher", "agent.md"));
      return { pass: e, actual: e ? "exists" : "<file missing>" };
    }),
    check("writer (agent B) file created", "agents/writer/agent.md exists", () => {
      const e = existsSync(join(ws, "agents", "writer", "agent.md"));
      return { pass: e, actual: e ? "exists" : "<file missing>" };
    }),
    check("hand-off root run completed", "exactly 3 root traces; 3rd outcome=completed", () => {
      const files = rootTraceFiles(ws);
      const { trace } = handoffRootRun(ws);
      return { pass: files.length === 3 && trace.outcome === "completed", actual: `${files.length} traces; 3rd outcome=${trace.outcome}` };
    }),
    check("root delegated to BOTH A and B", "delegatedOut has a researcher/ AND a writer/ id", () => {
      const { trace } = handoffRootRun(ws);
      const d = trace.delegatedOut ?? [];
      const hasA = d.some((x) => x.startsWith("researcher/"));
      const hasB = d.some((x) => x.startsWith("writer/"));
      return { pass: hasA && hasB, actual: `[${d.join(", ")}]` };
    }),
    check("A produced the dossier artifact", "artifacts/dossier/v1.json producer=researcher", () => {
      const env = readArtifactEnvelope(ws, "dossier", 1);
      return { pass: env.producer === "researcher", actual: `producer=${env.producer}` };
    }),
    check("B derived a brief FROM the dossier (lineage)", "artifacts/brief/v1.json producer=writer parents=[dossier@v1]", () => {
      const env = readArtifactEnvelope(ws, "brief", 1);
      const ok = env.producer === "writer" && JSON.stringify(env.parents) === JSON.stringify(["dossier@v1"]);
      return { pass: ok, actual: `producer=${env.producer} parents=${JSON.stringify(env.parents)}` };
    }),
    check("hand-off graph: handles flowed UP to root", "root outputArtifacts includes dossier@v1 AND brief@v1", () => {
      const { trace } = handoffRootRun(ws);
      const out = trace.outputArtifacts ?? [];
      const ok = out.includes("dossier@v1") && out.includes("brief@v1");
      return { pass: ok, actual: `[${out.join(", ")}]` };
    }),
    check(
      "PARENT STAYS THIN: the dossier BODY never entered root's context",
      `payload marker is in artifacts/dossier/v1.md but NOT in the root hand-off run's transcript/input`,
      () => {
        const bodyFile = join(ws, "artifacts", "dossier", "v1.md");
        const inBody = existsSync(bodyFile) && readFileSync(bodyFile, "utf8").includes(DOSSIER_PAYLOAD);
        const { name } = handoffRootRun(ws);
        const recordDir = join(ws, "runs", "root", name);
        const transcript = existsSync(join(recordDir, "transcript.jsonl")) ? readFileSync(join(recordDir, "transcript.jsonl"), "utf8") : "";
        const input = existsSync(join(recordDir, "input.json")) ? readFileSync(join(recordDir, "input.json"), "utf8") : "";
        const leakedToParent = transcript.includes(DOSSIER_PAYLOAD) || input.includes(DOSSIER_PAYLOAD);
        return {
          pass: inBody && !leakedToParent,
          actual: `body has marker=${inBody}; parent context leaked marker=${leakedToParent}`,
        };
      },
    ),
  ],
};

export default scenario;
