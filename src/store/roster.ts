/** agent.md is canon: YAML frontmatter (the AgentDef minus identity) + markdown body (the SOUL).
 *  Parsed with Bun.YAML (native). The registry table is a derived index of this. */
import { YAML } from "bun";
import { mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { AgentDef } from "../schemas/agent";
import { DEFAULT_TEAM_ID } from "../schemas/team";
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
export const ROOT_TOOLS = ["create_agent", "create_team", "read_workflow", "run_workflow", "propose_workflow", "resume_workflow", "delegate_task", "dispatch_task", "check_task", "await_task", "find_agents", "ask_human", "read_url", "add_mcp_server", "remember", "recall", "propose_skill", "run_command", "save_artifact", "read_artifact", "list_artifacts", "annotate_artifact", "list_annotations", "write_plan", "update_plan_item", "read_plan"];

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

/** Plan 22: `teams` is an agent's full EFFECTIVE membership — the implicit `default` plus its explicit
 *  teams, default first (as loadIndex reads it from agent_teams). OPTIONAL on the type so a caller
 *  constructing a row by hand — a test fixture, a slash-command stub — need not spell it out; loadIndex
 *  always populates it. An unaffiliated agent still carries `["default"]`. */
export interface RegistryRow { id: string; role: string; is_root: number; teams?: string[]; }

export interface NewAgentDraft {
  id: string; role: string; identity: string; tools?: string[]; teams?: string[];
}

/** The default worker capability baseline (Plan 01 hand-off-by-reference + Plan 14 lifecycle contract).
 *  EVERY worker created via create_agent gets these UNCONDITIONALLY: the structured artifact tools to
 *  PRODUCE a work product (save_artifact — or the legacy simple-markdown write_artifact wrapper),
 *  CONSUME others' by reference (read_artifact), DISCOVER them (list_artifacts), and give/receive
 *  feedback that drives a revision (annotate_artifact / list_annotations). This is the squad's FLOOR:
 *  a worker without it can only hand work back as loose `final.md` text — the root/2026-07-04-run6 gap.
 *  Privileged / opt-in capabilities (delegate_task, run_command, create_agent, ask_human, the KB tools,
 *  the Plan 18 plan tools, and any mcp:<server> ref — Plan 08 least privilege) are deliberately NOT here:
 *  a model requests those explicitly via create_agent's `tools`, which ADDS to this baseline, never
 *  REPLACES it. A plan is not needed to produce an artifact, so write_plan/update_plan_item/read_plan
 *  stay an opt-in grant — otherwise every worker on a squad would own one and the panel would be a
 *  forest. Root holds them by default; a team lead asks. */
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
  const base = db.query<{ id: string; role: string; is_root: number }, []>("SELECT id, role, is_root FROM registry").all();
  const byAgent = new Map<string, string[]>();
  for (const m of db.query<{ agent_id: string; team_id: string }, []>("SELECT agent_id, team_id FROM agent_teams ORDER BY agent_id, ord").all()) {
    const l = byAgent.get(m.agent_id) ?? [];
    l.push(m.team_id);
    byAgent.set(m.agent_id, l);
  }
  return base.map((r) => ({ ...r, teams: byAgent.get(r.id) ?? [] }));
}

/** An agent's effective teams (default first), read from the derived index. The single-team question
 *  the old `registry.team` column answered — now that membership is many-to-many. */
export function teamsOf(db: Database, agentId: string): string[] {
  return db.query<{ team_id: string }, [string]>("SELECT team_id FROM agent_teams WHERE agent_id = ? ORDER BY ord").all(agentId).map((r) => r.team_id);
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
  // Plan 20 (review finding): delete-then-rebuild, like every sibling reindex (plans/tasks/skills/kb).
  // syncRegistry alone is upsert-only, so a hand-DELETED agent.md left a ghost registry row that no
  // boot or /agents reindex ever removed. Files are canon; the whole table is derived. Plan 22: clear
  // the membership join too, or a removed agent's team rows would linger (membersOf would over-report).
  db.query("DELETE FROM registry").run();
  db.query("DELETE FROM agent_teams").run();
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
  // Plan 22: an agent may be born onto SEVERAL teams; every named one must exist (the implicit `default`
  // is never listed here, so it is not — and cannot be — checked). A missing team is a hard error, not
  // a silent dangling membership.
  const teams = (draft.teams ?? []).filter((t) => t !== DEFAULT_TEAM_ID);
  for (const t of teams) if (!existsSync(paths.teamFile(ws, t))) throw new Error(`no team "${t}"`);
  const agent = AgentDef.parse({
    id: draft.id, role: draft.role, identity: draft.identity, teams,
    // Lifecycle contract (Plan 14 T1/T2): the DEFAULT_WORKER_TOOLS artifact baseline (produce + hand
    // off + consume by reference + annotate/revise) is ALWAYS merged in. An explicit `draft.tools`
    // list ADDS extras (delegate_task, run_command, an "mcp:<server>" ref, …) — it does NOT replace
    // the baseline. This is the enforced contract that create_agent can never again mint a toolless
    // worker: the old `draft.tools ?? [defaults]` let an explicit `tools: []` sail through and defeat
    // the default (?? only fills null/undefined), which is how the whole squad in root/2026-07-04-run6
    // was born unable to save/read/hand-off artifacts. NO MCP grant by default (Plan 08 least
    // privilege — MCP is opt-in via an explicit "mcp:<server>" ref passed in draft.tools).
    tools: workerTools(draft.tools),
    // Plan 19/22: a worker created ONTO teams sees THOSE teams, not all sixty strangers on the squad —
    // which is what keeps root's 30-agent roster cliff unreachable. An unaffiliated worker keeps the old
    // see-everyone default, so nothing changes for a squad that never creates a team.
    canSee: teams.length ? teams.map((t) => `team:${t}`) : ["*"],
    canDelegateTo: [], isRoot: false,
    created: new Date().toISOString(),
    budgets: defaults?.budgets,
  });
  await mkdir(paths.agentDir(ws, agent.id), { recursive: true });
  await writeFile(file, serializeAgent(agent));
  syncRegistry(db, [agent]);
  return agent;
}

/** Is this canSee the AUTO-DERIVED shape createAgent produces — see-everyone (`["*"]`) or purely
 *  team-scoped (`team:<id>` entries only)? If so, re-teaming the agent may safely re-derive it so a
 *  moved worker sees its new teammates. A canSee that names exact agent ids is a hand-customization and
 *  is left untouched. An empty canSee (the librarian) is NOT default-shaped — leave it. */
function isDefaultShapedCanSee(canSee: string[]): boolean {
  if (canSee.length === 1 && canSee[0] === "*") return true;
  return canSee.length > 0 && canSee.every((e) => e.startsWith("team:"));
}

export interface AgentPatch { role?: string; identity?: string; tools?: string[]; teams?: string[]; canSee?: string[]; canDelegateTo?: string[]; }

/** Plan 22: edit an existing agent (the captain's `e`/`c`/`t`/`b` verbs and the CLI). Applies only the
 *  fields present in `patch`, re-parses through AgentDef (so a bad value is rejected), rewrites agent.md,
 *  and refreshes the derived index. Team edits are validated to exist, the Plan 14 artifact floor is
 *  re-merged onto a worker's tools, and a default-shaped canSee is kept in sync with the new teams. */
export async function updateAgent(ws: string, db: Database, id: string, patch: AgentPatch): Promise<AgentDef> {
  const file = paths.agentFile(ws, id);
  if (!existsSync(file)) throw new Error(`no agent "${id}"`);
  const cur = await loadAgent(ws, id);
  const teams = (patch.teams ?? cur.teams).filter((t) => t !== DEFAULT_TEAM_ID);
  for (const t of teams) if (!existsSync(paths.teamFile(ws, t))) throw new Error(`no team "${t}"`);
  let canSee = patch.canSee ?? cur.canSee;
  if (patch.teams && !patch.canSee && isDefaultShapedCanSee(cur.canSee))
    canSee = teams.length ? teams.map((t) => `team:${t}`) : ["*"];
  const isBuiltIn = cur.isRoot || id === LIBRARIAN_ID;
  const next = AgentDef.parse({
    ...cur,
    role: patch.role ?? cur.role,
    identity: patch.identity ?? cur.identity,
    // A worker's tool edit always keeps the artifact floor (Plan 14); root/librarian keep their curated set.
    tools: patch.tools ? (isBuiltIn ? patch.tools : workerTools(patch.tools)) : cur.tools,
    teams,
    canSee,
    canDelegateTo: patch.canDelegateTo ?? cur.canDelegateTo,
  });
  await writeFile(file, serializeAgent(next));
  syncRegistry(db, [next]);
  return next;
}

/** Set an agent's explicit team memberships (the `t` verb / member pickers). A thin updateAgent. */
export async function setAgentTeams(ws: string, db: Database, id: string, teams: string[]): Promise<AgentDef> {
  return updateAgent(ws, db, id, { teams });
}

/** Retire an agent (the `d` verb / CLI). Root and the librarian are protected — the squad needs its
 *  captain and its keeper of knowledge. Removes the agent's files and its derived rows (registry +
 *  membership). A team this agent LED is left with a dangling `lead`, which validateTeams reports on the
 *  next boot — deliberately report-and-ask, not a silent rewrite of the team's intent. */
export async function deleteAgent(ws: string, db: Database, id: string): Promise<void> {
  if (id === "root") throw new Error("cannot retire root — the squad needs its captain");
  if (id === LIBRARIAN_ID) throw new Error("cannot retire the librarian — it keeps the knowledge graph");
  const dir = paths.agentDir(ws, id);
  if (!existsSync(dir)) throw new Error(`no agent "${id}"`);
  await rm(dir, { recursive: true, force: true });
  db.query("DELETE FROM registry WHERE id = ?").run(id);
  db.query("DELETE FROM agent_teams WHERE agent_id = ?").run(id);
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
