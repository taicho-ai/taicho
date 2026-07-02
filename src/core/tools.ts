/** Per-agent toolset. Every tool carries an execute fn so the AI SDK includes tool RESULTS in
 *  response.messages (the manual loop pushes those back). execute closes over the RunContext,
 *  which is how create_agent awaits captain approval and delegate_task spawns child runs. */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { writeFile, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { AgentDef } from "../schemas/agent";
import type { RunContext } from "./run";
import type { McpManager } from "./mcp/manager";
import { artifactPath, paths } from "../store/files";
import { mergeDraft } from "./draft";
import { scrapeUrl } from "./firecrawl";
import { McpServerConfig } from "../store/config";
import { addMcpServer } from "../store/mcp-store";
import { KbNode } from "../schemas/knowledge";
import { writeNode, mkKbId, nodeExists, forgetNodes, reindexKnowledge, reembedAll } from "../store/knowledge";
import { putVector } from "../store/vectors";
import { searchKnowledge } from "../knowledge/retrieval";
import { getActiveSkills } from "../store/skills";
import { rankSkills } from "../skills/retrieval";

export function toolsForAgent(agent: AgentDef, ctx: RunContext, mcp?: McpManager): ToolSet {
  const set: ToolSet = {};

  if (agent.tools.includes("write_artifact"))
    set.write_artifact = tool({
      description: "Write an immutable artifact file (new file per run) and return its path.",
      inputSchema: z.object({
        topicSlug: z.string().regex(/^[a-z0-9-]+$/, "lowercase, digits, hyphens only"),
        markdown: z.string(),
      }),
      execute: async ({ topicSlug, markdown }) => {
        const path = artifactPath(ctx.ws, topicSlug, ctx.runId);
        await writeFile(path, markdown);
        ctx.artifacts.push(path);
        return { path };
      },
    });

  if (agent.tools.includes("create_agent"))
    set.create_agent = tool({
      description: "Propose a NEW worker agent for the captain to approve. Give it a clear id, a one-line role, and an identity that defines its point of view.",
      inputSchema: z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/),
        role: z.string(),
        identity: z.string(),
        tools: z.array(z.string()).optional(),
      }),
      execute: async (draft) => {
        const decision = await ctx.requestApproval({ kind: "create_agent", draft });
        if (decision.type === "reject") return { rejected: true, reason: "reject" };
        const finalDraft = decision.type === "edit" ? mergeDraft(draft, decision.draft) : draft;
        try {
          const created = await ctx.createAgent(finalDraft);
          return { created: created.id, role: created.role };
        } catch {
          return { error: `agent "${finalDraft.id}" already exists or could not be created` };
        }
      },
    });

  if (agent.tools.includes("delegate_task"))
    set.delegate_task = tool({
      description: "Delegate a goal to another agent by id and receive its result.",
      inputSchema: z.object({ to: z.string(), goal: z.string(), context: z.string().optional() }),
      execute: async ({ to, goal, context }) => {
        ctx.workItems.n += 1;
        if (ctx.workItems.n > agent.budgets.maxWorkItemsPerRequest) {
          const msg = `work item budget (${agent.budgets.maxWorkItemsPerRequest}) exhausted`;
          ctx.notes.push(`delegate refused: ${msg}`);
          return { error: msg };
        }
        const guard = ctx.delegationGuard(to);
        if (!guard.ok) { ctx.notes.push(`delegate refused: ${guard.error}`); return { error: guard.error }; }
        try {
          const child = await ctx.runChild({ to, goal, context });
          ctx.delegatedOut.push(child.runId);
          const childAgg = child.trace.aggregate ?? { tokens: child.trace.tokens, costUsd: child.trace.costUsd };
          ctx.childSpend.tokens += childAgg.tokens;
          ctx.childSpend.costUsd += childAgg.costUsd ?? 0;
          return { to, runId: child.runId, result: child.text };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ctx.notes.push(`delegate failed: ${msg}`);
          return { error: msg };
        }
      },
    });

  if (agent.tools.includes("find_agents"))
    set.find_agents = tool({
      description: "Search the squad for agents whose role matches a capability. Returns top matches.",
      inputSchema: z.object({ query: z.string(), k: z.number().int().positive().max(20).default(8) }),
      execute: async ({ query, k }) => ({ matches: ctx.findAgents(query, k) }),
    });

  if (agent.tools.includes("read_url"))
    set.read_url = tool({
      description: "Fetch a web page (e.g. an MCP server's setup docs) and return it as clean markdown. Requires FIRECRAWL_API_KEY in the environment.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        const r = await scrapeUrl(url);
        return "markdown" in r ? { markdown: r.markdown } : { error: r.error };
      },
    });

  if (mcp && agent.tools.includes("add_mcp_server"))
    set.add_mcp_server = tool({
      description: "Connect a NEW MCP server for the captain to approve. Provide a `url` for a remote/hosted server (with auth:'oauth' or headers), or a `command`/`args` for a local stdio server. Put secrets as ${ENV_VAR} refs (ask_human for the var name first). Returns the connection status + tool count; on error, fix the config and call again.",
      inputSchema: z.object({
        name: z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id: letters, digits, hyphens"),
        url: z.string().url().optional(),
        auth: z.literal("oauth").optional(),
        headers: z.record(z.string(), z.string()).optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
      execute: async ({ name, url, auth, headers, command, args, env }) => {
        const raw = url
          ? { url, ...(auth ? { auth } : {}), ...(headers ? { headers } : {}) }
          : command
            ? { command, ...(args ? { args } : {}), ...(env ? { env } : {}) }
            : null;
        if (!raw) return { error: "provide a `url` (remote server) or a `command` (local stdio server)" };
        const parsed = McpServerConfig.safeParse(raw);
        if (!parsed.success) return { error: `invalid server config: ${parsed.error.issues[0]?.message ?? "unknown"}` };
        const spec = parsed.data;
        const decision = await ctx.requestApproval({ kind: "add_mcp", name, spec });
        if (decision.type !== "approve") return { rejected: true };
        addMcpServer(ctx.ws, name, spec);
        const status = await mcp.addServer(name, spec);
        return { name, status: status.status, toolCount: status.toolCount, error: status.error };
      },
    });

  if (agent.tools.includes("ask_human"))
    set.ask_human = tool({
      description: "Ask the human captain a clarifying question with 2-4 options when intent is ambiguous. The captain picks an option or types their own answer; you receive { answer } and continue.",
      inputSchema: z.object({
        question: z.string().describe("a single clear question"),
        options: z.array(z.string()).min(2).max(4).describe("2-4 concrete choices"),
      }),
      execute: async ({ question, options }) => {
        const d = await ctx.requestApproval({ kind: "ask_human", question, options });
        return d.type === "answered" ? { answer: d.answer } : { cancelled: true };
      },
    });

  if (agent.tools.includes("remember"))
    set.remember = tool({
      description: "Save a durable fact / decision / entity to the squad's shared knowledgebase, optionally linking it to existing nodes with typed edges (rel e.g. relates_to, depends_on, contradicts). Returns the node id — recall first to get ids to link to.",
      inputSchema: z.object({
        title: z.string(),
        content: z.string(),
        kind: z.string().default("fact"),
        summary: z.string().optional(),
        edges: z.array(z.object({ to: z.string(), rel: z.string().default("relates_to") })).default([]),
      }),
      execute: async ({ title, content, kind, summary, edges }) => {
        const requested = edges ?? [];
        const valid = requested.filter((e) => nodeExists(ctx.db, e.to)); // drop dangling edge targets
        const node = KbNode.parse({
          id: mkKbId(), title, content, kind, summary, scope: "deck",
          source: ctx.ingestSource ?? `${ctx.agentId}:${ctx.runId}`, edges: valid, created: new Date().toISOString(),
        });
        writeNode(ctx.ws, ctx.db, node);
        if (ctx.embed) {
          try { putVector(ctx.db, node.id, "kb", await ctx.embed(`${node.title}\n${node.summary ?? ""}\n${node.content}`)); }
          catch { /* semantic index is best-effort; keyword+graph still works */ }
        }
        ctx.notes.push(`remembered ${node.id}`);
        return { id: node.id, edgesAdded: valid.length, edgesDropped: requested.length - valid.length };
      },
    });

  if (agent.tools.includes("recall"))
    set.recall = tool({
      description: "Search the squad's shared knowledgebase and its typed-edge graph. Returns matching nodes plus their linked neighbors — by meaning (semantic when available) and by relationship.",
      inputSchema: z.object({
        query: z.string(),
        k: z.number().int().positive().max(20).default(6),
        hops: z.number().int().min(0).max(2).default(1),
        rels: z.array(z.string()).optional(),
      }),
      execute: async ({ query, k, hops, rels }) => {
        const r = await searchKnowledge({ db: ctx.db, query, embed: ctx.embed, k, hops, rels });
        return { mode: r.mode, hits: r.hits.map((h) => ({ id: h.id, title: h.title, summary: h.summary, via: h.via, score: +h.score.toFixed(3) })) };
      },
    });

  if (agent.tools.includes("read_source"))
    set.read_source = tool({
      description: "Read an admin-authored source document from kb/sources/ so you can extract entities from it. `path` is like \"sources/architecture.md\" or \"architecture.md\".",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const name = path.replace(/^sources\//, "");
        const dir = paths.kbSourceDir(ctx.ws);
        const full = resolve(dir, name);
        if (full !== dir && !full.startsWith(dir + sep)) return { error: "path must be a file under kb/sources/" };
        try { return { content: await readFile(full, "utf8") }; }
        catch { return { error: `no such source: ${name}` }; }
      },
    });

  if (agent.tools.includes("forget"))
    set.forget = tool({
      description: "Prune the knowledgebase: cascade-delete nodes matching a filter, plus their edges and vectors. Filter by `kind` (e.g. decision), `sourcePrefix` (e.g. \"worker-x:\" for one assistant's memory, or \"sources/foo.md@\" for a doc), and/or explicit `ids`. At least one clause is required.",
      inputSchema: z.object({
        ids: z.array(z.string()).optional(),
        kind: z.string().optional(),
        sourcePrefix: z.string().optional(),
      }),
      execute: async ({ ids, kind, sourcePrefix }) => {
        if (!ids?.length && !kind && !sourcePrefix) return { error: "provide at least one of ids, kind, or sourcePrefix" };
        const r = forgetNodes(ctx.ws, ctx.db, { ids, kind, sourcePrefix });
        ctx.notes.push(`forgot ${r.removedNodes} node(s)`);
        return r;
      },
    });

  if (agent.tools.includes("reindex_knowledge"))
    set.reindex_knowledge = tool({
      description: "Rebuild the knowledge graph index from the canonical node files and refresh semantic vectors. Use after bulk hand-edits.",
      inputSchema: z.object({}),
      execute: async () => {
        reindexKnowledge(ctx.ws, ctx.db);
        const embedded = ctx.embed ? await reembedAll(ctx.db, ctx.embed) : 0;
        return { reindexed: true, embedded };
      },
    });

  // Skills are a universal agent capability (like the MCP-tools grant): every agent can discover and
  // load reviewed procedures. Not gated by agent.tools; built-ins still win over MCP tools below.
  set.find_skills = tool({
    description: "Search the deck's reusable skills (reviewed procedures for repeatable operations) by what you're trying to do. Returns matching skill names + when to use them; call use_skill to load the full procedure.",
    inputSchema: z.object({ query: z.string(), k: z.number().int().positive().max(20).default(6) }),
    execute: async ({ query, k }) => ({ matches: rankSkills(getActiveSkills(ctx.db), query, k).map((h) => ({ id: h.id, name: h.name, description: h.description })) }),
  });

  set.use_skill = tool({
    description: "Load the full step-by-step procedure for a skill by name, then follow it. Use this for repeatable operations so you do them the reviewed way with fewer mistakes.",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const rows = getActiveSkills(ctx.db);
      const s = rows.find((r) => r.name === name) ?? rows.find((r) => r.id === name);
      return s ? { name: s.name, body: s.body } : { error: `no skill "${name}" — call find_skills to discover available skills` };
    },
  });

  // Every agent gets every connected MCP server's tools (global defaults like Firecrawl + any
  // deck-added server) — no per-agent opt-in for now; gatekeeping can come later. Built-ins already
  // in `set` win (first-wins), so an MCP tool can't shadow a privileged built-in (e.g. a server
  // "create" with a tool "agent" namespacing to create_agent).
  if (mcp)
    for (const [k, v] of Object.entries(mcp.allTools()))
      if (!(k in set)) set[k] = v;

  return set;
}
