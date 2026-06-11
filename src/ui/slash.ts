/** Pure REPL slash-command dispatch. Returns lines to print; no I/O of its own (store fns injected). */
import type { RegistryRow } from "../store/roster";
import type { RunTrace } from "../schemas/trace";
import type { PolicyNote } from "../schemas/policy";

export type Line = { kind: "user" | "agent" | "system"; from?: string; text: string };

export interface SlashDeps {
  roster: RegistryRow[];
  listTraces: (agentId?: string) => RunTrace[];
  readTrace: (id: string) => RunTrace;
  listPolicies: (agentId: string) => PolicyNote[];
  deletePolicy: (agentId: string, polId: string) => boolean;
}

const sys = (text: string): Line => ({ kind: "system", text });

export function runSlash(cmd: string, arg: string, deps: SlashDeps): Line[] {
  if (cmd === "help")
    return [sys("commands: @<agent> <task> · /agents · /runs [agent] · /trace <id> · /teach <agent> <correction> · /policies <agent> · /forget <agent> <id> · /help · (ESC to quit)")];
  if (cmd === "agents")
    return deps.roster.map((r) => sys(`  ${r.is_root ? "*" : "-"} ${r.id}: ${r.role}`));
  if (cmd === "runs") {
    const traces = deps.listTraces(arg || undefined);
    if (!traces.length) return [sys("  (no runs yet)")];
    return traces.map((t) => sys(`  ${t.id}  ${t.outcome}  ${t.tokens}tok`));
  }
  if (cmd === "trace") {
    try {
      const t = deps.readTrace(arg);
      const cost = t.costUsd == null ? "subscription" : `$${t.costUsd.toFixed(4)}`;
      return [sys(`  ${t.id} — ${t.task}\n  outcome=${t.outcome} tokens=${t.tokens} cost=${cost} tools=${t.toolCalls.map((c) => `${c.tool}×${c.count}`).join(",")}\n  artifacts: ${t.artifacts.join(", ") || "none"}`)];
    } catch {
      return [sys(`  no such trace: ${arg}`)];
    }
  }
  if (cmd === "policies") {
    const notes = deps.listPolicies(arg);
    if (!notes.length) return [sys("  (no policies)")];
    return notes.map((n) => sys(`  [${n.id}] (${n.status}) WHEN ${n.when}: ${n.do}`));
  }
  if (cmd === "forget") {
    const [agentId, polId] = arg.split(/\s+/);
    if (!agentId || !polId) return [sys("  usage: /forget <agentId> <pol_id>")];
    return [sys(deps.deletePolicy(agentId, polId) ? `  forgot ${polId}` : `  no such policy: ${polId}`)];
  }
  return [sys(`  unknown command: /${cmd}`)];
}
