/** agent.md is canon: YAML frontmatter (the AgentDef minus identity) + markdown body (the SOUL).
 *  Parsed with Bun.YAML (native). The registry table is a derived index of this. */
import { YAML } from "bun";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { AgentDef } from "../schemas/agent";
import { paths } from "./files";
import { syncRegistry } from "../core/registry";
import type { TaichoConfig } from "./config";
import { log } from "../core/logger";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function serializeAgent(a: AgentDef): string {
  const { identity, ...meta } = a;
  // Block-style YAML (indent 2) keeps agent.md frontmatter human-readable/editable.
  return `---\n${YAML.stringify(meta, null, 2)}\n---\n${identity}\n`;
}

export function parseAgent(text: string): AgentDef {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("agent.md is missing YAML frontmatter");
  const meta = YAML.parse(m[1]) as Record<string, unknown>;
  return AgentDef.parse({ ...meta, identity: m[2].trim() });
}

const ROOT_IDENTITY = `You are the root orchestrator of a taicho squad — the captain's standing assistant.

Your job is to TURN THE CAPTAIN'S INTENT INTO ACTION, never to do the domain work yourself:
- When the captain needs a capability no agent has, call create_agent to PROPOSE a worker (a clear id, a one-line role, and an identity that gives it a strong point of view). The captain approves before it exists.
- When a fitting agent exists, use find_agents to locate it and delegate_task to hand off the goal.
- When the captain's intent is ambiguous, call ask_human with 2-4 concrete options to get clarity BEFORE acting — don't guess at what they meant.
- Keep your own replies short. You coordinate; the squad produces artifacts.
- When the captain points you at an MCP server's setup docs, call read_url on that page, infer the server config from it (a \`url\` for hosted servers, or a \`command\` for local ones), and propose it with add_mcp_server for approval. If it needs a secret, ask_human for the env-var name and tell the captain to set it, then reference it as \${VAR}. If the connect fails, read the error and retry a corrected config. Once connected, offer to create_agent a worker wired to \`mcp:<server>\`.
- When the captain teaches a repeatable procedure worth reusing, call propose_skill to codify it as a reviewed skill (the captain approves before it's saved).`;

/** Root's built-in capabilities. Kept in one place so existing roots get reconciled to the current
 *  set on boot (older roots drift — e.g. predate ask_human / the MCP tools). */
export const ROOT_TOOLS = ["create_agent", "delegate_task", "dispatch_task", "check_task", "await_task", "find_agents", "ask_human", "read_url", "add_mcp_server", "remember", "recall", "propose_skill", "run_command", "save_artifact", "read_artifact", "list_artifacts"];

export async function seedRoot(ws: string, defaults?: TaichoConfig["defaults"]): Promise<void> {
  const file = paths.agentFile(ws, "root");
  if (await Bun.file(file).exists()) {
    // Reconcile: ensure an existing root carries the current built-in tools (preserve any extras).
    const root = await loadAgent(ws, "root");
    const missing = ROOT_TOOLS.filter((t) => !root.tools.includes(t));
    if (missing.length) {
      root.tools = [...root.tools, ...missing];
      await writeFile(file, serializeAgent(root));
    }
    return;
  }
  const root = AgentDef.parse({
    id: "root",
    role: "Orchestrator — interviews the captain, proposes and coordinates worker agents",
    identity: ROOT_IDENTITY,
    tools: ROOT_TOOLS,
    canSee: ["*"], canDelegateTo: ["*"], isRoot: true,
    created: new Date().toISOString(),
    budgets: defaults?.budgets,
  });
  await mkdir(paths.agentDir(ws, "root"), { recursive: true });
  await writeFile(file, serializeAgent(root));
}

export const LIBRARIAN_ID = "librarian";
export const LIBRARIAN_TOOLS = ["read_source", "remember", "recall", "forget", "reindex_knowledge"];

const LIBRARIAN_IDENTITY = `You are the librarian of a taicho squad — the keeper of the deck's shared knowledge graph.

Your job is to turn source documents into a clean graph, and to prune memory on command:
- To INGEST a source document: read it with read_source, then extract the ENTITIES and RELATIONSHIPS it asserts — not chunks of prose. remember each entity/fact/decision (choose a fitting kind), and link them with typed edges (relates_to, depends_on, part_of, contradicts, derived_from). recall first to reuse existing node ids when linking. Keep each node atomic and self-contained.
- Prefer a few well-connected nodes over many redundant ones.
- To PRUNE on the captain's request, use forget with the NARROWEST filter that satisfies the intent — by kind (e.g. all decisions), by sourcePrefix (e.g. "worker-x:" for one assistant's memory), or by explicit ids. Report exactly what you removed.
- After bulk hand-edits to node files, call reindex_knowledge to rebuild the index and refresh vectors.
- Keep replies short and factual — you curate; you don't do domain work.`;

/** Seed the built-in librarian next to root. Reconciles an existing librarian's toolset like seedRoot. */
export async function seedLibrarian(ws: string, defaults?: TaichoConfig["defaults"]): Promise<void> {
  const file = paths.agentFile(ws, LIBRARIAN_ID);
  if (await Bun.file(file).exists()) {
    const lib = await loadAgent(ws, LIBRARIAN_ID);
    const missing = LIBRARIAN_TOOLS.filter((t) => !lib.tools.includes(t));
    if (missing.length) {
      lib.tools = [...lib.tools, ...missing];
      await writeFile(file, serializeAgent(lib));
    }
    return;
  }
  const lib = AgentDef.parse({
    id: LIBRARIAN_ID,
    role: "Librarian — extracts entities from source documents, curates and prunes the knowledge graph",
    identity: LIBRARIAN_IDENTITY,
    tools: LIBRARIAN_TOOLS,
    canSee: [], canDelegateTo: [], isRoot: false,
    created: new Date().toISOString(),
    budgets: defaults?.budgets,
  });
  await mkdir(paths.agentDir(ws, LIBRARIAN_ID), { recursive: true });
  await writeFile(file, serializeAgent(lib));
}

export interface RegistryRow { id: string; role: string; is_root: number; }

export interface NewAgentDraft {
  id: string; role: string; identity: string; tools?: string[];
}

export function loadIndex(db: Database): RegistryRow[] {
  return db.query<RegistryRow, []>("SELECT id, role, is_root FROM registry").all();
}

export async function loadAgent(ws: string, id: string): Promise<AgentDef> {
  return parseAgent(await readFile(paths.agentFile(ws, id), "utf8"));
}

/** Full scan agents/<id>/agent.md -> registry. Async; call on boot only when the index is empty. */
export async function reindex(ws: string, db: Database): Promise<void> {
  const dir = join(ws, "agents");
  if (!existsSync(dir)) return;
  const ids = await readdir(dir);
  const agents: AgentDef[] = [];
  for (const id of ids) {
    const file = paths.agentFile(ws, id);
    if (!existsSync(file)) continue;
    try { agents.push(parseAgent(await readFile(file, "utf8"))); }
    catch (e) { log.warn(`skipping agent ${id}`, e); }
  }
  if (agents.length) syncRegistry(db, agents);
}

export async function createAgent(ws: string, db: Database, draft: NewAgentDraft, _taughtBy: string, defaults?: TaichoConfig["defaults"]): Promise<AgentDef> {
  const file = paths.agentFile(ws, draft.id);
  if (existsSync(file)) throw new Error(`agent "${draft.id}" already exists`);
  const agent = AgentDef.parse({
    id: draft.id, role: draft.role, identity: draft.identity,
    // Default worker grant: the structured artifact trio (produce + hand off + consume by reference)
    // plus write_artifact (legacy simple-markdown wrapper). NO MCP grant by default (Plan 08 least
    // privilege — MCP tools are opt-in via an explicit "mcp:<server>" ref). To wire a worker to an
    // MCP server, pass it in draft.tools (e.g. root proposes create_agent with tools incl. mcp:web).
    tools: draft.tools ?? ["write_artifact", "save_artifact", "read_artifact", "list_artifacts"],
    canSee: ["*"], canDelegateTo: [], isRoot: false,
    created: new Date().toISOString(),
    budgets: defaults?.budgets,
  });
  await mkdir(paths.agentDir(ws, agent.id), { recursive: true });
  await writeFile(file, serializeAgent(agent));
  syncRegistry(db, [agent]);
  return agent;
}
