/** agent.md is canon: YAML frontmatter (the AgentDef minus identity) + markdown body (the SOUL).
 *  Parsed with Bun.YAML (native). The registry table is a derived index of this. */
import { YAML } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
import { AgentDef } from "../schemas/agent";
import { paths } from "./files";

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
- Keep your own replies short. You coordinate; the squad produces artifacts.`;

export async function seedRoot(ws: string): Promise<void> {
  const file = paths.agentFile(ws, "root");
  if (await Bun.file(file).exists()) return;
  const root = AgentDef.parse({
    id: "root",
    role: "Orchestrator — interviews the captain, proposes and coordinates worker agents",
    identity: ROOT_IDENTITY,
    tools: ["create_agent", "delegate_task", "find_agents"],
    canSee: ["*"], canDelegateTo: ["*"], isRoot: true,
    created: new Date().toISOString(),
  });
  await mkdir(paths.agentDir(ws, "root"), { recursive: true });
  await writeFile(file, serializeAgent(root));
}
