/** Pure REPL slash-command dispatch. Returns lines to print; no I/O of its own (store fns injected). */
import type { RegistryRow } from "../store/roster";
import type { RunTrace } from "../schemas/trace";
import type { PolicyNote } from "../schemas/policy";
import { McpServerConfig } from "../store/config";
import type { McpServerStatus } from "../core/mcp/manager";

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
  { name: "mcp", summary: "manage MCP servers", usage: "[list|add|remove|login] …" },
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

// ---- /mcp parsing & formatting (pure; the async handler lives in App.tsx) -------------------------

export type McpCommand =
  | { kind: "list" }
  | { kind: "add"; name: string; spec: McpServerConfig }
  | { kind: "remove"; name: string }
  | { kind: "login"; name: string }
  | { kind: "reconnect"; name: string }
  | { kind: "error"; message: string };

/** Split on whitespace but keep "double quoted" runs together (so --header "K: V" survives). */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "", q = false, has = false;
  for (const c of s) {
    if (c === '"') { q = !q; has = true; continue; }
    if (!q && /\s/.test(c)) { if (has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c; has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** Parse the argument string of `/mcp …` into a command. Supports:
 *   (bare) | list
 *   add <name> <command> [args…] [--env K=V …]            (stdio)
 *   add <name> <https://url> [--oauth] [--header "K: V" …] (http)
 *   remove|login|reconnect <name>                                                     */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i; // no `/` (it delimits server/tool refs), no spaces

export function parseMcpCommand(arg: string): McpCommand {
  const tokens = tokenize(arg.trim());
  const sub = (tokens[0] ?? "list").toLowerCase();
  if (sub === "list" || sub === "ls") return { kind: "list" };

  if (sub === "remove" || sub === "rm" || sub === "login" || sub === "reconnect") {
    const name = tokens[1];
    if (!name) return { kind: "error", message: `usage: /mcp ${sub} <name>` };
    if (!NAME_RE.test(name)) return { kind: "error", message: `invalid server name "${name}" (use letters, digits, _ or -)` };
    const kind = sub === "rm" ? "remove" : (sub as "remove" | "login" | "reconnect");
    return { kind, name };
  }

  if (sub === "add") {
    const name = tokens[1];
    if (!name) return { kind: "error", message: "usage: /mcp add <name> <command…|https://url> [flags]" };
    if (!NAME_RE.test(name)) return { kind: "error", message: `invalid server name "${name}" (use letters, digits, _ or -)` };
    const rest = tokens.slice(2);
    const positionals: string[] = [];
    const headers: Record<string, string> = {};
    const env: Record<string, string> = {};
    let oauth = false;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === "--oauth") oauth = true;
      else if (t === "--header") { const kv = rest[++i] ?? ""; const j = kv.indexOf(":"); if (j > 0) headers[kv.slice(0, j).trim()] = kv.slice(j + 1).trim(); }
      else if (t === "--env") { const kv = rest[++i] ?? ""; const j = kv.indexOf("="); if (j > 0) env[kv.slice(0, j)] = kv.slice(j + 1); }
      else positionals.push(t);
    }
    if (!positionals.length) return { kind: "error", message: "usage: /mcp add <name> <command…|https://url> [flags]" };
    const head = positionals[0];
    const isHttp = /^https?:\/\//.test(head);
    if (isHttp && Object.keys(env).length) return { kind: "error", message: "--env applies to stdio servers, not an http url" };
    if (!isHttp && (Object.keys(headers).length || oauth)) return { kind: "error", message: "--header/--oauth apply to http servers, not a stdio command" };
    const raw: unknown = isHttp
      ? { url: head, ...(Object.keys(headers).length ? { headers } : {}), ...(oauth ? { auth: "oauth" } : {}) }
      : { command: head, ...(positionals.length > 1 ? { args: positionals.slice(1) } : {}), ...(Object.keys(env).length ? { env } : {}) };
    const parsed = McpServerConfig.safeParse(raw);
    if (!parsed.success) return { kind: "error", message: `invalid server spec: ${parsed.error.issues[0]?.message ?? "bad input"}` };
    return { kind: "add", name, spec: parsed.data };
  }

  return { kind: "error", message: `unknown /mcp subcommand "${sub}" (try list, add, remove, login, reconnect)` };
}

const statusIcon = (s: McpServerStatus["status"]): string => (s === "connected" ? "●" : s === "needs-auth" ? "◌" : "✗");

export function formatMcpStatus(servers: McpServerStatus[]): string[] {
  if (!servers.length) return ["  (no MCP servers — add one with /mcp add <name> npx -y <server> …)"];
  return servers.map((s) =>
    `  ${statusIcon(s.status)} ${s.name} [${s.kind}] ${s.status}` +
    (s.status === "connected" ? ` · ${s.toolCount} tool(s)` : "") +
    (s.error ? ` · ${s.error}` : ""));
}
