/** Scenario spec for the `live-waterfall` evidence run (Plan 02 Phase 6, Layer 4).
 *
 *  Proves the LIVE waterfall (`/view waterfall`): while a run executes, taicho streams spans into a
 *  redrawing span tree — the live counterpart to the post-hoc `/trace` inspector — in place of the
 *  panes/bar. It reuses the SLOW-MODE `squad-panes` e2e model (src/core/e2e-model.ts), which holds the
 *  child's model call in-flight ~4s. During that window the live waterfall shows the cascade as it
 *  runs: `root · chat` (the foreground run), its `delegate_task` tool span, and the nested
 *  `proof-agent · deleg` child run — all under the `WATERFALL (live)` header, with growing time bars.
 *  The header string is UNIQUE to the live waterfall (never in the scrollback `↳` breadcrumb), so the
 *  tape's `Wait+Screen /WATERFALL/` gate PROVES the live waterfall rendered before the screenshot.
 *
 *  Flow: boot dist/taicho with TAICHO_E2E_MODEL=squad-panes -> `/view waterfall` ->
 *  "create a proof worker agent" -> approve the New-agent card with `y` ->
 *  "use the proof worker to prove delegation works" -> root delegates (slow) -> the live waterfall
 *  redraws the cascade mid-run (Wait+Screen gate + waterfall.png) -> completes ("Root used proof-agent").
 *
 *  Video is EVIDENCE, never the assertion: the workspace-file assertions below (the delegation trace
 *  exists + the child completed, PLUS the derived span tree the same waterfall reads) decide pass/fail.
 *
 *  NOTE on tape paths / Height: same as squad-panes — RELATIVE Output/Screenshot filenames (VHS 0.11.0
 *  can't lex a leading `/`); `Set Height 1000` gives the tree + spinner vertical room so Ink doesn't
 *  clip the lower waterfall rows under VHS.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AssertionResult, Scenario } from "./types";
import { deriveTrace } from "../../src/core/trace-tree";

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

interface RunTraceLike { id: string; outcome: string; delegatedOut: string[] }

/** The second root run (by run number) + its parsed trace. Throws if it isn't there yet. */
function secondRootRun(ws: string): { name: string; trace: RunTraceLike } {
  const files = rootTraceFiles(ws).sort((a, b) => runNumber(a) - runNumber(b));
  const second = files.find((f) => runNumber(f) === 2) ?? files[1];
  if (!second) throw new Error(`expected a 2nd root run, found ${files.length}: [${files.join(", ")}]`);
  const name = second.replace(/\.json$/, "");
  const trace = JSON.parse(readFileSync(join(ws, "runs", "root", second), "utf8")) as RunTraceLike;
  return { name, trace };
}

function childRunName(ws: string): string {
  const { trace } = secondRootRun(ws);
  const id = (trace.delegatedOut ?? []).find((d) => d.startsWith("proof-agent/"));
  if (!id) throw new Error(`no proof-agent/ id in delegatedOut: [${(trace.delegatedOut ?? []).join(", ")}]`);
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
  name: "live-waterfall",
  e2eModelMode: "squad-panes", // reuse the slow-mode delegation model — the live waterfall reads it live

  video: "session.mp4",
  screenshots: ["approval-card.png", "waterfall.png", "final.png"],

  // The keystone gate is /WATERFALL/ (the live waterfall header) DURING the slow delegation — a string
  // that exists ONLY on the live waterfall surface, never in the scrollback breadcrumb. Every
  // load-bearing wait gates on stable on-screen text (Wait+Screen), never a fixed Sleep — the SLOW is
  // in the e2e MODEL (the ~4s child hold), not the tape.
  tape: ({ binary }) => `Output session.mp4
Set FontSize 16
Set Width 1200
Set Height 1000
Set TypingSpeed 40ms
Type "TAICHO_E2E_MODEL=squad-panes ${binary}"
Enter
Wait+Screen@15s /taicho/
Sleep 500ms
Type "/view waterfall"
Wait+Screen@10s /view waterfall/
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
Wait+Screen@20s /WATERFALL/
Wait+Screen@20s /delegate_task/
Sleep 700ms
Screenshot waterfall.png
Wait+Screen@20s /Root used proof-agent/
Sleep 700ms
Screenshot final.png
Sleep 1s
Escape
Sleep 500ms
`,

  // Delegation-proof assertion set (mirrors squad-panes) PLUS one Plan-02 assertion: the SAME
  // deriveTrace the waterfall renders from produces the delegation span tree over the produced ws.
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
        return { pass: files.length === 2 && trace.outcome === "completed", actual: `${files.length} traces; 2nd outcome=${trace.outcome}` };
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
        const child = JSON.parse(readFileSync(join(ws, "runs", "proof-agent", `${name}.json`), "utf8")) as RunTraceLike;
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
      "ledger has second prompt",
      `conversations/root/ledger.jsonl contains "${SECOND_PROMPT}"`,
      () => {
        const led = readFileSync(join(ws, "conversations", "root", "ledger.jsonl"), "utf8");
        return { pass: led.includes(SECOND_PROMPT), actual: led.includes(SECOND_PROMPT) ? "contains prompt" : "<prompt missing>" };
      },
    ),
    check(
      "deriveTrace yields the delegation span tree (the waterfall's reader)",
      "root run span + a delegate_task tool span + a nested proof-agent run span",
      () => {
        const { trace } = secondRootRun(ws);
        const spans = deriveTrace(ws, trace.id);
        const rootRun = spans.find((s) => s.kind === "run" && s.id === trace.id);
        const deleg = spans.find((s) => s.kind === "tool" && s.name === "delegate_task");
        const child = spans.find((s) => s.kind === "run" && s.id.startsWith("proof-agent/"));
        const nested = !!(child && deleg && child.parentId === deleg.id);
        return {
          pass: !!rootRun && !!deleg && !!child && nested,
          actual: `rootRun=${!!rootRun} delegSpan=${!!deleg} childRun=${!!child} childUnderDeleg=${nested}`,
        };
      },
    ),
  ],
};

export default scenario;
