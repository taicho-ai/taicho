/** Pure REPL slash-command dispatch. Returns lines to print; no I/O of its own (store fns injected). */
import type { RegistryRow } from "../store/roster";
import type { RunTrace } from "../schemas/trace";
import type { PolicyNote } from "../schemas/policy";
import { McpServerConfig } from "../store/config";
import type { McpServerStatus } from "../core/mcp/manager";
import { rollupCosts, formatCostRollup } from "../core/costs";
import { DEFAULT_TEAM_ID } from "../schemas/team";

export type Line = { kind: "user" | "agent" | "system"; from?: string; text: string; rendered?: boolean };

export interface SlashCommand { name: string; summary: string; usage?: string; requiresArg?: boolean; }

/** Single source of truth for slash commands — drives both /help and the live suggester. */
export const COMMANDS: SlashCommand[] = [
  { name: "help", summary: "list commands" },
  { name: "agents", summary: "list the squad", usage: "[reindex]" },
  { name: "teams", summary: "list teams, their leads, and their members" },
  { name: "workflows", summary: "browse team workflows and their run state" },
  { name: "costs", summary: "cross-session spend rollup (agent / day / model)", usage: "[agent]" },
  { name: "tasks", summary: "list / cancel background tasks", usage: "[cancel <id>]" },
  { name: "schedules", summary: "scheduled/triggered runs (cron / interval / watch)", usage: "list | add <goal> --every … | remove <id> | run <id>" },
  { name: "view", summary: "switch the live view (persists)", usage: "bar|panes|both" },
  { name: "plan", summary: "show/hide the pinned plan panel (persists)", usage: "[on|off]" },
  { name: "teach", summary: "teach an agent a standing instruction", usage: "<agent> <correction>", requiresArg: true },
  { name: "policies", summary: "list an agent's coaching notes; approve a proposed one", usage: "<agent> | approve <pol_id>", requiresArg: true },
  { name: "forget", summary: "remove a coaching note", usage: "<agent> <pol_id>", requiresArg: true },
  { name: "mcp", summary: "manage MCP servers", usage: "[list|add|remove|login] …" },
  { name: "kb", summary: "manage the knowledgebase", usage: "sync | list [filter] | forget <filter> | reindex" },
  { name: "skills", summary: "manage agent skills", usage: "list | show <id|name> | remove <id> | reindex" },
  { name: "artifacts", summary: "browse the squad's artifacts — runs also end here", usage: "" },
  { name: "clear", summary: "clear the conversation — wipe the screen and forget history" },
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
  /** Plan 19: the squad's teams, captain-owned files. Empty on a squad that has never made one. */
  teams: { id: string; charter: string; lead?: string }[];
  listTraces: (agentId?: string) => RunTrace[]; // still the source /costs rolls up
  listPolicies: (agentId: string) => PolicyNote[];
  deletePolicy: (agentId: string, polId: string) => boolean;
  /** Approve a `proposed` note by id (search is caller-scoped across agents). Null ⇒ no such note. */
  approvePolicy: (polId: string) => PolicyNote | null;
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
    return deps.roster.map((r) => {
      // Show only EXPLICIT teams — every agent is on `default`, so printing it on each line is noise.
      // (The Org browser shows default; this flat list stays terse.)
      const teams = (r.teams ?? []).filter((t) => t !== DEFAULT_TEAM_ID);
      return sys(`  ${r.is_root ? "*" : "-"} ${r.id}: ${r.role}${teams.length ? ` (${teams.join(" · ")})` : ""}`);
    });
  if (cmd === "teams") {
    if (!deps.teams.length)
      return [sys("  (no teams) — a team is a captain-owned file at teams/<id>/team.md")];
    const out: Line[] = [];
    for (const t of deps.teams) {
      const members = deps.roster.filter((r) => r.teams?.includes(t.id));
      const how = t.lead ? `lead: ${t.lead}` : "routed by capability";
      out.push(sys(`  ${t.id}: ${t.charter}`));
      out.push(sys(`    ${how} · ${members.length} agent${members.length === 1 ? "" : "s"}`));
      for (const m of members) out.push(sys(`      ${m.id === t.lead ? "*" : "-"} ${m.id}: ${m.role}`));
    }
    return out;
  }
  if (cmd === "costs") {
    // Cross-session spend rollup from the per-run RunTrace records. Honest about subscription
    // (costUsd:null) runs — reports their tokens, never a fabricated $0. Optional [agent] scopes it.
    return formatCostRollup(rollupCosts(deps.listTraces(arg || undefined))).map(sys);
  }
  if (cmd === "policies") {
    const parts = arg.split(/\s+/).filter(Boolean);
    // `/policies approve <pol_id>` — the captain gate that flips a `proposed` note (e.g. a repeated-
    // failure coaching proposal) to `approved`, the only status run.ts applies. Id-only: the ⚑ proposal
    // message hands the captain the id, and approvePolicy locates its owning agent.
    if (parts[0] === "approve") {
      const polId = parts[1];
      if (!polId) return [sys("  usage: /policies approve <pol_id>")];
      const note = deps.approvePolicy(polId);
      if (!note) return [sys(`  no proposed policy "${polId}" — check the id (⚑ message or /policies <agent>)`)];
      return [sys(`  ✓ approved ${note.id} for ${note.agent} — WHEN ${note.when}: ${note.do}`)];
    }
    const agentId = parts[0];
    if (!agentId) return [sys("  usage: /policies <agent>  ·  /policies approve <pol_id>")];
    const notes = deps.listPolicies(agentId);
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

/** Split on whitespace but keep "double quoted" runs together (so --header "K: V" survives, and a
 *  cron expr `--cron "0 9 * * *"` stays one token). Shared by /mcp and /schedules parsing. */
export function tokenize(s: string): string[] {
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

// ---- /kb parsing (pure; the async handler lives in App.tsx) ---------------------------------------

export interface KbFilter { ids?: string[]; kind?: string; sourcePrefix?: string }
export type KbCommand =
  | { kind: "sync" }
  | { kind: "reindex" }
  | { kind: "list"; filter: KbFilter }
  | { kind: "forget"; filter: KbFilter }
  | { kind: "error"; message: string };

/** Parse `kind=…`, `source=…` (→ sourcePrefix), and repeatable `id=…` tokens into a filter. */
function parseKbFilter(tokens: string[]): KbFilter {
  const filter: KbFilter = {};
  const ids: string[] = [];
  for (const tok of tokens) {
    const [k, ...rest] = tok.split("=");
    const v = rest.join("=");
    if (!v) continue;
    if (k === "kind") filter.kind = v;
    else if (k === "source") filter.sourcePrefix = v;
    else if (k === "id") ids.push(v);
  }
  if (ids.length) filter.ids = ids;
  return filter;
}

export function parseKbCommand(arg: string): KbCommand {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0];
  const rest = parts.slice(1);
  if (sub === "sync") return { kind: "sync" };
  if (sub === "reindex") return { kind: "reindex" };
  if (sub === "list") return { kind: "list", filter: parseKbFilter(rest) };
  if (sub === "forget") {
    const filter = parseKbFilter(rest);
    if (!filter.ids && !filter.kind && !filter.sourcePrefix)
      return { kind: "error", message: "usage: /kb forget kind=… | source=… | id=… (at least one)" };
    return { kind: "forget", filter };
  }
  return { kind: "error", message: `unknown /kb subcommand "${sub ?? ""}" (try sync, list, forget, reindex)` };
}

// ---- /skills parsing (pure; the async handler lives in App.tsx) -----------------------------------

export type SkillCommand =
  | { kind: "list" }
  | { kind: "reindex" }
  | { kind: "show"; arg: string }
  | { kind: "remove"; id: string }
  | { kind: "error"; message: string };

export function parseSkillCommand(arg: string): SkillCommand {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0];
  if (!sub || sub === "list") return { kind: "list" };
  if (sub === "reindex") return { kind: "reindex" };
  if (sub === "show") return parts[1] ? { kind: "show", arg: parts[1] } : { kind: "error", message: "usage: /skills show <id|name>" };
  if (sub === "remove") return parts[1] ? { kind: "remove", id: parts[1] } : { kind: "error", message: "usage: /skills remove <id>" };
  return { kind: "error", message: `unknown /skills subcommand "${sub}" (try list, show, remove, reindex)` };
}
// Plan 21 Ph4: parseArtifactsCommand + ArtifactsCommand retired — /artifacts opens the browser;
// the verbs live inside it (⏎ read · a annotate · y approve · v versions · o $EDITOR · g gc).
