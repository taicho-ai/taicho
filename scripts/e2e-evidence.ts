/** Layer 4 — evidence-grade E2E harness (Plan 11).
 *
 *  `bun scripts/e2e-evidence.ts <scenario>`:
 *    1. build dist/taicho (the binary under test)
 *    2. create a FRESH temp workspace (NEVER the repo root — that is the live dev workspace)
 *    3. write the scenario's VHS tape into the workspace and run `vhs` with cwd = workspace,
 *       so the binary boots with the temp ws as its workspace and no user data is touched
 *    4. copy the produced session.mp4 + screenshots out of the workspace into evidence/<scenario>/
 *    5. run the scenario's file assertions against that same workspace
 *    6. write evidence/<scenario>/manifest.json (video + screenshots + assertion results with
 *       expected/actual, workspace pointer, git SHA, timestamp) — the deliverable
 *    7. exit non-zero on any failure
 *
 *  The video is EVIDENCE, not the assertion: pass/fail comes only from the workspace-file
 *  assertions. Requires `vhs` on PATH (a system binary — brew install vhs). VHS spawns a local
 *  ttyd server, so a sandbox that blocks localhost listening must be disabled for this command.
 *
 *  VHS-path gotcha: VHS 0.11.0 cannot parse absolute paths in Output/Screenshot. The tape uses
 *  RELATIVE filenames (they land in the temp ws next to the binary's data); we copy them into
 *  evidence/<scenario>/ here. See e2e/scenarios/<name>.ts for the tape.
 */
import { mkdtemp, mkdir, writeFile, copyFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Scenario } from "../e2e/scenarios/types";

const scenarioName = process.argv[2];
if (!scenarioName) {
  console.error("usage: bun scripts/e2e-evidence.ts <scenario>");
  process.exit(2);
}

const { default: scenario } = (await import(`../e2e/scenarios/${scenarioName}.ts`)) as { default: Scenario };

const repo = resolve(import.meta.dir, "..");
const binary = join(repo, "dist", "taicho");
const evidenceDir = join(repo, "evidence", scenario.name);
await mkdir(evidenceDir, { recursive: true });

// 1. build the binary under test
console.log("building dist/taicho …");
let p = Bun.spawnSync(["bun", "run", "build"], { cwd: repo, stdout: "inherit", stderr: "inherit" });
if (p.exitCode !== 0) {
  console.error("build failed");
  process.exit(1);
}

// 1b. warm the freshly-built binary. `bun run build` rewrites a ~66MB compiled binary, and
//     macOS runs first-exec code-sign verification + builds the dyld closure on the FIRST exec
//     of that new file — a cold, sluggish exec during which the booting app drops the submit
//     keystroke (empirically ~5/6 flake without this; 0/10 with a warm binary). Any completed
//     exec primes the OS's cached validation for the file, so vhs's exec is then fast.
{
  const warmWs = await mkdtemp(join(tmpdir(), "taicho-warm-"));
  await writeFile(join(warmWs, "taicho.yaml"), "mcp:\n  enabled: false\nauth:\n  chatgpt_signin: false\n");
  console.log("warming the binary …");
  Bun.spawnSync([binary], {
    cwd: warmWs,
    env: { ...process.env, TAICHO_E2E_MODEL: scenario.e2eModelMode },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: 5000,
  });
}

// 2. fresh temp workspace — NEVER the repo root (live dev workspace)
const ws = await mkdtemp(join(tmpdir(), "taicho-evidence-"));
// Mirror e2e/agent-flow.tui.ts's ws setup: disable MCP (or boot may hang) + chatgpt sign-in.
// With TAICHO_E2E_MODEL set the binary bypasses resolveAuth, so no API key is needed.
await writeFile(join(ws, "taicho.yaml"), "mcp:\n  enabled: false\nauth:\n  chatgpt_signin: false\n");

// 3. write the tape into the workspace (RELATIVE output paths → land in ws; copied out below)
const tapePath = join(ws, `${scenario.name}.tape`);
const tapeSource = scenario.tape({ binary, evidenceDir });
await writeFile(tapePath, tapeSource);
// keep a copy of the tape with the evidence for reproducibility
await writeFile(join(evidenceDir, `${scenario.name}.tape`), tapeSource);

// 4. run vhs with cwd = workspace, so the binary boots with the temp ws as its workspace.
//    TAICHO_E2E_MODEL is passed via env AND typed on the binary's command line in the tape.
console.log(`recording with vhs (cwd=${ws}) …`);
p = Bun.spawnSync(["vhs", tapePath], {
  cwd: ws,
  env: { ...process.env, TAICHO_E2E_MODEL: scenario.e2eModelMode },
  stdout: "inherit",
  stderr: "inherit",
});
const vhsOk = p.exitCode === 0;

// copy the recorded artifacts out of the workspace into evidence/<scenario>/
// (scenario-declared, not hardcoded — each scenario lists its own video + screenshots)
const outputs = [scenario.video, ...scenario.screenshots];
for (const f of outputs) {
  try {
    await access(join(ws, f));
    await copyFile(join(ws, f), join(evidenceDir, f));
  } catch {
    console.warn(`warning: ${f} not produced by vhs (workspace: ${ws})`);
  }
}

// 5. assertions decide pass/fail — the video never does
const assertions = await scenario.assertions(ws);
const allPass = vhsOk && assertions.every((a) => a.pass);

// 6. manifest = the proof deliverable
const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
await writeFile(
  join(evidenceDir, "manifest.json"),
  JSON.stringify(
    {
      scenario: scenario.name,
      pass: allPass,
      vhsExitOk: vhsOk,
      video: join(evidenceDir, scenario.video),
      screenshots: scenario.screenshots.map((f) => join(evidenceDir, f)),
      tape: join(evidenceDir, `${scenario.name}.tape`),
      workspace: ws,
      gitSha: sha,
      ranAt: new Date().toISOString(),
      assertions,
    },
    null,
    2,
  ),
);

console.log(`\n${allPass ? "PASS" : "FAIL"} — evidence: ${join(evidenceDir, "manifest.json")}`);
if (!vhsOk) console.log(`  ✗ vhs exited non-zero (workspace kept for debugging: ${ws})`);
for (const a of assertions) {
  console.log(`  ${a.pass ? "✓" : "✗"} ${a.name}${a.pass ? "" : ` — expected ${a.expected}, got ${a.actual}`}`);
}
// Keep the temp workspace on failure — its path is in the manifest and it IS the debugging evidence.
process.exit(allPass ? 0 : 1);
