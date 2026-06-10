import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Workspace file canon. Files are the source of truth; the DB is a cache. */
export const paths = {
  agentDir: (ws: string, id: string) => join(ws, "agents", id),
  agentFile: (ws: string, id: string) => join(ws, "agents", id, "agent.md"),
  policyDir: (ws: string, id: string) => join(ws, "agents", id, "policies"),
  exemplarDir: (ws: string, id: string) => join(ws, "agents", id, "exemplars"),
  artifactDir: (ws: string) => join(ws, "artifacts"),
  runDir: (ws: string, id: string) => join(ws, "runs", id),
};

export async function ensureWorkspace(ws: string) {
  await mkdir(join(ws, "agents"), { recursive: true });
  await mkdir(join(ws, "artifacts"), { recursive: true });
  await mkdir(join(ws, "runs"), { recursive: true });
}

/** Artifacts are immutable: new file per run, never overwrite. */
export function artifactPath(ws: string, topicSlug: string, runId: string) {
  return join(ws, "artifacts", `${topicSlug}-${runId.replace("/", "-")}.md`);
}
