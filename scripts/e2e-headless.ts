/** Cheap headless real-binary e2e (Plan 03) — no VHS tape, just a scripted assertion.
 *
 *  Builds dist/taicho, then drives it via `taicho run` in a FRESH temp workspace (NEVER the repo
 *  root — that is the live dev workspace) with the deterministic agent-flow e2e model, and asserts
 *  the run produced a completed trace + a transcript event stream. This is the headless surface's
 *  payoff: proving the compiled binary end-to-end without a full-screen terminal recording.
 *
 *  Usage: bun scripts/e2e-headless.ts
 */
import { mkdtemp, writeFile, readFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const binary = join(repo, "dist", "taicho");

console.log("building dist/taicho …");
if (Bun.spawnSync(["bun", "run", "build"], { cwd: repo, stdout: "inherit", stderr: "inherit" }).exitCode !== 0) {
  console.error("build failed");
  process.exit(1);
}

const ws = await mkdtemp(join(tmpdir(), "taicho-headless-"));
await writeFile(join(ws, "taicho.yaml"), "mcp:\n  enabled: false\nauth:\n  chatgpt_signin: false\n");

console.log(`running headless (cwd=${ws}) …`);
const proc = Bun.spawnSync([binary, "run", "--approve", "auto", "prove the headless surface works"], {
  cwd: ws,
  env: { ...process.env, TAICHO_E2E_MODEL: "agent-flow" },
  stdout: "pipe",
  stderr: "inherit",
});
const stdout = proc.stdout.toString();
console.log(stdout);

// ── assertions (the video-free proof) ──
const results: { name: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail?: string) => results.push({ name, pass, detail });

check("run exited 0", proc.exitCode === 0, `exit=${proc.exitCode}`);
check("stdout reports completed", /taicho: completed/.test(stdout));

const rootRuns = await readdir(join(ws, "runs", "root")).catch(() => [] as string[]);
const traceFile = rootRuns.find((f) => f.endsWith(".json"));
check("a root trace was written", !!traceFile, traceFile ?? "(none)");

if (traceFile) {
  const trace = JSON.parse(await readFile(join(ws, "runs", "root", traceFile), "utf8"));
  check("trace outcome is completed", trace.outcome === "completed", trace.outcome);
  const record = traceFile.replace(/\.json$/, "");
  const transcriptPath = join(ws, "runs", "root", record, "transcript.jsonl");
  const hasTranscript = await access(transcriptPath).then(() => true).catch(() => false);
  check("transcript.jsonl exists", hasTranscript);
  if (hasTranscript) {
    const kinds = (await readFile(transcriptPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l).kind);
    check("transcript has a tool_call event", kinds.includes("tool_call"), kinds.join(","));
  }
}

const allPass = results.every((r) => r.pass);
console.log(`\n${allPass ? "PASS" : "FAIL"} — headless e2e (workspace: ${ws})`);
for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
process.exit(allPass ? 0 : 1);
