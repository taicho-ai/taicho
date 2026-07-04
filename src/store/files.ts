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
  runRecordDir: (ws: string, runId: string) => {
    const i = runId.indexOf("/");
    if (i < 0) throw new Error("bad run id: " + runId);
    return join(ws, "runs", runId.slice(0, i), runId.slice(i + 1));
  },
  conversationDir: (ws: string, id: string) => join(ws, "conversations", id),
  taskDir: (ws: string) => join(ws, "tasks"),
  scheduleDir: (ws: string) => join(ws, "schedules"),
  kbNodeDir: (ws: string) => join(ws, "kb", "nodes"),
  kbNodeFile: (ws: string, id: string) => join(ws, "kb", "nodes", `${id}.md`),
  kbSourceDir: (ws: string) => join(ws, "kb", "sources"),
  kbSourceFile: (ws: string, name: string) => join(ws, "kb", "sources", name),
  skillsDir: (ws: string) => join(ws, "skills"),
  skillFile: (ws: string, id: string) => join(ws, "skills", `${id}.md`),
};

export async function ensureWorkspace(ws: string) {
  await mkdir(join(ws, "agents"), { recursive: true });
  await mkdir(join(ws, "artifacts"), { recursive: true });
  await mkdir(join(ws, "runs"), { recursive: true });
  await mkdir(join(ws, "conversations"), { recursive: true });
  await mkdir(join(ws, "tasks"), { recursive: true });
  await mkdir(join(ws, "schedules"), { recursive: true });
  await mkdir(join(ws, "kb", "nodes"), { recursive: true });
  await mkdir(join(ws, "kb", "sources"), { recursive: true });
  await mkdir(join(ws, "skills"), { recursive: true });
}
