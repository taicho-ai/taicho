/** Per-agent toolset. Every tool carries an execute fn so the AI SDK includes tool RESULTS in
 *  response.messages (the manual loop pushes those back). execute closes over the RunContext,
 *  which is how create_agent awaits captain approval and delegate_task spawns child runs. */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import type { AgentDef } from "../schemas/agent";
import type { RunContext } from "./run";
import { artifactPath } from "../store/files";

export function toolsForAgent(agent: AgentDef, ctx: RunContext): ToolSet {
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
        if (decision.type !== "approve") return { rejected: true, reason: decision.type };
        const created = await ctx.createAgent(draft);
        return { created: created.id, role: created.role };
      },
    });

  if (agent.tools.includes("delegate_task"))
    set.delegate_task = tool({
      description: "Delegate a goal to another agent by id and receive its result.",
      inputSchema: z.object({ to: z.string(), goal: z.string(), context: z.string().optional() }),
      execute: async ({ to, goal, context }) => {
        const child = await ctx.runChild({ to, goal, context });
        ctx.delegatedOut.push(child.runId);
        return { from: to, runId: child.runId, result: child.text };
      },
    });

  if (agent.tools.includes("find_agents"))
    set.find_agents = tool({
      description: "Search the squad for agents whose role matches a capability. Returns top matches.",
      inputSchema: z.object({ query: z.string(), k: z.number().int().positive().max(20).default(8) }),
      execute: async ({ query, k }) => ({ matches: ctx.findAgents(query, k) }),
    });

  return set;
}
