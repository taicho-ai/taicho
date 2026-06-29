/** Pure REPL slash-command dispatch. Returns lines to print; no I/O of its own (store fns injected). */
import type { RegistryRow } from "../store/roster";
import type { RunTrace } from "../schemas/trace";
import type { PolicyNote } from "../schemas/policy";

export type Line = { kind: "user" | "agent" | "system"; from?: string; text: string };

export interface SlashCommand { name: string; summary: string; usage?: string; requiresArg?: boolean; }

/** Single source of truth for slash commands — drives both /help and the live suggester. */
export const COMMANDS: SlashCommand[] = [
  { name: "help", summary: "list commands" },
  { name: "agents", summary: "list the squad" },
  { name: "runs", summary: "list runs", usage: "[agent]" },
  { name: "trace", summary: "show a run", usage: "<id>", requiresArg: true },
  { name: "teach", summary: "teach an agent a standing instruction", usage: "<agent> <correction>", requiresArg: true },
  { name: "policies", summary: "list an agent's coaching notes", usage: "<agent>", requiresArg: true },
  { name: "forget", summary: "remove a coaching note", usage: "<agent> <pol_id>", requiresArg: true },
  { name: "status", summary: "show the auth source" },
  { name: "login", summary: "sign in with a ChatGPT subscription", usage: "openai" },
  { name: "logout", summary: "sign out", usage: "openai" },
];

/** Wrap an index by delta within [0, len); returns 0 for an empty list. */
export function cycleIndex(current: number, len: number, delta: number): number {
  if (len <= 0) return 0;
  return (((current + delta) % len) + len) % len;
}

/** Commands matching what the captain is typing, while still on the command NAME (before a space). */
export function suggestCommands(buffer: string): SlashCommand[] {
  if (!buffer.startsWith("/")) return [];
  const rest = buffer.slice(1);
  if (rest.includes(" ")) return [];
  return COMMANDS.filter((c) => c.name.startsWith(rest.toLowerCase()));
}

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
    return [
      sys("commands (type / to see these; Tab completes):"),
      ...COMMANDS.map((c) => sys(`  /${c.name}${c.usage ? " " + c.usage : ""} — ${c.summary}`)),
      sys("  @<agent> <task> — address an agent · ESC to quit"),
    ];
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
