/** A read-only digest of an agent's recent runs, injected into its prompt context so workers
 *  retain continuity across runs (no per-worker conversation thread needed for v1). */
import { listTraces } from "../store/trace";

export function recentRunsDigest(ws: string, agentId: string, k = 5): string | undefined {
  const traces = listTraces(ws, agentId);
  if (!traces.length) return undefined;
  const recent = traces.slice(-k).reverse(); // newest first
  const lines = recent.map(
    (t) => `- ${t.task} → ${t.outcome}${t.artifacts.length ? ` (artifacts: ${t.artifacts.join(", ")})` : ""}`,
  );
  return `## Your recent runs\n${lines.join("\n")}`;
}
