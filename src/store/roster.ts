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
export const ROOT_TOOLS = ["create_agent", "delegate_task", "dispatch_task", "check_task", "await_task", "find_agents", "ask_human", "read_url", "add_mcp_server", "remember", "recall", "propose_skill", "run_command", "save_artifact", "read_artifact", "list_artifacts", "annotate_artifact", "list_annotations"];

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

const LIBRARIAN_IDENTITY = `You are the librarian of a taicho squad — the keeper of the squad's shared knowledge graph.

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

/** `team` is null for an unaffiliated agent (root, librarian, a floating specialist), and OPTIONAL on
 *  the type so a caller constructing a row by hand — a test fixture, a slash-command stub — need not
 *  spell out an absence. loadIndex always selects it. */
export interface RegistryRow { id: string; role: string; is_root: number; team?: string | null; }

export interface NewAgentDraft {
  id: string; role: string; identity: string; tools?: string[]; team?: string;
}

/** The default worker capability baseline (Plan 01 hand-off-by-reference + Plan 14 lifecycle contract).
 *  EVERY worker created via create_agent gets these UNCONDITIONALLY: the structured artifact tools to
 *  PRODUCE a work product (save_artifact — or the legacy simple-markdown write_artifact wrapper),
 *  CONSUME others' by reference (read_artifact), DISCOVER them (list_artifacts), and give/receive
 *  feedback that drives a revision (annotate_artifact / list_annotations). This is the squad's FLOOR:
 *  a worker without it can only hand work back as loose `final.md` text — the root/2026-07-04-run6 gap.
 *  Privileged / opt-in capabilities (delegate_task, run_command, create_agent, ask_human, the KB tools,
 *  and any mcp:<server> ref — Plan 08 least privilege) are deliberately NOT here: a model requests those
 *  explicitly via create_agent's `tools`, which ADDS to this baseline, never REPLACES it. */
export const DEFAULT_WORKER_TOOLS = ["write_artifact", "save_artifact", "read_artifact", "list_artifacts", "annotate_artifact", "list_annotations"];

/** Merge a model-proposed tool list onto the worker baseline (Plan 14 T1 — baseline-merge, the robust
 *  fix over empty-means-default). The artifact baseline is ALWAYS present (deduped, baseline-first);
 *  `requested` only ADDS extras. So an explicit `tools: []` — or a `tools` list that simply forgot the
 *  artifact tools — can no longer defeat the default and mint a toolless worker (the bug this closes:
 *  `??` only filled null/undefined, so `tools: []` sailed through). */
export function workerTools(requested?: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...DEFAULT_WORKER_TOOLS, ...(requested ?? [])])
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  return out;
}

export function loadIndex(db: Database): RegistryRow[] {
  return db.query<RegistryRow, []>("SELECT id, role, is_root, team FROM registry").all();
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
  // Plan 19: agent ids and team ids share ONE namespace, so `delegate_task(to: "news")` never has to
  // guess which kind of thing it is addressing. Checked against the file directly — importing
  // store/teams.ts here would close a cycle (teams.ts needs DEFAULT_WORKER_TOOLS from this module).
  if (existsSync(paths.teamFile(ws, draft.id)))
    throw new Error(`cannot create agent "${draft.id}": a team already has that id (ids are one namespace)`);
  if (draft.team && !existsSync(paths.teamFile(ws, draft.team))) throw new Error(`no team "${draft.team}"`);
  const agent = AgentDef.parse({
    id: draft.id, role: draft.role, identity: draft.identity, team: draft.team,
    // Lifecycle contract (Plan 14 T1/T2): the DEFAULT_WORKER_TOOLS artifact baseline (produce + hand
    // off + consume by reference + annotate/revise) is ALWAYS merged in. An explicit `draft.tools`
    // list ADDS extras (delegate_task, run_command, an "mcp:<server>" ref, …) — it does NOT replace
    // the baseline. This is the enforced contract that create_agent can never again mint a toolless
    // worker: the old `draft.tools ?? [defaults]` let an explicit `tools: []` sail through and defeat
    // the default (?? only fills null/undefined), which is how the whole squad in root/2026-07-04-run6
    // was born unable to save/read/hand-off artifacts. NO MCP grant by default (Plan 08 least
    // privilege — MCP is opt-in via an explicit "mcp:<server>" ref passed in draft.tools).
    tools: workerTools(draft.tools),
    // Plan 19: a worker created ONTO a team sees its team, not all sixty strangers on the squad — which
    // is what keeps root's 30-agent roster cliff unreachable. An unaffiliated worker keeps the old
    // see-everyone default, so nothing changes for a squad that never creates a team.
    canSee: draft.team ? [`team:${draft.team}`] : ["*"],
    canDelegateTo: [], isRoot: false,
    created: new Date().toISOString(),
    budgets: defaults?.budgets,
  });
  await mkdir(paths.agentDir(ws, agent.id), { recursive: true });
  await writeFile(file, serializeAgent(agent));
  syncRegistry(db, [agent]);
  return agent;
}

/** Plan 14 T3 backfill — rescue existing workers that were born TOOLLESS. A worker persisted with an
 *  EMPTY tools list ([]) can't save/read/hand-off artifacts; it can only call the unconditional baseline
 *  (find_skills/use_skill) and hand work back as loose text (the root/2026-07-04-run6 squad). On boot we
 *  grant such workers the DEFAULT_WORKER_TOOLS baseline and rewrite their agent.md, so a live squad becomes
 *  usable without hand-editing each file. This is deliberately a CODE-level migration keyed on the empty
 *  list — the definitively-broken signal — NOT on "missing some artifact tool": a NON-empty explicit grant
 *  is a deliberate curation choice (root, librarian, or a hand-restricted worker) and is left untouched.
 *  Root/librarian are reconciled separately (seedRoot/seedLibrarian) and never carry an empty list, but we
 *  skip isRoot defensively. Returns the ids fixed (for a boot notice). */
export async function reconcileWorkerTools(ws: string): Promise<string[]> {
  const dir = join(ws, "agents");
  if (!existsSync(dir)) return [];
  const fixed: string[] = [];
  for (const id of await readdir(dir)) {
    const file = paths.agentFile(ws, id);
    if (!existsSync(file)) continue;
    let agent: AgentDef;
    try { agent = parseAgent(await readFile(file, "utf8")); }
    catch (e) { log.warn(`reconcileWorkerTools: skipping ${id}`, e); continue; }
    if (agent.isRoot || agent.id === LIBRARIAN_ID) continue; // built-ins reconcile via their seed fns
    if (agent.tools.length > 0) continue;                    // deliberate non-empty grant — leave alone
    agent.tools = workerTools([]);                           // born toolless → grant the worker baseline
    await writeFile(file, serializeAgent(agent));
    fixed.push(agent.id);
  }
  return fixed;
}
