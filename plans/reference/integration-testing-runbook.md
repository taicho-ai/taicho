# Runbook — Integration Testing (Plan 11 executor guide)

This is the **hand-off document for executing Plan 11** (evidence-grade E2E). It assumes a
competent but context-free agent: everything needed is spelled out — exact commands, full file
skeletons, assertion specs, and failure modes. Design rationale lives in
[`e2e-evidence.md`](e2e-evidence.md); do not re-litigate decisions here, just build.

**Definition of done for the whole plan:** `bun scripts/e2e-evidence.ts agent-flow` exits 0 and
produces `evidence/agent-flow/` containing a watchable `session.mp4`, two `.png` screenshots, and
a `manifest.json` whose `assertions[]` are all `pass: true` — on a machine with `vhs` installed.

---

## 0. Ground rules (non-negotiable)

1. **NEVER run the binary against the repo root as workspace.** `bun run dev` makes the repo root
   the user's LIVE workspace — `agents/`, `kb/`, `skills/`, `runs/`, `artifacts/`, `taicho.db*`
   there are real user data. Every evidence run gets a **fresh temp workspace** (`mkdtemp`).
   Never delete or overwrite those directories in the repo root.
2. **Never `bun add`.** It re-resolves the tree and hits a broken upstream publish. Edit
   `package.json` by hand, keep the `overrides` block intact, run `bun install`.
   (This plan should need no new npm deps anyway — VHS is a system binary.)
3. **Before claiming any phase done:** `bun run typecheck` and `bun test` green, plus this
   plan's own verification checklist (§7).
4. **Video is evidence, not assertion.** Pass/fail comes from workspace-file assertions only.
   Never mark a scenario passing because the video "looks right".

## 1. Prerequisites

```bash
brew install vhs        # pulls ttyd; ffmpeg is already installed on this machine
vhs --version           # verify — any 0.7+ has Wait+Screen
bun run build           # produces dist/taicho (the binary under test)
```

If `brew install vhs` fails, STOP and report — do not improvise an asciinema fallback without
the captain's go-ahead (it's a recorded fallback in `e2e-evidence.md` §4, but it changes the
harness shape).

## 2. Map of what already exists (read these first)

| Path | What it is |
|---|---|
| `src/core/e2e-model.ts` | Deterministic scripted model. `TAICHO_E2E_MODEL=agent-flow` in the env makes the compiled binary use it — no network, no tokens. The `agent-flow` mode scripts: create_agent → "Created proof-agent." → delegate_task → final text. |
| `e2e/agent-flow.tui.ts` | Existing tui-test with the **assertion list to port** (workspace file checks). |
| `e2e/record-agent-flow.expect` | The old recorder this plan **replaces** (delete in Phase 2, only after the tape passes). |
| `CLI_TESTING.md` | The old doc; **rewrite in Phase 4** around the new harness. |
| `TESTING.md` | The 3-layer doc; this plan adds Layer 4 to its table. |

Workspace layout the binary produces (what assertions read):
`agents/<id>/agent.md` · `runs/<agent>/<runId>.json` (trace) · `runs/<agent>/<runId>/`
(`input.json`, `transcript.jsonl`, `final.md`, `child-runs.json`) ·
`conversations/root/ledger.jsonl`.

**Gotcha — run ids embed the date** (e.g. `2026-07-03-run2`). Never hardcode them; discover:
trace files are the `.json` files directly under `runs/<agent>/` — sort and pick, or filter by
`triggeredBy`/`task` fields.

## 3. Phase 1 — the harness

### 3a. Layout to create

```
e2e/
  scenarios/
    agent-flow.ts          # scenario spec: tape source + assertions (Phase 2)
  tapes/                   # (generated tapes land in the temp ws, not here — see 3c)
scripts/
  e2e-evidence.ts          # the wrapper (this section)
evidence/                  # output; gitignore it
```

Add `evidence/` to `.gitignore`.

### 3b. Scenario spec contract

One file per scenario under `e2e/scenarios/`, exporting:

```ts
export interface Scenario {
  name: string;                       // "agent-flow"
  e2eModelMode: string;               // value for TAICHO_E2E_MODEL
  tape: (p: { binary: string; evidenceDir: string }) => string;  // full .tape source
  assertions: (ws: string) => Promise<AssertionResult[]>;
}
export interface AssertionResult { name: string; pass: boolean; expected: string; actual: string }
```

Assertions must **catch their own errors** (missing file ⇒ `pass:false, actual:"<file missing>"`),
so one failure never hides the rest.

### 3c. The wrapper — `scripts/e2e-evidence.ts`

Behavior (skeleton below): build → temp ws → generate tape → run vhs → assert → manifest → exit.

```ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scenarioName = process.argv[2];
if (!scenarioName) { console.error("usage: bun scripts/e2e-evidence.ts <scenario>"); process.exit(2); }
const { default: scenario } = await import(`../e2e/scenarios/${scenarioName}.ts`);

const repo = resolve(import.meta.dir, "..");
const binary = join(repo, "dist", "taicho");
const evidenceDir = join(repo, "evidence", scenario.name);
await mkdir(evidenceDir, { recursive: true });

// 1. build the binary under test
let p = Bun.spawnSync(["bun", "run", "build"], { cwd: repo });
if (p.exitCode !== 0) { console.error("build failed"); process.exit(1); }

// 2. fresh temp workspace — NEVER the repo root (live dev workspace)
const ws = await mkdtemp(join(tmpdir(), "taicho-evidence-"));

// 3. write the tape INTO the workspace (vhs output paths are absolute → land in evidenceDir)
const tapePath = join(ws, `${scenario.name}.tape`);
await writeFile(tapePath, scenario.tape({ binary, evidenceDir }));

// 4. run vhs with cwd = workspace, so the binary boots with the temp ws as its workspace
p = Bun.spawnSync(["vhs", tapePath], {
  cwd: ws,
  env: { ...process.env, TAICHO_E2E_MODEL: scenario.e2eModelMode },
  stdout: "inherit", stderr: "inherit",
});
const vhsOk = p.exitCode === 0;

// 5. assertions decide pass/fail — the video never does
const assertions = await scenario.assertions(ws);
const allPass = vhsOk && assertions.every((a) => a.pass);

// 6. manifest = the proof deliverable
const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
await writeFile(join(evidenceDir, "manifest.json"), JSON.stringify({
  scenario: scenario.name, pass: allPass, vhsExitOk: vhsOk,
  video: join(evidenceDir, "session.mp4"),
  screenshots: ["approval-card.png", "final.png"].map((f) => join(evidenceDir, f)),
  workspace: ws, gitSha: sha, ranAt: new Date().toISOString(),
  assertions,
}, null, 2));

console.log(`${allPass ? "PASS" : "FAIL"} — evidence: ${evidenceDir}/manifest.json`);
for (const a of assertions) console.log(` ${a.pass ? "✓" : "✗"} ${a.name}${a.pass ? "" : ` — expected ${a.expected}, got ${a.actual}`}`);
process.exit(allPass ? 0 : 1);
```

Notes for the implementer:
- `import.meta.dir` is Bun-specific — fine, this repo is Bun-only.
- Keep the temp workspace around on failure (its path is in the manifest) — it *is* the debugging
  evidence. Do not auto-delete.
- `Env` inside the tape does NOT reach the ttyd shell reliably across vhs versions — pass
  `TAICHO_E2E_MODEL` via the wrapper's `env` (as above) **and** set it in the tape's typed command
  line for belt-and-braces (see the tape in §4).

## 4. Phase 2 — the agent-flow scenario

### 4a. Tape source (returned by `scenario.tape(...)`)

```tape
Output ${evidenceDir}/session.mp4
Set FontSize 16
Set Width 1200
Set Height 700
Set TypingSpeed 40ms
Type "TAICHO_E2E_MODEL=agent-flow ${binary}"
Enter
Wait+Screen@15s /taicho/
Sleep 500ms
Type "create a proof worker agent"
Enter
Wait+Screen@15s /New agent/
Screenshot ${evidenceDir}/approval-card.png
Type "y"
Wait+Screen@15s /Created proof-agent/
Sleep 500ms
Type "use the proof worker to prove delegation works"
Enter
Wait+Screen@20s /Root used proof-agent/
Screenshot ${evidenceDir}/final.png
Sleep 1s
Escape
Sleep 500ms
```

(Template-string the two `${…}` placeholders in the `tape()` function. Waits are gated on screen
text — never add fixed sleeps to "fix" a race; raise the `@timeout` or fix the regex instead. The
regexes mirror the waits the old expect script used, which are known-stable strings.)

### 4b. Assertion set (port of `e2e/agent-flow.tui.ts` / old CLI_TESTING.md list)

Implement each as an `AssertionResult`; discover run ids dynamically (§2 gotcha):

1. `agents/proof-agent/agent.md` exists.
2. Exactly 2 root traces under `runs/root/*.json`; the **second** (by run number) has
   `outcome === "completed"`.
3. That trace's `delegatedOut[0]` starts with `proof-agent/`.
4. The child trace `runs/proof-agent/<delegatedOut[0] minus prefix>.json` has
   `outcome === "completed"`.
5. Child `runs/proof-agent/<runId>/final.md` contains `proof-agent completed delegated work`.
6. Root run's companion dir contains `child-runs.json` with one entry.
7. `conversations/root/ledger.jsonl` contains the second user prompt
   (`use the proof worker to prove delegation works`).

### 4c. Cleanup (only after the tape passes twice in a row)

- Delete `e2e/record-agent-flow.expect`.
- Remove the rendered-MP4 flow references from `CLI_TESTING.md` (full rewrite is Phase 4).
- Keep `e2e/agent-flow.tui.ts` (Layer 2 still owns CI smoke).

## 5. Phase 3 — conversation-audit scenario

Same pattern: read `e2e/conversation-audit.tui.ts` for the flow (interrupted chat turn preserved
as audit evidence) and its assertions; check whether `e2e-model.ts` already has a mode for it —
if not, add one following the `agent-flow` shape (scripted `doGenerate` sequence). Tape drives:
chat turn → Esc mid-run → assert ledger/audit files record the interrupted turn.

## 6. Phase 4 — docs

- `TESTING.md`: add Layer 4 to the table (`bun scripts/e2e-evidence.ts <scenario>` · "real user
  flows through the real binary, with watchable video proof" · needs `vhs`).
- Rewrite `CLI_TESTING.md` around the new harness (keep its "what this layer must prove" list —
  it is the assertion contract). Note the manifest as the deliverable.
- `CLAUDE.md`: one line under testing pointing at the evidence harness.

## 7. Verification checklist (run before claiming done)

```bash
bun run typecheck && bun test              # untouched suites still green
bun scripts/e2e-evidence.ts agent-flow     # exits 0
open evidence/agent-flow/session.mp4       # WATCH IT — boot, approval card, y, delegation, final
cat evidence/agent-flow/manifest.json      # all assertions pass:true; workspace path present
bun scripts/e2e-evidence.ts agent-flow     # run TWICE — must pass back-to-back (flake check)
```

Also verify the negative path once: temporarily flip one assertion's expectation, confirm the
wrapper exits 1 and the manifest records `pass:false` with expected/actual — then flip it back.

## 8. Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `vhs: command not found` / ttyd errors | tooling not installed | §1; STOP and report if brew fails |
| Wait+Screen times out at boot | binary crashed in the temp ws — boot failures print `taicho: …` and exit | run `TAICHO_E2E_MODEL=agent-flow <binary>` manually in a scratch dir; read the line |
| Wait+Screen times out mid-flow | regex doesn't match rendered text (markdown styling can split lines) | check the screenshot/video of the failed run; loosen the regex to a stable substring |
| Binary uses real provider instead of e2e model | `TAICHO_E2E_MODEL` didn't reach the process | it's set in BOTH the wrapper env and the typed command line — check the tape actually typed it |
| Assertions can't find run files | hardcoded run id (date-stamped) | discover dynamically (§2 gotcha) |
| Repo root suddenly has new agents/runs | vhs ran with wrong cwd — **this is the disaster case** | wrapper must pass `cwd: ws` to vhs; verify before first run; if it happened, `git status` the repo root and tell the captain — do NOT delete anything |
| Flaky pass/fail across runs | a fixed `Sleep` doing load-bearing work | replace with `Wait+Screen`; sleeps are for visual pacing only |
