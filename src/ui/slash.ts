/** Pure REPL slash-command dispatch. Returns lines to print; no I/O of its own (store fns injected). */
import type { RegistryRow } from "../store/roster";
import type { RunTrace } from "../schemas/trace";
import type { PolicyNote } from "../schemas/policy";
import { McpServerConfig } from "../store/config";
import type { McpServerStatus } from "../core/mcp/manager";
import { rollupCosts, formatCostRollup } from "../core/costs";

export type Line = { kind: "user" | "agent" | "system"; from?: string; text: string; rendered?: boolean };

export interface SlashCommand { name: string; summary: string; usage?: string; requiresArg?: boolean; }

/** Single source of truth for slash commands — drives both /help and the live suggester. */
export const COMMANDS: SlashCommand[] = [
  { name: "help", summary: "list commands" },
  { name: "agents", summary: "list the squad" },
  { name: "runs", summary: "list runs", usage: "[agent]" },
  { name: "costs", summary: "cross-session spend rollup (agent / day / model)", usage: "[agent]" },
  { name: "tasks", summary: "list / cancel background tasks", usage: "[cancel <id>]" },
  { name: "trace", summary: "open the waterfall inspector (no arg = latest run)", usage: "[id]" },
  { name: "view", summary: "switch the live view (persists)", usage: "bar|panes|both" },
  { name: "teach", summary: "teach an agent a standing instruction", usage: "<agent> <correction>", requiresArg: true },
  { name: "policies", summary: "list an agent's coaching notes", usage: "<agent>", requiresArg: true },
  { name: "forget", summary: "remove a coaching note", usage: "<agent> <pol_id>", requiresArg: true },
  { name: "mcp", summary: "manage MCP servers", usage: "[list|add|remove|login] …" },
  { name: "kb", summary: "manage the knowledgebase", usage: "sync | list [filter] | forget <filter> | reindex" },
  { name: "skills", summary: "manage agent skills", usage: "list | show <id|name> | remove <id> | reindex" },
  { name: "artifacts", summary: "view / annotate / approve artifacts", usage: "list [q] | show <handle> | annotate <handle> <text> | approve <handle> | gc" },
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
    // Duration surfaced so /runs doubles as the waterfall picker (open one with /trace <id>).
    return traces.map((t) => sys(`  ${t.id}  ${t.outcome}  ${t.tokens}tok  ${(t.durationMs / 1000).toFixed(1)}s`));
  }
  if (cmd === "costs") {
    // Cross-session rollup from the SAME traces /runs reads. Honest about subscription (costUsd:null)
    // runs — reports their tokens, never a fabricated $0. Optional [agent] scopes to one agent.
    return formatCostRollup(rollupCosts(deps.listTraces(arg || undefined))).map(sys);
  }
  // NOTE: `/trace` is handled interactively in App.tsx (it opens the TraceInspector over the derived
  // span tree — see deriveTrace); it can't live here because that needs workspace file access.
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

// ---- /artifacts parsing (pure; the async handler lives in App.tsx) --------------------------------
// The captain's window into the hand-off store (Plan 01 Ph4d): view what agents produced, leave
// feedback (→ a revision run), sign off, and reclaim disk (gc). A handle is "id" (latest) or "id@vN".

export type ArtifactsCommand =
  | { kind: "list"; q?: string }
  | { kind: "show"; handle: string }
  | { kind: "annotate"; handle: string; body: string }
  | { kind: "approve"; handle: string }
  | { kind: "gc" }
  | { kind: "error"; message: string };

export function parseArtifactsCommand(arg: string): ArtifactsCommand {
  const trimmed = arg.trim();
  if (!trimmed) return { kind: "list" };
  const sp = trimmed.indexOf(" ");
  const sub = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
  if (sub === "list" || sub === "ls") return { kind: "list", q: rest || undefined };
  if (sub === "gc") return { kind: "gc" };
  if (sub === "show") return rest ? { kind: "show", handle: rest } : { kind: "error", message: "usage: /artifacts show <handle>" };
  if (sub === "approve") return rest ? { kind: "approve", handle: rest } : { kind: "error", message: "usage: /artifacts approve <handle>" };
  if (sub === "annotate") {
    const s2 = rest.indexOf(" ");
    if (s2 === -1) return { kind: "error", message: "usage: /artifacts annotate <handle> <feedback>" };
    const handle = rest.slice(0, s2);
    const body = rest.slice(s2 + 1).trim();
    if (!handle || !body) return { kind: "error", message: "usage: /artifacts annotate <handle> <feedback>" };
    return { kind: "annotate", handle, body };
  }
  return { kind: "error", message: `unknown /artifacts subcommand "${sub}" (try list, show, annotate, approve, gc)` };
}
