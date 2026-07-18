/** `taicho schedule <add|list|remove|run>` — manage durable schedules from the command line (no Ink).
 *  add/list/remove are pure store ops; `run` fires one schedule ONCE through the injected `fire` seam
 *  (the host wires it to the headless `executeRun` path). The parser is shared with the REPL's
 *  `/schedules` command (see `parseScheduleCommand` in scheduler.ts) so both surfaces agree. */
import type { Schedule } from "@taicho/contracts/schedule";
import { parseScheduleCommand, describeTrigger, formatScheduleLine } from "./scheduler";
import { createSchedule, listSchedules, removeSchedule, readSchedule } from "../store/schedules";

export interface ScheduleCliDeps {
  ws: string;
  out?: (line: string) => void;
  /** Fire one schedule once (only used by `run`). Undefined ⇒ `run` reports it can't fire here. */
  fire?: (schedule: Schedule) => Promise<{ ok: boolean; runId?: string; outcome?: string }>;
}

/** Execute a `taicho schedule …` command. Returns `{ ok }` so the caller can pick an exit code. */
export async function runScheduleCli(deps: ScheduleCliDeps, tokens: string[]): Promise<{ ok: boolean }> {
  const out = deps.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const cmd = parseScheduleCommand(tokens);

  if (cmd.kind === "error") { out(`taicho: ${cmd.message}`); return { ok: false }; }

  if (cmd.kind === "list") {
    const all = listSchedules(deps.ws);
    if (!all.length) { out("  (no schedules)"); return { ok: true }; }
    all.forEach((s) => out(formatScheduleLine(s)));
    return { ok: true };
  }

  if (cmd.kind === "add") {
    try {
      const s = createSchedule(deps.ws, cmd.spec);
      out(`  ⏰ added schedule ${s.id} → ${s.agent}: ${s.goal} (${describeTrigger(s.trigger)}, approvals: ${s.approve})`);
      return { ok: true };
    } catch (e) {
      out(`taicho: could not add schedule — ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false };
    }
  }

  if (cmd.kind === "remove") {
    const ok = removeSchedule(deps.ws, cmd.id);
    out(ok ? `  removed schedule ${cmd.id}` : `taicho: no schedule "${cmd.id}"`);
    return { ok };
  }

  // run — fire once through the headless path.
  const s = readSchedule(deps.ws, cmd.id);
  if (!s) { out(`taicho: no schedule "${cmd.id}"`); return { ok: false }; }
  if (!deps.fire) { out("taicho: cannot fire a schedule here (no model wired)"); return { ok: false }; }
  out(`  ⏰ firing schedule ${s.id} → ${s.agent}: ${s.goal} (approvals: ${s.approve})`);
  const res = await deps.fire(s);
  out(`  ${res.ok ? "✓" : "⚠"} schedule ${s.id} ${res.outcome ?? (res.ok ? "done" : "failed")}${res.runId ? ` — run ${res.runId}` : ""}`);
  return { ok: res.ok };
}
