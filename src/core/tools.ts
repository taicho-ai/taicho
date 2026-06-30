/** Per-agent toolset. Every tool carries an execute fn so the AI SDK includes tool RESULTS in
 *  response.messages (the manual loop pushes those back). execute closes over the RunContext,
 *  which is how create_agent awaits captain approval and delegate_task spawns child runs. */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import type { AgentDef } from "../schemas/agent";
import type { RunContext } from "./run";
import type { McpManager } from "./mcp/manager";
import { artifactPath } from "../store/files";
import { mergeDraft } from "./draft";

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

  // MCP tools: each agent.tools entry "mcp:<server>" (whole server) or "mcp:<server>/<tool>" (one
  // tool) merges the matching connected MCP tools (namespaced server_tool). Unknown/unconnected → none.
  // Never overwrite an existing key, so an MCP tool can't shadow a privileged built-in (e.g. a server
  // "create" with tool "agent" -> create_agent) or another server's already-merged tool (first wins).
  if (mcp)
    for (const t of agent.tools)
      if (t.startsWith("mcp:"))
        for (const [k, v] of Object.entries(mcp.toolsForRef(t.slice(4))))
          if (!(k in set)) set[k] = v;

  return set;
}
