/** Headless surface — drive `executeRun` WITHOUT Ink.
 *
 *  `RunDeps` is already the seam (model / approval / onStep are all injectable), so a headless run is
 *  just `makeDeps` + `executeRun` with a non-interactive approval channel and stdout instead of a
 *  React tree. This powers `taicho run "<goal>"` and `taicho tail`, and makes real-binary e2e cheap
 *  (a scripted assertion, no VHS tape).
 *
 *  APPROVAL CHANNEL (the one real design point). A headless run is unattended by definition — there
 *  is no captain watching an approval card. The DEFAULT is therefore **auto-reject**: the run
 *  proceeds, but every privileged action (create_agent, run_command, add_mcp, propose_skill,
 *  propose_coaching, ask_human) is declined and the model continues or reports it could not proceed.
 *  Rejecting is the safe default — auto-approving would let a model spawn agents or run shell
 *  commands with no human in the loop. Two opt-ins exist for trusted/interactive use:
 *    --approve auto  → approve everything (scripted, trusted flows only)
 *    --approve prompt → ask on stdin (y/N per request; free-text answer for ask_human)
 *  All three are deterministic and never touch the network beyond the model call itself. */
import type { Database } from "bun:sqlite";
import { createInterface } from "node:readline";
import { makeDeps, executeRun, type Model, type RunDeps, type ApprovalRequest, type ApprovalDecision } from "./run";
import { loadAgent } from "../store/roster";
import { tailRun } from "./events";
import { log } from "./logger";

export type ApprovalMode = "reject" | "approve" | "prompt";

export type CliCommand =
  | { kind: "run"; goal: string; agent: string; approve: ApprovalMode }
  | { kind: "tail"; runId?: string; follow: boolean };

export interface ParsedCli {
  /** `--verbose`/`-v` anywhere on the line → raise the log level to debug. */
  verbose: boolean;
  /** null ⇒ no subcommand ⇒ launch the interactive Ink REPL. */
  command: CliCommand | null;
}

function normalizeApprove(v: string | undefined): ApprovalMode {
  if (v === "approve" || v === "auto" || v === "yes" || v === "y") return "approve";
  if (v === "prompt" || v === "ask" || v === "stdin") return "prompt";
  return "reject";
}

/** Parse raw `process.argv` into a CLI command. Scans for the first bare `run`/`tail` token (position
 *  > 0 so the executable path is never mistaken for a command); everything before it is the
 *  interpreter/executable path, everything after is the command's args. No subcommand ⇒ REPL. */
export function parseCli(argv: string[]): ParsedCli {
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  const cmdIdx = argv.findIndex((a, i) => i > 0 && (a === "run" || a === "tail"));
  if (cmdIdx < 0) return { verbose, command: null };

  const cmd = argv[cmdIdx];
  const rest = argv.slice(cmdIdx + 1).filter((a) => a !== "--verbose" && a !== "-v");

  if (cmd === "run") {
    let agent = "root";
    let approve: ApprovalMode = "reject";
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--agent" || a === "-a") agent = rest[++i] ?? agent;
      else if (a.startsWith("--agent=")) agent = a.slice("--agent=".length);
      else if (a === "--approve") approve = normalizeApprove(rest[++i]);
      else if (a.startsWith("--approve=")) approve = normalizeApprove(a.slice("--approve=".length));
      else if (a === "--yes" || a === "-y") approve = "approve";
      else positional.push(a);
    }
    return { verbose, command: { kind: "run", goal: positional.join(" ").trim(), agent, approve } };
  }

  // tail
  let follow = false;
  const positional: string[] = [];
  for (const a of rest) {
    if (a === "--follow" || a === "-f") follow = true;
    else positional.push(a);
  }
  return { verbose, command: { kind: "tail", runId: positional[0], follow } };
}

/** Build the non-interactive approval channel for a headless run. */
export function makeApprovalChannel(
  mode: ApprovalMode,
  io?: { input?: NodeJS.ReadableStream; out?: (line: string) => void },
): (req: ApprovalRequest) => Promise<ApprovalDecision> {
  if (mode === "reject") return async () => ({ type: "reject" });

  if (mode === "approve") {
    return async (req) =>
      req.kind === "ask_human"
        ? { type: "answered", answer: req.options[0] ?? "yes" } // no human to ask; take the first offered option
        : { type: "approve" };
  }

  // prompt: one line of stdin per request. On EOF / no TTY, degrade to reject (never hang unattended).
  // `rl` is created once and reused across requests. A readline interface can't be reopened after its
  // input hits EOF (which fires 'close'), so once closed every subsequent `ask` must short-circuit to
  // "" (→ reject) rather than call `rl.question` on a closed interface — that throws ERR_USE_AFTER_CLOSE
  // and would turn the documented "degrade to reject" into a headless crash on the 2nd+ request.
  const out = io?.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const rl = createInterface({ input: io?.input ?? process.stdin });
  let closed = false;
  rl.once("close", () => { closed = true; });
  const ask = (q: string) => new Promise<string>((resolve) => {
    if (closed) { resolve(""); return; } // already EOF'd → degrade to reject; don't touch the closed rl
    let settled = false;
    const done = (v: string) => { if (!settled) { settled = true; resolve(v); } };
    rl.question(q, done);
    rl.once("close", () => done(""));
  });
  return async (req) => {
    if (req.kind === "ask_human") {
      out(`? ${req.question}${req.options.length ? ` [${req.options.join(" / ")}]` : ""}`);
      const answer = (await ask("> ")).trim();
      return answer ? { type: "answered", answer } : { type: "reject" };
    }
    out(`? approve ${req.kind}${describe(req)}`);
    const yn = (await ask("[y/N] ")).trim().toLowerCase();
    return yn === "y" || yn === "yes" ? { type: "approve" } : { type: "reject" };
  };
}

function describe(req: ApprovalRequest): string {
  switch (req.kind) {
    case "create_agent": return `: ${req.draft.id ?? "(new agent)"}`;
    case "run_command": return `: ${req.command}${req.cwd ? ` [cwd: ${req.cwd}]` : ""}`;
    case "add_mcp": return `: ${req.name}`;
    case "propose_skill": return `: ${req.draft.name}`;
    default: return "";
  }
}

export interface HeadlessDeps {
  ws: string;
  db: Database;
  model: Model | null;
  resolveModel?: RunDeps["resolveModel"];
  priceUsd?: RunDeps["priceUsd"];
  configDefaults?: RunDeps["configDefaults"];
  mcp?: RunDeps["mcp"];
  embed?: RunDeps["embed"];
  deckLedger?: RunDeps["deckLedger"]; // Plan 09: deck-wide ceilings enforced in the loop
}

export interface HeadlessResult {
  ok: boolean;
  runId?: string;
  text: string;
  outcome?: string;
  tokens?: number;
  costUsd?: number | null;
}

/** Drive one run to completion without Ink. Prints breadcrumbs + the final text to `out`, mirrors
 *  everything to `taicho.log`, and returns a structured result the caller uses to pick an exit code. */
export async function runHeadless(
  hd: HeadlessDeps,
  opts: {
    goal: string;
    agent?: string;
    approve?: ApprovalMode;
    out?: (line: string) => void;
    signal?: AbortSignal;
    input?: NodeJS.ReadableStream;
  },
): Promise<HeadlessResult> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const agentId = opts.agent ?? "root";

  if (!opts.goal.trim()) {
    out('taicho: run needs a goal — taicho run "<goal>"');
    return { ok: false, text: "" };
  }
  if (!hd.model) {
    out("taicho: no credentials — set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, or run /login openai in the REPL.");
    return { ok: false, text: "" };
  }

  const agent = await loadAgent(hd.ws, agentId).catch(() => null);
  if (!agent) {
    out(`taicho: no agent "${agentId}".`);
    return { ok: false, text: "" };
  }

  const approve = opts.approve ?? "reject";
  log.info(`headless run start`, { agent: agentId, approve, goal: opts.goal });
  out(`taicho: ${agentId} · ${opts.goal}  (approvals: ${approve})`);

  const deps = makeDeps({
    ws: hd.ws,
    db: hd.db,
    model: hd.model,
    requestApproval: makeApprovalChannel(approve, { input: opts.input, out }),
    onStep: ({ tool, agent: a, note }) => {
      // No Ink to fight: breadcrumbs go to stdout AND the log. Streamed token deltas are logged at
      // debug only (they'd spam a headless stdout).
      if (note) { out(`  ${note}`); log.info(`step note`, { agent: a, note }); return; }
      if (tool) { out(`  ↳ ${a} → ${tool}()`); log.debug(`tool`, { agent: a, tool }); }
    },
    resolveModel: hd.resolveModel,
    priceUsd: hd.priceUsd,
    configDefaults: hd.configDefaults,
    mcp: hd.mcp,
    embed: hd.embed,
    deckLedger: hd.deckLedger,
    signal: opts.signal,
  });

  const res = await executeRun(deps, {
    agent,
    messages: [{ role: "user", content: opts.goal }],
    triggeredBy: "user",
  });

  const { outcome, tokens, costUsd } = res.trace;
  out("");
  out(res.text);
  out("");
  out(`taicho: ${outcome} · run ${res.runId} · ${tokens} tok · ${costUsd == null ? "subscription" : "$" + costUsd.toFixed(4)}`);
  log.info(`headless run done`, { runId: res.runId, outcome, tokens });

  return { ok: outcome === "completed", runId: res.runId, text: res.text, outcome, tokens, costUsd };
}

/** `taicho tail [runId] [--follow]` — stream a run's events (latest run when no id). */
export async function runTail(
  ws: string,
  cmd: { runId?: string; follow: boolean },
  opts?: { out?: (line: string) => void; signal?: AbortSignal },
): Promise<void> {
  await tailRun({ ws, runId: cmd.runId, follow: cmd.follow, out: opts?.out, signal: opts?.signal });
}
